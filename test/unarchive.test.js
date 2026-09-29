/**
 * dsh-session-delete — archive-set cleanup patch unit tests.
 * Exercises the one-off prototype extension against a fake registry instance
 * (the real @deepseek-ai/dsh-workspace class is intentionally never imported:
 * the plugin lives outside dsh's dependency tree, so the patch reaches the
 * class through a live instance's prototype instead of module resolution).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installUnarchiveOnInstance, unarchiveFor } from '../src/unarchive.js'

/** Minimal registry-shaped instance using the same public machinery. */
function makeRegistry(state0 = { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['a', 'b'] }) {
  let state = state0
  let chain = Promise.resolve()
  class FakeRegistry {
    requireState() { return state }
    async setState(next) { state = next }
    enqueueOperation(operation) {
      const result = chain.then(() => operation())
      chain = result.then(() => {}, () => {})
      return result
    }
  }
  return { instance: new FakeRegistry(), get state() { return state } }
}

test('patch installs on the instance prototype and unarchiveSession filters the set', async () => {
  const fixture = makeRegistry()
  assert.equal(installUnarchiveOnInstance(fixture.instance), true)
  assert.equal(installUnarchiveOnInstance(fixture.instance), true) // idempotent
  const fn = unarchiveFor(fixture.instance)
  assert.equal(typeof fn, 'function')
  await fn('a')
  assert.deepEqual(fixture.state.archivedSessionIds, ['b'])
  // unknown id: no-op, no corruption
  await fn('nope')
  assert.deepEqual(fixture.state.archivedSessionIds, ['b'])
})

test('patch serializes through the registry write chain', async () => {
  const fixture = makeRegistry({ initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['a', 'b'] })
  installUnarchiveOnInstance(fixture.instance)
  const fn = unarchiveFor(fixture.instance)
  await Promise.all([fn('a'), fn('b')])
  assert.deepEqual(fixture.state.archivedSessionIds, [])
  assert.deepEqual(fixture.state.workspaceIds, ['w1'])
})

test('missing or non-registry values degrade to false without polluting prototypes', () => {
  const warnings = []
  const logger = { warn: (...args) => warnings.push(args.join(' ')) }
  assert.equal(installUnarchiveOnInstance(undefined, logger), false)
  assert.equal(installUnarchiveOnInstance(null, logger), false)
  // A plain object is NOT a registry — must refuse (and never patch
  // Object.prototype).
  assert.equal(Object.prototype.unarchiveSession, undefined)
  assert.equal(installUnarchiveOnInstance({}, logger), false)
  assert.equal(Object.prototype.unarchiveSession, undefined)
  assert.ok(warnings.length >= 3)
})

test('unarchiveFor returns undefined without a patch', () => {
  assert.equal(unarchiveFor(undefined), undefined)
  assert.equal(unarchiveFor({}), undefined)
})