import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { credentials, DEFAULT_HUB_URL, hubBase, summarize } from '../src/assistant.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('hub base: the setting, a loopback hub address, else the default port', () => {
  assert.throws(() => hubBase({ hub_url: 'https://example.com' }, {}), /hub_url/)
  assert.equal(hubBase({}, { url: 'http://127.0.0.1:18661' }), 'http://127.0.0.1:18661')
  assert.equal(hubBase({}, { url: 'http://hub.persona.internal' }), DEFAULT_HUB_URL, 'a sandbox name is not the node’s')
  for (const hub_url of ['ftp://x', 'http://user@127.0.0.1', 'http://127.0.0.1/x', 'http://127.0.0.1?q=x']) assert.throws(() => hubBase({ hub_url }, {}), /hub_url/)
  assert.equal(hubBase(undefined, undefined), DEFAULT_HUB_URL)
})

test('credentials: the agents API under the base and the token, or a reason', () => {
  assert.deepEqual(credentials('http://127.0.0.1:18660', 'pext_x'), {
    env: { GROKBOT_API: 'http://127.0.0.1:18660/api/v1/agents', GROKBOT_TOKEN: 'pext_x' },
  })
  assert.throws(() => credentials('http://127.0.0.1:18660', ''), (e) => e.code === 'conflict')
})

test('summary: session ids become Bot names, typed or encoded, side sessions intact', () => {
  const sessions = [
    { sessionKey: 'bot1/', title: 'X' },
    { sessionKey: 'bot1/side-1', title: 'X 支线' },
    { sessionKey: 'bot2/', title: '' },
  ]
  const card = '以你的身份在Grok Bot上发消息\nPOST /sessions/grokbot:bot1//messages\n—\nPOST /sessions/grokbot:bot1/side-1/messages\nPOST /sessions/grokbot%3Abot2%2F/messages'
  assert.equal(
    summarize(card, sessions),
    '以你的身份在Grok Bot上发消息\nPOST /sessions/「X」/messages\n—\nPOST /sessions/「X 支线」/messages\nPOST /sessions/「Grok Bot」/messages',
  )
  assert.equal(summarize('nothing to name', []), 'nothing to name')
  assert.equal(summarize('{\"text\":\"grokbot:bot1/\"}', sessions), '{\"text\":\"grokbot:bot1/\"}')
})

// grok.sh against a stand-in for the gate proxy: what reaches it, as it reaches it.
async function proxy(status = 200, reply = '{"ok":true}') {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'] ?? '', auth: req.headers.authorization ?? '', body })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(reply)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { seen, base: `http://127.0.0.1:${server.address().port}/k3y`, close: () => server.close() }
}

