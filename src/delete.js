/**
 * dsh-session-delete — host-side delete engine.
 *
 * `deleteSession()` performs a TRUE session deletion in one durable pipeline:
 *
 *   1. guards      — well-formed id, known session, not running
 *   2. accounting  — detach from its workspace's sessionIds list (public
 *                    WorkspaceEntity.detachSession, which persists through
 *                    the workspace domain table and fires the regular
 *                    host/workspace-changed broadcast)
 *   3. archive set — remove the id from the registry-global archive list (an
 *                    otherwise-unremovable slot; see src/unarchive.js)
 *   4. durable log — flush pending events, then remove the backend artifact
 *                    (locate() → dirname), plus a resilient scan of the
 *                    session root for `session-<id>` leftovers
 *   5. memory      — drop the in-memory SessionStore row and broadcast
 *                    `session/disposed` so the GUI removes the row through
 *                    the standard host/session-removed relay
 *
 * The engine is written against a minimal `host` face (injected by
 * src/index.js) so the whole pipeline is unit-testable with plain mocks.
 */
import { rm, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** A session id is `session-<uuid>` — anything else is rejected outright. */
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/** The one delete route this plugin serves. */
export const DELETE_PATH = '/api/dsh-session-delete/delete'

/** Typed failure of the delete pipeline; `code` maps to a client message. */
export class DeleteError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DeleteError'
    this.code = code
    this.details = details
  }
}

/* ------------------------------------------------------------- helpers */

/** Resolve the session root directory (~/.dsh/sessions by convention). */
export function sessionRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

/**
 * Locate every on-disk artifact belonging to `id` under `root`. The primary
 * answer comes from the persistence backend's `locate()` (exact); the scan
 * is a resilient fallback for backends without per-session artifacts or for
 * media left by a previous backend/encoding. `session-<uuid>` ids encode to
 * themselves, so exact-name matching is safe.
 */
