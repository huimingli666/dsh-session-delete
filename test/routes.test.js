/**
 * dsh-session-delete — route + trust-fence unit tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { makeRoutes, isLoopbackRequest } from '../src/routes.js'
import { DELETE_PATH, DeleteError } from '../src/delete.js'

function req({ address = '127.0.0.1', host = 'localhost:8080', origin, secFetchSite, method = 'POST' } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  return {
    socket: { remoteAddress: address },
    headers,
    method,
    [Symbol.asyncIterator]() {
      const chunks = []
      let at = 0
      return {
        async next() {
          if (at < chunks.length) return { value: chunks[at++], done: false }
          return { value: undefined, done: true }
        },
      }
    },
  }
}

function jsonReq(body) {
  const r = req()
  r[Symbol.asyncIterator] = () => {
    const chunk = Buffer.from(JSON.stringify(body))
    let done = false
    return {
      next: async () => (done ? { value: undefined, done: true } : ((done = true), { value: chunk, done: false })),
    }
  }
  return r
}

function capture() {
  const responses = []
  const res = new EventEmitter()
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (payload) => { res.body = JSON.parse(payload); responses.push(res) }
  return { res, responses }
}

test('isLoopbackRequest fence accepts loopback and rejects the outside', () => {
  assert.equal(isLoopbackRequest(req()), true)
  assert.equal(isLoopbackRequest(req({ address: '::1' })), true)
  // same-origin browser request (origin must match the Host authority exactly)
  assert.equal(isLoopbackRequest(req({ origin: 'http://localhost:8080' })), true)
  // LAN / public addresses rejected
  assert.equal(isLoopbackRequest(req({ address: '10.0.0.4' })), false)
  assert.equal(isLoopbackRequest(req({ address: '192.168.1.10' })), false)
  // hostile Host header rejected
  assert.equal(isLoopbackRequest(req({ host: 'evil.example.com' })), false)
  // cross-site browser request rejected
  assert.equal(isLoopbackRequest(req({ secFetchSite: 'cross-site' })), false)
  // mismatched origin rejected
  assert.equal(isLoopbackRequest(req({ origin: 'http://other.example.com' })), false)
  // X-Forwarded-For can never launder the address (only remoteAddress counts)
  assert.equal(isLoopbackRequest({ ...req({ address: '10.0.0.4' }), headers: { ...req().headers, 'x-forwarded-for': '127.0.0.1' } }), false)
})

test('POST /delete: happy path surfaces the engine result', async () => {
  const { routes } = makeRoutes({ runDelete: async (sessionId) => ({ ok: true, sessionId, deletedPaths: ['/x'] }) })
  const { res } = capture()
  await routes[0].handler(jsonReq({ sessionId: 'session-1f8a7e13-2afe-4a0d-ba1b-88d6907e990c' }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
})

test('POST /delete: missing body -> 400 bad-request', async () => {
  const { routes } = makeRoutes({ runDelete: async () => ({ ok: true }) })
  const { res } = capture()
  await routes[0].handler(jsonReq({}), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'bad-request')
})

test('POST /delete: engine DeleteError maps to ok:false with its code', async () => {
  const { routes } = makeRoutes({
    runDelete: async () => { throw new DeleteError('running', '会话正在运行中') },
  })
  const { res } = capture()
  await routes[0].handler(jsonReq({ sessionId: 'session-1f8a7e13-2afe-4a0d-ba1b-88d6907e990c' }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'running')
})

test('non-loopback caller gets 403 and the engine never runs', async () => {
  let ran = false
  const { routes } = makeRoutes({ runDelete: async (id) => { ran = true; return { ok: true, id } } })
  const { res } = capture()
  await routes[0].handler({ ...jsonReq({ sessionId: 'x' }), socket: { remoteAddress: '10.0.0.4' }, headers: { ...req().headers, host: '10.0.0.4:8080' } }, res)
  assert.equal(res.status, 403)
  assert.equal(ran, false)
})

test('route path constant is stable', () => {
  assert.equal(DELETE_PATH, '/api/dsh-session-delete/delete')
  assert.equal(routesPath(), DELETE_PATH)
})

function routesPath() {
  return DELETE_PATH
}