function grok(args, env) {
  return new Promise((resolve) => {
    const p = spawn('bash', [join(root, 'skills/grok-bot/scripts/grok.sh'), ...args], { env: { PATH: process.env.PATH, ...env } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

test('grok: restricted source, stable UUID, unchanged Unicode body and encoded paths', async () => {
  const px = await proxy()
  const body = JSON.stringify({clientId:'11111111-2222-3333-4444-555555555555',text:"第一行\n第二行 it's"})
  try {
    const env = {GROKBOT_API:px.base}
    for (const args of [
      ['GET','/sessions'],
      ['GET','/sessions/grokbot:bot1//messages?limit=20&cursor=905'],
      ['POST','/sessions/grokbot:bot1/side-1/messages',body],
      ['POST','/sessions/grokbot:bot1//read'],
    ]) assert.equal((await grok(args,env)).code,0)
    assert.deepEqual(px.seen.map(r=>r.url), [
      '/k3y/sessions?source=grokbot&provider=grok_bot',
      '/k3y/sessions/grokbot%3Abot1%2F/messages?limit=20&cursor=905',
      '/k3y/sessions/grokbot%3Abot1%2Fside-1/messages',
      '/k3y/sessions/grokbot%3Abot1%2F/read',
    ])
    assert.equal(px.seen[2].body,body)
    assert.ok(px.seen.every(r=>r.auth===''))
    const before=px.seen.length
    for (const args of [
      ['GET','/sessions?source=other'],
      ['GET','/sessions/other:bot1//messages'],
      ['POST','/sessions/grokbot:bot1//messages','{"text":"hi"}'],
      ['POST','/sessions/grokbot:bot1//messages',body.replace('11111111-2222-3333-4444-555555555555','bad')],
      ['POST','/sessions/grokbot:bot1//messages',body.replace('第一行','$100')],
      ['POST','/sessions/grokbot:bot1//messages',JSON.stringify({clientId:'11111111-2222-3333-4444-555555555555',text:'x'.repeat(2000)})],
      ['POST','/sessions/grokbot:bot1//messages','@file.json'],
      ['GET','/sessions','--location'],
    ]) assert.notEqual((await grok(args,env)).code,0,JSON.stringify(args))
    assert.equal(px.seen.length,before,'invalid requests never leave the script')
  } finally {px.close()}
})

test('grok: an API error fails the command with its body; no proxy, exit 3', async () => {
  const px = await proxy(403, '{"error":"needs the phone"}')
  try {
    const r = await grok(['POST', '/sessions/grokbot:bot1//messages', '{"clientId":"11111111-2222-3333-4444-555555555555","text":"hi"}'], { GROKBOT_API: px.base })
    assert.notEqual(r.code, 0)
    assert.match(r.out, /needs the phone/)
  } finally {
    px.close()
  }
  const none = await grok(['GET', '/sessions'], {})
  assert.equal(none.code, 3)
  assert.match(none.err, /Grok Bot/)
})

test('plugin: assistant.credentials and assistant.summary over the protocol', async () => {
  const p = spawn(process.execPath, [join(root, 'src/main.mjs')], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: p.stdout })
  const answers = new Map()
  const waiting = new Map()
  lines.on('line', (l) => {
    const m = JSON.parse(l)
    if (waiting.has(m.id)) waiting.get(m.id)(m)
    else answers.set(m.id, m)
  })
  let n = 0
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = `t${++n}`
      waiting.set(id, resolve)
      p.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  try {
    // no Grok Bot login yet: the assistant's gate still gets its credentials
    const init = await call('initialize', { protocol: 1, config: {}, hub: { url: 'http://127.0.0.1:18660', token: 'pext_t' } })
    assert.equal(init.result.version, '0.2.2')
    const cred = await call('assistant.credentials', { contribution: 'grokbot' })
    assert.deepEqual(cred.result, { env: { GROKBOT_API: 'http://127.0.0.1:18660/api/v1/agents', GROKBOT_TOKEN: 'pext_t' } })
    const sum = await call('assistant.summary', { contribution: 'grokbot', summary: 'POST /sessions/grokbot:b//messages' })
    assert.deepEqual(sum.result, { summary: 'POST /sessions/grokbot:b//messages' })
  } finally {
    p.kill()
  }
})

test('plugin: a non-loopback hub_url starts the plugin but refuses the assistant credentials', async () => {
  const p = spawn(process.execPath, [join(root, 'src/main.mjs')], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: p.stdout })
  const waiting = new Map()
  lines.on('line', (l) => {
    const m = JSON.parse(l)
    waiting.get(m.id)?.(m)
  })
  let n = 0
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = `b${++n}`
      waiting.set(id, resolve)
      p.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  try {
    const init = await call('initialize', { protocol: 1, config: { hub_url: 'https://example.com' }, hub: { url: 'http://127.0.0.1:18660', token: 'pext_t' } })
    assert.equal(init.result.version, '0.2.2', 'initialize still succeeds')
    const st = await call('agentsrc.status', { contribution: 'grokbot' })
    assert.equal(st.result.enabled, true, 'the Agents source keeps working')
    const cred = await call('assistant.credentials', { contribution: 'grokbot' })
    assert.equal(cred.error.code, 'invalid')
    assert.match(cred.error.message, /hub_url/)
    assert.ok(!JSON.stringify(cred).includes('pext_t'), 'no token in the refusal')
  } finally {
    p.kill()
  }
})
