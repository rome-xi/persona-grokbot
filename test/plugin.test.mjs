import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mergeMessages, parseSessionKey, toMessage } from '../src/transcript.mjs'
import { serve, RPCError } from '../src/protocol.mjs'
import { createSource } from '../src/source.mjs'

test('entries become messages: reply, user, folded step, unavailable', () => {
  const k = 'bot1/'
  const reply = toMessage(k, { seq: '5', entryId: 'e5', entryKind: 'send-message', body: { kind: 'send-message', message: { type: 'text', content: 'hi' }, sentAtMs: '1700' } })
  assert.deepEqual(reply, { externalId: 'e5', sessionKey: k, position: 5, createTimeMs: 1700, role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] })
  assert.equal(toMessage(k, { seq: 4, entryId: 'e4', entryKind: 'user-message', body: { text: 'yo' } }).role, 'user')
  const step = toMessage(k, { seq: 6, entryId: 'e6', entryKind: 'tool-run', body: { kind: 'tool-run', content: 'ls' } })
  assert.equal(step.role, 'tool')
  assert.deepEqual(step.blocks, [{ type: 'tool-call', name: 'tool-run', summary: 'ls' }])
  assert.equal(toMessage(k, { seq: 7, entryId: 'e7', entryKind: 'blob', body: null }).blocks[0].status, 'unavailable')
  assert.equal(toMessage(k, { seq: 0 }), null, 'no id, no message')
  // the watch stream's message event: the whole current text
  assert.equal(toMessage(k, { seq: '9', entryId: 'e9', text: 'partial' }).blocks[0].text, 'partial')
})

test('a later update of an entry replaces it, keeping its time', () => {
  const a = { externalId: 'x', position: 2, createTimeMs: 50, role: 'assistant', blocks: [{ type: 'text', text: 'Hel' }] }
  const b = { externalId: 'x', position: 2, createTimeMs: 0, role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }] }
  const c = { externalId: 'y', position: 1, createTimeMs: 1, role: 'user', blocks: [] }
  const out = mergeMessages([a], [b, c])
  assert.deepEqual(out.map((m) => m.externalId), ['y', 'x'])
  assert.equal(out[1].blocks[0].text, 'Hello')
  assert.equal(out[1].createTimeMs, 50)
})

test('session keys', () => {
  assert.deepEqual(parseSessionKey('abc/'), { botId: 'abc', sessionId: '' })
  assert.deepEqual(parseSessionKey('abc/s-1'), { botId: 'abc', sessionId: 's-1' })
  assert.equal(parseSessionKey('/x'), null)
  assert.equal(parseSessionKey('a b/x'), null)
})

// A line-based peer on the other end, as the hub would be.
function wire(prog) {
  const input = new PassThrough()
  const output = new PassThrough()
  serve({ ...prog, input, output })
  const lines = []
  const waiters = []
  let buf = ''
  output.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      lines.push(msg)
      for (const w of [...waiters]) if (w.ok(msg)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(msg))
    }
  })
  const next = (ok) => {
    const seen = lines.find(ok)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      waiters.push({ ok, resolve })
      setTimeout(() => reject(new Error('no such line')), 2000).unref()
    })
  }
  let n = 0
  const call = async (method, params) => {
    const id = `h${++n}`
    input.write(JSON.stringify({ id, method, params }) + '\n')
    return next((m) => m.id === id)
  }
  return { call, next, lines }
}

test('protocol: not initialized, wrong protocol, ping, unknown method, error codes', async () => {
  const p = wire({ id: 'grokbot', version: '0.1.0', initialize() {}, handlers: { 'agentsrc.x': async () => { throw new RPCError('not_found', 'nope') }, 'agentsrc.y': async () => { throw new Error('plain') } } })
  assert.equal((await p.call('ping', {})).error.code, 'not_initialized')
  assert.equal((await p.call('initialize', { protocol: 2 })).error.code, 'wrong_protocol')
  assert.deepEqual((await p.call('initialize', { protocol: 1 })).result, { protocol: 1, id: 'grokbot', version: '0.1.0' })
  assert.deepEqual((await p.call('ping', {})).result, {})
  assert.equal((await p.call('agentsrc.nope', {})).error.code, 'unknown_method')
  assert.deepEqual((await p.call('agentsrc.x', {})).error, { code: 'not_found', message: 'nope' })
  assert.deepEqual((await p.call('agentsrc.y', {})).error, { message: 'plain' })
})

