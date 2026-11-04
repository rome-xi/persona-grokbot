import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProxy, proxyFetch } from '../src/proxy-fetch.mjs'

// A self-signed TLS server standing in for api2.cursor.sh, and an HTTP CONNECT proxy in front of it.
function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'grokbot-proxy-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return server.address().port
}

test('parseProxy accepts http proxies only', () => {
  assert.equal(parseProxy(''), null)
  assert.equal(parseProxy(undefined), null)
  assert.equal(parseProxy('http://127.0.0.1:8080').port, '8080')
  assert.throws(() => parseProxy('socks5://127.0.0.1:1080'))
  assert.throws(() => parseProxy('not a url'))
})

test('proxyFetch tunnels through CONNECT and streams the response', async (t) => {
  const { key, cert } = selfSigned()
  const upstream = https.createServer({ key, cert }, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/connect+json', 'x-echo-auth': req.headers.authorization ?? '' })
      res.write(JSON.stringify({ method: req.method, path: req.url, body }) + '\n')
      setTimeout(() => res.end('second\n'), 50)
    })
  })
  const upPort = await listen(upstream)
  const connects = []
  const sockets = []
  const proxy = http.createServer((_, res) => res.writeHead(405).end())
  proxy.on('connect', (req, client, head) => {
    connects.push(req.url)
    sockets.push(client)
    const s = net.connect(upPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      s.write(head)
      sockets.push(s)
      s.pipe(client)
      client.pipe(s)
    })
  })
  const proxyPort = await listen(proxy)
  t.after(() => {
    sockets.forEach((x) => x.destroy())
    upstream.closeAllConnections()
    upstream.close()
    proxy.close()
  })

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // the self-signed stand-in only
  t.after(() => delete process.env.NODE_TLS_REJECT_UNAUTHORIZED)
  const f = proxyFetch(`http://127.0.0.1:${proxyPort}`)
  const res = await f(`https://localhost:${upPort}/aiserver.v1.X/Y?a=1`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: '{"x":1}',
    redirect: 'error',
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/connect+json')
  assert.equal(res.headers.get('x-echo-auth'), 'Bearer t')
  const reader = res.body.getReader()
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value).toString())
  }
  const [first, second] = chunks.join('').trim().split('\n')
  assert.deepEqual(JSON.parse(first), { method: 'POST', path: '/aiserver.v1.X/Y?a=1', body: '{"x":1}' })
  assert.equal(second, 'second')
  assert.deepEqual(connects, [`localhost:${upPort}`])
})

test('proxyFetch reports a refused CONNECT', async (t) => {
  const proxy = http.createServer()
  proxy.on('connect', (_, client) => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  const port = await listen(proxy)
  t.after(() => proxy.close())
  await assert.rejects(proxyFetch(`http://127.0.0.1:${port}`)('https://example.invalid/'), /403/)
})
