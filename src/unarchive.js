/**
 * dsh-session-delete — registry archive-set cleanup.
 *
 * The workspaces domain exposes no way to REMOVE a session from the
 * registry-global `archivedSessionIds` set (archive is one-way in the
 * current dsh build; even the GUI offers no unarchive). Deleting a session
 * without cleaning this set would leave a ghost id for the lifetime of the
 * registry (harmless at render time, but a dirty durable artifact).
 *
 * Instead of forking dsh, this module extends the SHIPPED registry class
 * with one method implemented entirely through the class's OWN public
 * machinery (enqueueOperation / requireState / setState), so it stays on the
 * registry's write chain and durability path. The prototype is reached from
 * a live registry INSTANCE (`Object.getPrototypeOf`), which sidesteps module
 * resolution entirely: the plugin lives outside dsh's dependency tree, so
 * `import('@deepseek-ai/dsh-workspace')` cannot be relied on. Patching the
 * shared prototype installs the method for every registry instance at once
 * and is idempotent. Failure degrades to a warning — the rest of the delete
 * pipeline must not depend on it.
 */
/**
 * Install the archive-set cleanup method on the registry instance's class.
 * @param {object} registry - live WorkspaceRegistry instance from the host ctx.
 * @param {object} [logger] - warn-capable logger.
 * @returns true when the class is (now or already) patch-capable.
 */
export function installUnarchiveOnInstance(registry, logger = console) {
  if (registry === undefined || registry === null || typeof registry !== 'object') {
    logger.warn?.('[dsh-session-delete] workspace registry unavailable; archive-set cleanup disabled')
    return false
  }
  // Registry shape check — never patch an arbitrary object's prototype
  // (a `{}` prototype is Object.prototype; installing there would pollute
  // every object in the process).
  if (typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function') {
    logger.warn?.('[dsh-session-delete] context member is not a workspace registry; archive-set cleanup disabled')
    return false
  }
  const proto = Object.getPrototypeOf(registry)
  if (proto === null || proto === undefined || proto === Object.prototype) {
    // A literal-object "registry" would patch Object.prototype itself —
    // refuse rather than pollute every object in the process.
    logger.warn?.('[dsh-session-delete] workspace registry prototype unavailable; archive-set cleanup disabled')
    return false
  }
  if (typeof proto.unarchiveSession !== 'function') {
    Object.defineProperty(proto, 'unarchiveSession', {
      configurable: true,
      writable: true,
      value: async function unarchiveSession(sessionId) {
        return this.enqueueOperation(async () => {
          const state = this.requireState()
          if (!state.archivedSessionIds.includes(sessionId)) return
          await this.setState({
            ...state,
            archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
          })
        })
      },
    })
  }
  return true
}

/** Resolve the unarchiver for a given registry instance (or undefined). */
export function unarchiveFor(registry) {
  if (registry === undefined || registry === null) return undefined
  const fn = registry.unarchiveSession
  return typeof fn === 'function' ? fn.bind(registry) : undefined
}