// A Grok Bot client that answers from memory and lets the test push watch events.
function fakeClient() {
  const sent = []
  const streams = new Map()
  let failAuth = false
  return {
    sent,
    streams,
    setFailAuth: (v) => (failAuth = v),
    async listBots() {
      if (failAuth) throw Object.assign(new Error('auth'), { code: 'RPC_FAILED', httpStatus: 401 })
      // the SDK's shapes: {bots} of normalizeBot, {sessions} of normalizeSession
      return { bots: [
        { id: 'bot1', name: 'Writer', sessionId: '', kind: 'GROK_BOT_AGENT_KIND_AGENT', updatedAtMs: '2000' },
        { id: 'bot2', name: 'Room', sessionId: 'main', kind: 'ROOM', updatedAtMs: '1000' },
      ], truncated: false }
    },
    async listSessions(botId) {
      return { sessions: botId === 'bot1' ? [{ agentId: 'bot1', sessionId: 'side-1234567890', lastActivityAtMs: '1500' }] : [] }
    },
    async listTranscript({ botId, limit, beforeSeq }) {
      const all = [1, 2, 3, 4].map((seq) => ({ seq: String(seq), entryId: `${botId}-e${seq}`, entryKind: seq % 2 ? 'user-message' : 'send-message', body: seq % 2 ? { text: `q${seq}` } : { kind: 'send-message', message: { type: 'text', content: `a${seq}` } } }))
      const rows = all.filter((e) => !beforeSeq || Number(e.seq) < Number(beforeSeq))
      return { generation: '1', entries: rows.slice(-limit) }
    },
    async sendMessage(m) {
      sent.push(m)
      return { botId: m.botId, messageId: m.messageId, delivery: 'accepted-box', dispatched: true }
    },
    watchBot({ botId, sessionId, signal }) {
      const key = `${botId}/${sessionId}`
      const queue = []
      let wake
      streams.set(key, (ev) => (queue.push(ev), wake?.()))
      return (async function* () {
        while (!signal.aborted) {
          if (!queue.length) await new Promise((r) => { wake = r; signal.addEventListener('abort', r, { once: true }) })
          while (queue.length) yield queue.shift()
        }
      })()
    },
  }
}

const tick = () => new Promise((r) => setImmediate(r))

test('source: sessions, pages, send, live updates, unread, auth expiry', async () => {
  const client = fakeClient()
  const events = []
  let clock = 1_000_000
  const src = createSource({ client, notify: (e, p) => events.push([e, p]), watchSessions: 2, now: () => clock, sleep: () => new Promise(() => {}) })
  await src.start()

  const { sessions } = await src.sessions()
  assert.deepEqual(sessions.map((s) => s.sessionKey), ['bot1/', 'bot1/side-1234567890', 'bot2/main'])
  assert.deepEqual(src.known().map((s) => s.sessionKey).sort(), ['bot1/', 'bot1/side-1234567890', 'bot2/main'], 'known: as listed')
  assert.equal(sessions[0].provider, 'grok_bot')
  assert.equal(sessions[1].parentSessionKey, 'bot1/')
  assert.equal(sessions[1].title, 'Writer · side-123')
  assert.equal(sessions[2].kind, 'main')
  assert.deepEqual(src._state().watching.sort(), ['bot1/', 'bot1/side-1234567890'], 'the two busiest are watched')

  // the hub's own call: cursor "" for the newest page; a cursor this source never gave out is refused
  assert.equal((await src.messages({ session_key: 'bot1/', cursor: '', limit: 2 })).messages.length, 2)
  await assert.rejects(src.messages({ session_key: 'bot1/', cursor: 'abc', limit: 2 }), (e) => e.code === 'invalid')
  const page = await src.messages({ session_key: 'bot1/', limit: 2 })
  assert.deepEqual(page.messages.map((m) => [m.externalId, m.role]), [['bot1-e3', 'user'], ['bot1-e4', 'assistant']])
  assert.equal(page.hasMore, true)
  const older = await src.messages({ session_key: 'bot1/', limit: 2, cursor: page.nextCursor })
  assert.deepEqual(older.messages.map((m) => m.externalId), ['bot1-e1', 'bot1-e2'])
  await assert.rejects(src.messages({ session_key: 'bot9/', limit: 2 }), (e) => e.code === 'not_found')

  await assert.rejects(src.send({ session_key: 'bot1/', client_id: 'not-a-uuid', text: 'x' }), (e) => e.code === 'invalid')
  await assert.rejects(src.send({ session_key: 'bot1/', client_id: '6a1b7c1e-0000-4000-8000-000000000009', text: '  ' }), (e) => e.code === 'invalid')
  const r = await src.send({ session_key: 'bot1/', client_id: '6a1b7c1e-0000-4000-8000-000000000001', text: 'hello' })
  assert.equal(r.delivery, 'accepted-box')
  assert.deepEqual(client.sent[0], { botId: 'bot1', sessionId: '', text: 'hello', messageId: '6a1b7c1e-0000-4000-8000-000000000001' })

  // the reply streams in: an update pushed to the hub each time, the page carries the newest text, unread counts it
  events.length = 0
  client.streams.get('bot1/')({ type: 'message', id: 'c1', data: { seq: '5', entryId: 'bot1-e5', text: 'Wor', replay: false } })
  client.streams.get('bot1/')({ type: 'message', id: 'c2', data: { seq: '5', entryId: 'bot1-e5', text: 'World', replay: false } })
  await tick(); await tick()
  assert.deepEqual(events.filter(([e]) => e === 'agentsrc.updated').map(([, p]) => p.session_keys), [['bot1/'], ['bot1/']])
  const now = await src.messages({ session_key: 'bot1/', limit: 2 })
  assert.equal(now.messages.at(-1).externalId, 'bot1-e5')
  assert.equal(now.messages.at(-1).blocks[0].text, 'World')
  assert.equal((await src.sessions()).sessions.find((s) => s.sessionKey === 'bot1/').unreadCount, 1, 'a reply streamed in two pieces is one unread')
  await src.mark_read({ session_key: 'bot1/' })
  assert.equal((await src.sessions()).sessions.find((s) => s.sessionKey === 'bot1/').unreadCount, 0)

  await assert.rejects(src.delete_message({}), (e) => e.code === 'unsupported')
  await assert.rejects(src.search({ q: 'x' }), (e) => e.code === 'unsupported')

  // login expired: the account says so, the status still answers
  client.setFailAuth(true)
  await assert.rejects(src.messages({ session_key: 'bot1/side-missing', limit: 2 }), (e) => e.code === 'not_found', 'an unknown key right after a list: not listed again')
  clock += 6_000
  await assert.rejects(src.messages({ session_key: 'bot1/side-missing', limit: 2 }), (e) => e.code === 'conflict', 'a few seconds later it is, and the login is found expired')
  const st = await src.status()
  assert.equal(st.accounts[0].status, 'paused')
  assert.match(st.accounts[0].lastError, /登录过期/)
  src.stop()
})

