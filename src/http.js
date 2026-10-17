/**
 * HTTP plumbing shared by every expert-hub route.
 *
 * One implementation of the security baseline: loopback-only, same-origin
 * mutations, JSON `no-store` responses, a hard body cap, and a stable error
 * envelope the client can localize.
 *
 * @module dsh-expert-hub/http
 */

/** The one error type routes throw; `status`/`code` reach the client verbatim. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** True for the local host socket addresses only. */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress
  if (address === undefined) return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

/**
 * Same-origin mutation check. A missing Origin is allowed (the Desktop shell
 * strips it); a present Origin must match the Host header.
 */
export function isSameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Write one JSON response; always `no-store`. */
export function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Write the failure envelope. */
export function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message: message ?? code } })
}

/** Read and JSON-parse a request body, refusing anything over `cap` bytes. */
export function readJsonBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cap) {
        fail(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => fail(error))
  })
}

/** Reject anything that is not a same-origin POST with a JSON body. */
export function assertMutation(req) {
  if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST')
  if (!isSameOrigin(req)) throw new HttpError(403, 'CROSS_ORIGIN', '拒绝跨站请求')
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'INVALID_CONTENT_TYPE', '请求体必须是 application/json')
  }
}

/** Guard the whole route prefix against non-loopback callers. */
export function assertLoopback(req) {
  if (!isLoopback(req)) throw new HttpError(403, 'NOT_LOOPBACK', '仅允许本机访问')
}

/** One SSE stream with automatic frame framing and heartbeat-friendly dispose. */
export function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
  let closed = false
  res.on('close', () => {
    closed = true
  })
  return {
    get closed() {
      return closed
    },
    frame(event, data) {
      if (closed || res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    comment(text) {
      if (closed || res.writableEnded) return
      res.write(`: ${text}\n\n`)
    },
    end() {
      if (closed) return
      closed = true
      try {
        res.end()
      } catch {
        // half-closed socket
      }
    },
  }
}

/** Parse `?a=b` without trusting the shape. */
export function queryOf(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return url.searchParams
  } catch {
    return new URLSearchParams()
  }
}
