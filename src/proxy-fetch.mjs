// A fetch that reaches https:// URLs through an HTTP proxy (CONNECT tunnel), for hubs whose machine has no direct route
// to api2.cursor.sh. Node's own fetch ignores HTTP(S)_PROXY, and the hub gives a plugin a clean environment anyway, so
// the proxy comes from the plugin's configuration. No dependencies: node:http for CONNECT, node:tls over the tunnel,
// node:https for the request, the response body streamed back as a web ReadableStream (the SDK's watch stream reads
// it frame by frame).
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Readable } from 'node:stream'

export function parseProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let u
  try {
    u = new URL(value.trim())
  } catch {
    throw new Error('proxy must be a URL like http://127.0.0.1:8080')
  }
  if (u.protocol !== 'http:') throw new Error('proxy must be an http:// proxy')
  return u
}

function connectTunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${host}:${port}` }
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(cred).toString('base64')
    }
    const req = http.request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      signal,
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT ${host}:${port}: ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.once('error', reject)
    req.end()
  })
}

export function proxyFetch(proxyUrl) {
  const proxy = parseProxy(proxyUrl)
  if (!proxy) return undefined
  return async function fetchViaProxy(input, init = {}) {
    const url = new URL(String(input))
    if (url.protocol !== 'https:') return fetch(input, init)
    const signal = init.signal ?? undefined
    signal?.throwIfAborted()
    const port = Number(url.port) || 443
    const raw = await connectTunnel(proxy, url.hostname, port, signal)
    const socket = tls.connect({ socket: raw, servername: url.hostname, ALPNProtocols: ['http/1.1'] })
    const headers = {}
    new Headers(init.headers ?? {}).forEach((v, k) => {
      headers[k] = v
    })
    let body = init.body
    if (typeof body === 'string') body = Buffer.from(body)
    else if (body instanceof Uint8Array) body = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    else if (body != null) throw new TypeError('proxy fetch: body must be a string or bytes')
    if (body) headers['content-length'] = String(body.length)
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: url.hostname,
          port,
          method: init.method ?? 'GET',
          path: url.pathname + url.search,
          headers,
          // No agent: with one (even agent: false, which makes a fresh Agent) Node opens its own direct connection and
          // ignores createConnection.
          createConnection: () => socket,
          signal,
        },
        (res) => {
          if (init.redirect === 'error' && res.statusCode >= 300 && res.statusCode < 400) {
            res.destroy()
            reject(new TypeError('fetch failed: redirect'))
            return
          }
          const out = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => out.append(k, x))
            else if (v != null) out.set(k, v)
          }
          const noBody = res.statusCode === 204 || res.statusCode === 304 || init.method === 'HEAD'
          resolve(
            new Response(noBody ? null : Readable.toWeb(res), {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: out,
            }),
          )
        },
      )
      req.once('error', (err) => {
        socket.destroy()
        reject(err)
      })
      req.end(body)
    })
  }
}