// A watch that the server ends (lifetime, resync) or that fails comes back, backing off; a resync starts over from the
// newest; one stopped by an expired login is watched again once a list works.
test('watch: reconnect, resync, backoff, auth stop and restart, live bound', async () => {
  const calls = []
  const sleeps = []
  let mode = 'resync'
  let n = 0
  const client = {
    async listBots() {
      if (mode === 'auth') throw Object.assign(new Error('auth'), { code: 'RPC_FAILED', httpStatus: 401 })
      return { bots: [{ id: 'bot1', name: 'W', sessionId: '', updatedAtMs: '1' }] }
    },
    async listSessions() { return { sessions: [] } },
    async listTranscript() { return { generation: 0, entries: [] } },
    async *watchBot({ resumeFrom, signal }) {
      calls.push(resumeFrom ?? null)
      n++
      if (mode === 'resync') {
        yield { type: 'message', id: 'cur-1', data: { seq: '1', entryId: 'a', text: 'x', replay: false } }
        yield { type: 'resync-required', data: {} }
        return
      }
      if (mode === 'empty') return // ends with nothing: backs off
      if (mode === 'auth') throw Object.assign(new Error('auth'), { code: 'RPC_FAILED', httpStatus: 401 })
      if (mode === 'flood') {
        for (let i = 0; i < 500; i++) yield { type: 'entry', id: `c${i}`, data: { seq: String(i + 10), entryId: `t${i}`, entryKind: 'tool', entry: { kind: 'tool' }, replay: false } }
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }))
      }
    },
  }
  let release
  const sleep = (ms) => { sleeps.push(ms); return new Promise((r) => (release = r)) }
  const src = createSource({ client, notify: () => {}, watchSessions: 1, sleep })
  await src.start()
  await tick(); await tick()
  assert.deepEqual(calls, [null], 'first watch from the newest')
  assert.equal(sleeps.at(-1), 500, 'a stream that brought data comes back quickly')
  mode = 'empty'; release(); await tick(); await tick()
  assert.deepEqual(calls, [null, null], 'after a resync the cursor is dropped, not reused')
  release(); await tick(); await tick()
  assert.ok(sleeps.at(-1) > 500 && sleeps.at(-2) > 500, `empty streams back off: ${sleeps}`)

  mode = 'auth'; release(); await tick(); await tick(); await tick()
  assert.deepEqual(src._state().watching, [], 'stopped by the expired login')
  assert.equal(src._state().account.status, 'paused')
  mode = 'flood'
  await src.sessions() // within a minute: cached
  await src.messages({ session_key: 'bot1/', limit: 1 }) // known key: no relist
  assert.deepEqual(src._state().watching, [])
  const listed = await (async () => { const s2 = createSource({ client, notify: () => {}, watchSessions: 1, sleep: () => new Promise(() => {}) }); await s2.start(); await tick(); await tick(); return s2 })()
  assert.deepEqual(listed._state().watching, ['bot1/'], 'a list that works watches it again')
  assert.ok(listed._state().live.get('bot1/').length <= 200, 'live entries are bounded')
  listed.stop()
  src.stop()
})
