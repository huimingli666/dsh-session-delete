/**
 * dsh-session-delete — host half.
 *
 * Mounts the loopback-only route POST /api/dsh-session-delete/delete, wires
 * the delete engine to the live host services, installs the one-off
 * registry archive-set cleanup patch, and announces the capability to the
 * model. The browser half (./client) renders the danger action in the
 * conversation header. Everything rides official dsh host services — no dsh
 * source changes.
 */
import { makeRoutes } from './routes.js'
import { deleteSession } from './delete.js'
import { installUnarchiveOnInstance, unarchiveFor } from './unarchive.js'

/** Stable cordis plugin name. */
export const name = 'session-delete'

/** Services required before the routes can mount and before the model
 * announcement can register. `systemPrompt` must be declared here too —
 * cordis' inject guard forbids touching ctx.systemPrompt otherwise. */
export const inject = ['webServer', 'systemPrompt']

/* -------------------------------------------------------------- guard */

/** Keep the package from being applied twice in one process (bundle row +
 * plugin-add row / HMR reload can otherwise load it twice and re-register
 * the same routes, failing the boot). Mirrors the dsh-web-ui family idiom. */
const MOUNTED = Symbol.for('dsh-web-ui.mounted-plugins')
function mountedSet() {
  const registry = globalThis
  return (registry[MOUNTED] ??= new Set())
}
function mountOnce(packageName, fn) {
  return (...args) => {
    const mounted = mountedSet()
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    const ctx = args[0]
    ctx?.effect?.(() => () => { mounted.delete(packageName) })
    return fn(...args)
  }
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 191

/** JSON schema wording stays minimal — everything is route-driven. */
export const Config = undefined

/** Defaults merged over the composition entry (if any). */
export const defaultConfig = Object.freeze({
  enabled: true,
  announceToAgent: true,
})

/** Model-facing announcement: plugin presence, capability, and limits. */
export const DELETE_GUIDANCE = '本机已安装 dsh-session-delete 插件（会话删除）：dsh 交互界面原本只支持会话重命名、分叉、归档；该插件在打开会话的头部操作区提供「删除会话」入口，可彻底删除一个会话——包括其工作区挂账、归档集合条目、内存会话记录与磁盘上的事件日志文件（~/.dsh/sessions 下对应目录）。安全约束：正在运行（挂有 agent 循环）的会话拒绝删除；删除为不可恢复操作，界面会弹出二次确认。路由：POST /api/dsh-session-delete/delete（loopback-only）。用户提到「删除会话 / 会话删除 / delete session」时即指本插件。'

/** Logger without inject-guard surprises: ctx.logger is a cordis accessor,
 * not a mixin — resolve defensively and fall back to console. */
function safeLogger(ctx) {
  try {
    return ctx.logger ?? console
  } catch {
    return console
  }
}

/**
 * Mount the route and engine wiring.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context (webServer injected).
 * @param {object} [config] - composition-entry config (enabled/announceToAgent).
 */
export const apply = mountOnce('@dsh-plugins/dsh-session-delete', applyImpl)

function applyImpl(ctx, config = {}) {
  const resolved = { ...defaultConfig, ...(config ?? {}) }

  // Archive-set cleanup patch is installed lazily inside runDelete (the
  // workspace domain service is not ready at apply time).

  let disposeRoutes
  let disposeSection
  const disposeAll = () => {
    if (disposeRoutes) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeSection) { disposeSection(); disposeSection = undefined }
  }

  const sync = () => {
    disposeAll()
    if (resolved.enabled === false) return

    // Minimal host face for the delete engine, resolved lazily from the
    // live cordis context so absent optional services degrade per-part
    // (ctx.get returns undefined when a service is not composed). The
    // archive-set patch is installed on FIRST delete — at apply time the
    // workspace domain service may not be ready yet, so patching eagerly
    // would silently fail. Installation is idempotent.
    let unarchiveReady = false
    const ensureUnarchive = () => {
      if (unarchiveReady) return
      unarchiveReady = installUnarchiveOnInstance(ctx.get('workspaceRegistry'), safeLogger(ctx))
    }
    const runDelete = async (sessionId) => {
      ensureUnarchive()
      const registry = ctx.get('workspaceRegistry')
      const host = {
        sessions: ctx.get('sessions'),
        agents: ctx.get('agents'),
        workspaceRegistry: registry,
        sessionPersistence: ctx.get('sessionPersistence'),
        unarchiveSession: unarchiveFor(registry),
        parallel: (...args) => ctx.parallel(...args),
        logger: safeLogger(ctx),
      }
      return deleteSession(host, sessionId)
    }

    try {
      const { routes } = makeRoutes({ runDelete })
      disposeRoutes = ctx.effect(
        () => {
          const disposers = routes.map((route) => ctx.webServer.register(route))
          return () => { for (const dispose of disposers) dispose() }
        },
        'dsh-session-delete: routes',
      )
    } catch (error) {
      // Fail-degrade: a route-registration problem must log loudly but never
      // take the host boot down.
      console.error('[dsh-session-delete] route registration failed:', error)
    }

    if (resolved.announceToAgent !== false) {
      try {
        disposeSection = ctx.systemPrompt.section({
          name: 'plugin:dsh-session-delete',
          order: SECTION_ORDER,
          text: DELETE_GUIDANCE,
        })
      } catch (error) {
        console.error('[dsh-session-delete] announcement section failed:', error)
      }
    }
  }

  // Fiber teardown (host reload / unmount) unregisters everything.
  ctx.effect(() => disposeAll, 'dsh-session-delete: teardown')
  sync()
}