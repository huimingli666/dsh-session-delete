/**
 * dsh-session-delete — the loopback-only HTTP face.
 *
 * One route family under /api/dsh-session-delete:
 *   POST /delete  { sessionId } → { ok, sessionId, attached, detachedFrom,
 *                                  archivedCleared, deletedPaths }
 *
 * The route is behind the same request-level trust fence DSH host plugins
 * use: loopback socket + loopback Host + browser same-origin markers.
 * X-Forwarded-For is never trusted. Responses carry no session content.
 */
import { DELETE_PATH, deleteSession, DeleteError } from './delete.js'

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether the socket address names the loopback range (127/8, ::1, mapped). */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized hostname names a loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: loopback socket + loopback Host + browser
 * same-origin markers. X-Forwarded-For is never trusted.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Cap on JSON request bodies (a session id is tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** Route family dependencies. */
export function makeRoutes({ runDelete = deleteSession }) {
  return {
    routes: [{
      kind: 'exact',
      path: DELETE_PATH,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined || typeof body.sessionId !== 'string') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '缺少有效的 sessionId' })
          return
        }
        try {
          const result = await runDelete(body.sessionId)
          writeJson(res, 200, result)
        } catch (error) {
          if (error instanceof DeleteError) {
            writeJson(res, 200, {
              ok: false,
              code: error.code,
              message: error.message,
              sessionId: body.sessionId,
            })
            return
          }
          writeJson(res, 200, {
            ok: false,
            code: 'internal',
            message: `删除失败：${error instanceof Error ? error.message : String(error)}`,
            sessionId: body.sessionId,
          })
        }
      },
    }],
  }
}