export async function artifactPaths(host, header, id, root = sessionRoot()) {
  const paths = new Set()
  try {
    const located = host.sessionPersistence?.locate?.(header)
    if (located?.path !== undefined) paths.add(dirname(located.path))
  } catch (error) {
    host.logger?.warn?.(`[dsh-session-delete] locate() failed for ${id}: ${String(error)}`)
  }
  // Resilient scan: project dirs live one level under the root; sweep their
  // children for the exact session name. Also tolerate a file directly.
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      const direct = join(root, entry.name)
      if (entry.name === id) paths.add(direct)
      if (!entry.isDirectory()) continue
      let children = []
      try {
        children = await readdir(direct, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (child.name === id) paths.add(join(direct, child.name))
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') host.logger?.warn?.(`[dsh-session-delete] session-root scan failed: ${String(error)}`)
  }
  return [...paths]
}

/* ------------------------------------------------------------- engine */

/**
 * Delete one session end to end.
 *
 * @param host - minimal host face:
 *   - `sessions`: SessionStore-ish { get(id), list(), flush(session), store: Map }
 *   - `agents`:  agent registry-ish { get(id) } (undefined → treated as absent)
 *   - `workspaceRegistry`: { list() -> [{ id, sessionIds, detachSession() }] }
 *   - `sessionPersistence`: { inspect(id) / listSnapshots() or list(), locate(meta) }
 *   - `unarchiveSession(sessionId)`: registry-global archive-set removal
 *   - `parallel(name, ...args)`: cordis event dispatch
 *   - `logger`, `root` (session root override for tests)
 * @param sessionId - the session to delete.
 * @returns result summary.
 * @throws {DeleteError} bad-request / not-found / running / internal.
 */
export async function deleteSession(host, sessionId) {
  if (!isSessionId(sessionId)) {
    throw new DeleteError('bad-request', `非法会话 ID："${sessionId}"（应为 session-<uuid>）`, { sessionId })
  }
  const sessions = host.sessions
  const attached = sessions?.get?.(sessionId) ?? undefined

  // 1. Running guard — a live, ACTIVE agent loop may be mid-write; refuse
  //    outright. An agent that is merely resident (idle phase, waiting for
  //    its next turn) is safe to delete: we cancel its inbox first so no
  //    queued input can resurrect writes afterwards. An agent whose status
  //    cannot be read is treated as active (fail closed).
  const agent = host.agents?.get?.(sessionId)
  if (agent !== undefined) {
    if (agent.status === 'running' || agent.status === undefined) {
      throw new DeleteError('running', '会话正在运行中（或等待审批/回复），无法删除。请先结束或取消当前任务后再试。', { sessionId })
    }
    try {
      agent.cancel?.('session deleted', { keepInbox: false })
    } catch (error) {
      host.logger?.warn?.(`[dsh-session-delete] idle-agent cancel failed for ${sessionId}: ${String(error)}`)
    }
  }

  // 2. Known check — live store row or durable persistence listing.
  let header = attached?.header
  let known = header !== undefined
  if (!known) {
    try {
      const snapshots = await host.sessionPersistence?.listSnapshots?.()
      const snapshot = snapshots?.find((entry) => entry.header?.id === sessionId)
      header = snapshot?.header
      known = header !== undefined
    } catch (error) {
      throw new DeleteError('internal', `读取会话清单失败：${String(error)}`, { cause: error })
    }
  }
  if (!known) {
    throw new DeleteError('not-found', `找不到会话 ${sessionId}`, { sessionId })
  }

  const summary = {
    ok: true,
    sessionId,
    attached: attached !== undefined,
    detachedFrom: null,
    archivedCleared: false,
    deletedPaths: [],
  }

  // 3. Workspace accounting — detach from its owning workspace, if any.
  try {
    for (const workspace of host.workspaceRegistry?.list?.() ?? []) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      await workspace.detachSession(sessionId)
      summary.detachedFrom = workspace.id
      break
    }
  } catch (error) {
    host.logger?.warn?.(`[dsh-session-delete] detach from workspace failed for ${sessionId}: ${String(error)}`)
  }

  // 4. Registry-global archive set — remove the id (best-effort; an
  //    unimplemented unarchive never fails the delete).
  if (typeof host.unarchiveSession === 'function') {
    try {
      await host.unarchiveSession(sessionId)
      summary.archivedCleared = true
    } catch (error) {
      host.logger?.warn?.(`[dsh-session-delete] archive-set cleanup failed for ${sessionId}: ${String(error)}`)
    }
  }

  // 5. Durable event log — flush pending events first (idempotent), then
  //    remove the artifacts and any leftovers.
  if (attached !== undefined && typeof sessions.flush === 'function') {
    try {
      await sessions.flush(attached)
    } catch (error) {
      host.logger?.warn?.(`[dsh-session-delete] flush before delete failed for ${sessionId}: ${String(error)}`)
    }
  }
  const paths = await artifactPaths(host, header, sessionId, host.root)
  for (const path of paths) {
    try {
      await rm(path, { recursive: true, force: true })
      summary.deletedPaths.push(path)
    } catch (error) {
      host.logger?.warn?.(`[dsh-session-delete] removal failed for ${path}: ${String(error)}`)
    }
  }

  // 6. In-memory store — drop the live row and relay the removal so the GUI
  //    drops the session immediately through host/session-removed.
  if (attached !== undefined) {
    try {
      if (sessions.store instanceof Map) sessions.store.delete(sessionId)
    } catch (error) {
      host.logger?.warn?.(`[dsh-session-delete] store removal failed for ${sessionId}: ${String(error)}`)
    }
    try {
      host.parallel?.('session/disposed', attached)
    } catch (error) {
      host.logger?.warn?.(`[dsh-session-delete] disposal broadcast failed for ${sessionId}: ${String(error)}`)
    }
  }

  return summary
}