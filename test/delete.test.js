/**
 * dsh-session-delete — delete-engine unit tests.
 * Runs the full pipeline against a mocked host face + a real temp session
 * root, asserting every side effect (accounting, archive set, fs, store,
 * broadcast).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteSession, DeleteError, isSessionId } from '../src/delete.js'

const ID = 'session-1f8a7e13-2afe-4a0d-ba1b-88d6907e990c'

function noopLogger() {
  const warnings = []
  return { warnings, warn: (...args) => warnings.push(args.join(' ')) }
}

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
}

function makeSession(id = ID) {
  return {
    id,
    header: { version: 0, id, cwd: '/tmp/proj', createdAt: Date.now(), delegationDepth: 0 },
    flushed: false,
  }
}

/** Build a hot-rod host face; every knob is a plain override-able object. */
function makeHost(overrides = {}) {
  const root = overrides.root
  const logger = noopLogger()
  // `noSession: true` builds a host with an EMPTY live store (cold mode).
  const session = overrides.noSession ? undefined : (overrides.session ?? makeSession())
  const store = new Map(session === undefined ? [] : [[session.id, session]])
  const snapshots = overrides.snapshots ?? []
  const ws = overrides.workspace ?? {
    id: 'workspace-w1',
    sessionIds: [session?.id ?? ID, 'session-oooooooo-0000-4000-8000-000000000000'],
    detachCalls: [],
    async detachSession(sid) {
      this.detachCalls.push(sid)
      this.sessionIds = this.sessionIds.filter((x) => x !== sid)
    },
  }
  const unarchiveCalls = []
  const events = []
  const host = {
    root,
    logger,
    sessions: {
      store,
      get: (id) => store.get(id),
      list: () => [...store.values()],
      async flush(s) { s.flushed = true; return true },
    },
    agents: {
      get: () => {
        if (overrides.agent !== undefined) return overrides.agent
        return overrides.running ? { id: session.id, status: 'running' } : undefined
      },
    },
    workspaceRegistry: {
      list: () => overrides.noWorkspaces ? [] : [ws],
    },
    sessionPersistence: {
      async listSnapshots() { return snapshots },
      locate: overrides.locate ?? ((meta) => ({
        kind: 'jsonl',
        path: join(root, '--proj--', meta.id, 'session.jsonl.zstd'),
      })),
    },
    unarchiveSession: overrides.noUnarchive
      ? undefined
      : async (sid) => { unarchiveCalls.push(sid) },
    parallel: (name, arg) => { events.push([name, arg]) },
  }
  return {
    host,
    session,
    ws,
    unarchiveCalls,
    events,
    logger,
    async cleanup() { await rm(root, { recursive: true, force: true }) },
  }
}

async function seedSessionDir(root, id = ID) {
  const dir = join(root, '--proj--', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl.zstd'), '{}\n')
  return dir
}

test('isSessionId accepts real uuids and rejects junk', () => {
  assert.equal(isSessionId(ID), true)
  assert.equal(isSessionId('session-abc'), false)
  assert.equal(isSessionId('../etc/passwd'), false)
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId(42), false)
})

test('attached session: full pipeline deletes everywhere', async () => {
  const root = await makeRoot()
  const fixture = makeHost({ root })
  const dir = await seedSessionDir(root)
  try {
    const result = await deleteSession(fixture.host, ID)
    assert.equal(result.ok, true)
    assert.equal(result.attached, true)
    assert.equal(result.detachedFrom, 'workspace-w1')
    assert.equal(result.archivedCleared, true)
    assert.ok(result.deletedPaths.includes(dir), `deletedPaths=${result.deletedPaths}`)
    // fs: the session dir is gone
    assert.equal((await readdir(join(root, '--proj--')).catch(() => [])).length, 0)
    // memory: the store row is gone
    assert.equal(fixture.host.sessions.store.has(ID), false)
    // flush happened before removal
    assert.equal(fixture.session.flushed, true)
    // broadcast relayed
    assert.deepEqual(fixture.events, [['session/disposed', fixture.session]])
    // accounting + archive calls
    assert.deepEqual(fixture.ws.detachCalls, [ID])
    assert.deepEqual(fixture.unarchiveCalls, [ID])
  } finally {
    await fixture.cleanup()
  }
})

test('running session is refused and nothing is touched', async () => {
  const root = await makeRoot()
  const fixture = makeHost({ root, running: true })
  const dir = await seedSessionDir(root)
  try {
    await assert.rejects(
      () => deleteSession(fixture.host, ID),
      (error) => error instanceof DeleteError && error.code === 'running',
    )
    assert.equal(fixture.host.sessions.store.has(ID), true)
    assert.deepEqual(fixture.ws.detachCalls, [])
    assert.deepEqual(fixture.unarchiveCalls, [])
    assert.deepEqual(fixture.events, [])
    assert.equal((await readdir(dir)).length > 0, true)
  } finally {
    await fixture.cleanup()
  }
})

test('idle resident agent: allowed, inbox cancelled, then deleted', async () => {
  const root = await makeRoot()
  const cancelled = []
  const fixture = makeHost({
    root,
    agent: { id: ID, status: 'idle', cancelled: 0, cancel(reason, opts) { this.cancelled++; cancelled.push([reason, opts]) } },
  })
  const dir = await seedSessionDir(root)
  try {
    const result = await deleteSession(fixture.host, ID)
    assert.equal(result.ok, true)
    assert.equal(result.attached, true)
    assert.deepEqual(cancelled, [['session deleted', { keepInbox: false }]])
    assert.equal(fixture.host.sessions.store.has(ID), false)
    assert.ok(result.deletedPaths.includes(dir))
  } finally {
    await fixture.cleanup()
  }
})

test('agent with unknown status fails closed (refused)', async () => {
  const root = await makeRoot()
  const fixture = makeHost({ root, agent: { id: ID } })
  const dir = await seedSessionDir(root)
  try {
    await assert.rejects(
      () => deleteSession(fixture.host, ID),
      (error) => error instanceof DeleteError && error.code === 'running',
    )
    assert.equal(fixture.host.sessions.store.has(ID), true)
    assert.equal((await readdir(dir)).length > 0, true)
  } finally {
    await fixture.cleanup()
  }
})

test('bad session id is rejected up front', async () => {
  const root = await makeRoot()
  const fixture = makeHost({ root })
  try {
    await assert.rejects(
      () => deleteSession(fixture.host, 'garbage'),
      (error) => error instanceof DeleteError && error.code === 'bad-request',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('unknown session is not-found', async () => {
  const root = await makeRoot()
  const fixture = makeHost({ root, snapshots: [], noSession: true })
  try {
    await assert.rejects(
      () => deleteSession(fixture.host, ID),
      (error) => error instanceof DeleteError && error.code === 'not-found',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('cold session (no live store): found via persistence and deleted', async () => {
  const root = await makeRoot()
  const cold = makeSession(ID)
  const fixture = makeHost({
    root,
    noSession: true,
    snapshots: [{ header: cold.header }],
  })
  const dir = await seedSessionDir(root)
  try {
    const result = await deleteSession(fixture.host, ID)
    assert.equal(result.ok, true)
    assert.equal(result.attached, false)
    assert.equal(result.detachedFrom, 'workspace-w1')
    assert.ok(result.deletedPaths.includes(dir))
    assert.deepEqual(fixture.events, [])
    assert.equal(fixture.host.sessions.store.has(ID), false)
  } finally {
    await fixture.cleanup()
  }
})

test('locate() broken: fallback scan still removes the session dir', async () => {
  const root = await makeRoot()
  const cold = makeSession(ID)
  const fixture = makeHost({
    root,
    noSession: true,
    snapshots: [{ header: cold.header }],
    locate: () => { throw new Error('backend locate unavailable') },
  })
  const dir = await seedSessionDir(root)
  try {
    const result = await deleteSession(fixture.host, ID)
    assert.equal(result.ok, true)
    assert.ok(result.deletedPaths.includes(dir), `deletedPaths=${result.deletedPaths}`)
    assert.equal((await readdir(dir).catch(() => [])).length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('no workspace + no unarchiver: delete still succeeds (best effort parts)', async () => {
  const root = await makeRoot()
  const fixture = makeHost({ root, noWorkspaces: true, noUnarchive: true })
  const dir = await seedSessionDir(root)
  try {
    const result = await deleteSession(fixture.host, ID)
    assert.equal(result.ok, true)
    assert.equal(result.detachedFrom, null)
    assert.equal(result.archivedCleared, false)
    assert.ok(result.deletedPaths.includes(dir))
  } finally {
    await fixture.cleanup()
  }
})