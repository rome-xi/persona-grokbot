import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { collapseNotices, mergeMessages, NOTICE_MARK, parseSessionKey, toMessage } from '../src/transcript.mjs'
import { avatarURL, characterSVG } from '../src/avatar.mjs'
import { serve, RPCError } from '../src/protocol.mjs'
import { createSource, replyID } from '../src/source.mjs'
import { keyOf, threadOf } from '../src/inbox.mjs'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

test('entries become messages: reply, user, folded step, unavailable', () => {
  const k = 'bot1/'
  const reply = toMessage(k, { seq: '5', entryId: 'e5', entryKind: 'send-message', body: { kind: 'send-message', message: { type: 'text', content: 'hi' }, sentAtMs: '1700' } })
  assert.deepEqual(reply, { externalId: 'e5', sessionKey: k, position: 5, createTimeMs: 1700, role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] })
  assert.equal(toMessage(k, { seq: 4, entryId: 'e4', entryKind: 'user-message', body: { text: 'yo' } }).role, 'user')
  const step = toMessage(k, { seq: 6, entryId: 'e6', entryKind: 'tool-run', body: { kind: 'tool-run', content: 'ls' } })
  assert.equal(step.role, 'tool')
  assert.deepEqual(step.blocks, [{ type: 'tool-call', name: 'tool-run', summary: 'ls' }])
  const gone = toMessage(k, { seq: 7, entryId: 'e7', entryKind: 'blob', body: null })
  assert.equal(gone.blocks[0].type, 'tool-call', 'not a block type the apps show as raw JSON')
  assert.equal(gone.blocks[0].status, 'unavailable')
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

test('real entry kinds: bot reports, notices, quiet bookkeeping, non-text sends', () => {
  const k = 'bot1/'
  const report = toMessage(k, { seq: 10, entryId: 'm10', entryKind: 'message', body: { kind: 'message', content: 'PR 已合入' } })
  assert.deepEqual([report.role, report.blocks], ['assistant', [{ type: 'text', text: 'PR 已合入' }]])
  const notice = toMessage(k, { seq: 11, entryId: 'n11', entryKind: 'notice', body: { kind: 'notice', content: 'A background task was stopped after 50 minutes so it would not hang.' } })
  assert.equal(notice.role, 'system')
  assert.equal(notice.blocks[0].text, NOTICE_MARK + '后台任务运行超过 50 分钟，已自动停止，避免卡住。')
  assert.equal(toMessage(k, { seq: 12, entryId: 'n12', entryKind: 'notice', body: { content: 'Something new' } }).blocks[0].text, NOTICE_MARK + 'Something new')
  assert.equal(toMessage(k, { seq: 13, entryId: 'e13', entryKind: 'event', body: { kind: 'event' } }), null, 'empty bookkeeping is left out')
  assert.equal(toMessage(k, { seq: 14, entryId: 'e14', entryKind: 'spend-initiation', body: {} }), null)
  assert.equal(toMessage(k, { seq: 15, entryId: 'e15', entryKind: 'event', body: { content: 'x' } }).role, 'tool', 'an event with text stays a step')
  assert.equal(toMessage(k, { seq: 16, entryId: 'e16', entryKind: 'send-message', body: { message: { type: 'image' } } }).blocks[0].name, '发送了图片')
  assert.equal(toMessage(k, { seq: 17, entryId: 'e17', entryKind: 'send-message', body: { message: {} } }).blocks[0].name, '发送了非文本消息')
})

test('a run of the same notice is one line with its count; other messages break the run', () => {
  const n = (id, t) => ({ externalId: id, role: 'system', position: 0, blocks: [{ type: 'text', text: NOTICE_MARK + t }] })
  const a = { externalId: 'a', role: 'assistant', position: 0, blocks: [{ type: 'text', text: NOTICE_MARK + 'same' }] }
  const out = collapseNotices([n('1', 'same'), n('2', 'same'), n('3', 'same'), a, n('4', 'same'), n('5', 'other')])
  assert.deepEqual(out.map((m) => m.externalId), ['3', 'a', '4', '5'], 'the latest of a run stays')
  assert.equal(out[0].blocks[0].text, NOTICE_MARK + 'same（连续 3 次）')
  assert.equal(out[2].blocks[0].text, NOTICE_MARK + 'same', 'a single notice keeps its text')
})

test('pages: the cursor goes below hidden and folded entries, so nothing comes back on the next page', async () => {
  const entries = [
    { seq: '1', entryId: 'n1', entryKind: 'notice', body: { content: 'A background task was stopped after 50 minutes so it would not hang.' } },
    { seq: '2', entryId: 'n2', entryKind: 'notice', body: { content: 'A background task was stopped after 50 minutes so it would not hang.' } },
    { seq: '3', entryId: 'e3', entryKind: 'event', body: {} },
    { seq: '4', entryId: 'm4', entryKind: 'send-message', body: { kind: 'send-message', message: { type: 'text', content: 'hi' } } },
  ]
  const client = {
    async listBots() {
      return { bots: [{ id: 'bot1', name: 'Writer', sessionId: '', kind: 'GROK_BOT_AGENT_KIND_AGENT', updatedAtMs: '1' }] }
    },
    async listSessions() {
      return { sessions: [] }
    },
    async listTranscript({ limit }) {
      return { entries: entries.slice(-limit) }
    },
    watchBot: () => (async function* () {})(),
  }
  const src = createSource({ client, notify: () => {}, watchSessions: 1, now: () => 1_000_000, sleep: () => new Promise(() => {}) })
  await src.start()
  const page = await src.messages({ session_key: 'bot1/', cursor: '', limit: 4 })
  src.stop()
  assert.deepEqual(page.messages.map((m) => m.externalId), ['n2', 'm4'])
  assert.equal(page.nextCursor, '1', 'below the oldest entry of the page, which is folded into the run')
})

test('avatars: the bot\'s picture, else its character as an SVG the hub can draw', () => {
  assert.equal(avatarURL({ avatar: { picture: { url: 'https://example.com/a.png' }, character: { baseHex: '#1084FE' } } }), 'https://example.com/a.png')
  const url = avatarURL({ avatar: { picture: null, character: { shape: 'hex', color: 'blue', baseHex: '#1084FE' } } })
  assert.match(url, /^data:image\/svg\+xml;base64,/)
  const svg = Buffer.from(url.split(',')[1], 'base64').toString()
  assert.match(svg, /fill="#1084FE"/)
  assert.match(svg, /<polygon/)
  assert.ok(!/<text/.test(svg), 'no text: the hub draws paths only')
  assert.match(characterSVG('unknown-shape', 'not-a-colour'), /fill="#777777"/)
  assert.equal(avatarURL({}), '')
  assert.equal(avatarURL({ avatar: { picture: { url: 'http://insecure.example/a.png' } } }), '', 'only https or data pictures')
})

// ── the Inbox connector ──────────────────────────────────

// Timers the test fires by hand (the quiet period before a session is handed over).
function timers() {
  const due = []
  return {
    later: (ms, fn) => {
      const t = { ms, fn, live: true }
      due.push(t)
      return () => (t.live = false)
    },
    fire: () => {
      for (const t of due.splice(0)) if (t.live) t.fn()
    },
    pending: () => due.filter((t) => t.live).length,
  }
}

const never = () => new Promise(() => {})
const iso = (ms) => new Date(ms).toISOString()
const NOTE = (id) => `（Grok Bot 会话 grokbot:${id}：助手可用 grok 命令读全文、回复）`

test('inbox: unread replies are one thing per session, updated by later replies, closed by read and send', async () => {
  const client = fakeClient()
  const events = []
  let clock = 1_000_000
  const t = timers()
  const src = createSource({ client, notify: (e, p) => events.push([e, p]), watchSessions: 2, now: () => clock, sleep: never, later: t.later, triageRules: '  日报 Bot 的汇报算噪音\\n问我要不要删的算需要你  ' })
  await src.start()
  const changes = () => events.filter(([e]) => e === 'connector.changed').map(([, p]) => p)
  const push = (key, ev) => client.streams.get(key)(ev)
  const settle = async () => {
    await tick(); await tick()
    clock += 15_000
    t.fire()
    await tick()
  }

  // the user's own message, a notice, a step: no thing
  push('bot1/', { type: 'entry', id: 'c0', data: { seq: '5', entryId: 'bot1-e5', entryKind: 'user-message', entry: { text: '能删旧分支吗？' }, replay: false } })
  push('bot1/', { type: 'entry', id: 'c1', data: { seq: '6', entryId: 'bot1-n6', entryKind: 'notice', entry: { kind: 'notice', content: 'A background task was stopped after 50 minutes so it would not hang.' }, replay: false } })
  push('bot1/', { type: 'entry', id: 'c2', data: { seq: '7', entryId: 'bot1-t7', entryKind: 'tool-run', entry: { kind: 'tool-run', content: 'git branch' }, replay: false } })
  await settle()
  assert.deepEqual(src.inboxThings(), [], 'nothing for the user, notices or steps')
  assert.deepEqual(changes(), [])

  // a reply in two pieces: handed over once it is quiet, whole
  const first = clock
  push('bot1/', { type: 'message', id: 'c3', data: { seq: '8', entryId: 'bot1-e8', text: '旧分支有 3 个', replay: false } })
  await tick(); await tick()
  clock += 5_000
  push('bot1/', { type: 'message', id: 'c4', data: { seq: '8', entryId: 'bot1-e8', text: '旧分支有 3 个。\n你回个「删」我就处理', replay: false } })
  await tick(); await tick()
  clock += 10_000
  assert.deepEqual(src.inboxThings(), [], 'still coming in')
  await settle()
  assert.deepEqual(changes(), [{ contribution: 'grokbot', scope: 'inbox' }], 'one wake-up for the hub')
  const thing = {
    thread: 'grokbot:bot1/',
    kind: 'reply',
    label: '回复',
    title: 'Writer',
    sender: 'Writer',
    preview: '旧分支有 3 个。 你回个「删」我就处理',
    context: `用户：能删旧分支吗？\nWriter：旧分支有 3 个。\n你回个「删」我就处理\n${NOTE('bot1/')}`,
    at: iso(first),
    last: 'bot1-e8',
    reply_to: '发到 Grok Bot「Writer」这个会话，Bot 会照着做',
    can_reply: true,
    rules: '日报 Bot 的汇报算噪音\n问我要不要删的算需要你',
    tags: [{ key: 'chat', value: 'grokbot:bot1/', name: 'Writer' }, { key: 'sender', value: 'bot1', name: 'Writer' }],
  }
  assert.deepEqual(src.inboxThings(), [thing])
  assert.deepEqual(src.inboxThings(), [thing], 'the same thing each collect: thread and last are stable')
  assert.equal((await src.sessions()).sessions.find((s) => s.sessionKey === 'bot1/').unreadCount, 1, 'unread counts as before')

  // a report the bot posts on its own: the same thread, a new move, both replies in the context
  const second = clock
  push('bot1/', { type: 'entry', id: 'c5', data: { seq: '9', entryId: 'bot1-m9', entryKind: 'message', entry: { kind: 'message', content: '每小时汇报：一切正常' }, replay: false } })
  await settle()
  let [now] = src.inboxThings()
  assert.equal(src.inboxThings().length, 1, 'one thing per session')
  assert.deepEqual([now.thread, now.last, now.at, now.preview], ['grokbot:bot1/', 'bot1-m9', iso(second), '每小时汇报：一切正常'])
  assert.match(now.context, /Writer：旧分支有 3 个。[\s\S]*Writer：每小时汇报：一切正常/)

  // another session of the same bot is a thing of its own; a replayed entry is nothing
  push('bot1/side-1234567890', { type: 'message', id: 'd1', data: { seq: '3', entryId: 's-e3', text: '旧的', replay: true } })
  await settle()
  assert.equal(src.inboxThings().length, 1, 'replay is not a new reply')
  push('bot1/side-1234567890', { type: 'message', id: 'd2', data: { seq: '4', entryId: 's-e4', text: '支线好了', replay: false } })
  await settle()
  const side = src.inboxThings().find((x) => x.thread === 'grokbot:bot1/side-1234567890')
  assert.deepEqual([side.title, side.sender, side.last, side.tags[1]], ['Writer · side-123', 'Writer', 's-e4', { key: 'sender', value: 'bot1', name: 'Writer' }])
  assert.equal(side.context, `Writer：支线好了\n${NOTE('bot1/side-1234567890')}`)

  // read on the Agents page: done, at once
  events.length = 0
  await src.mark_read({ session_key: 'bot1/' })
  await tick()
  assert.deepEqual(changes(), [{ contribution: 'grokbot', scope: 'inbox' }])
  assert.deepEqual(src.inboxThings().find((x) => x.thread === 'grokbot:bot1/'), { thread: 'grokbot:bot1/', kind: 'reply', done: 'read', last: 'bot1-m9', at: iso(second) })
  // a late piece of a read reply opens nothing
  push('bot1/', { type: 'entry', id: 'c6', data: { seq: '9', entryId: 'bot1-m9', entryKind: 'message', entry: { kind: 'message', content: '每小时汇报：一切正常（补充）' }, replay: false } })
  await settle()
  assert.equal(src.inboxThings().find((x) => x.thread === 'grokbot:bot1/').done, 'read')

  // a new reply after that: open again, only it in the context
  push('bot1/', { type: 'message', id: 'c7', data: { seq: '10', entryId: 'bot1-e10', text: '删好了吗？', replay: false } })
  await settle()
  now = src.inboxThings().find((x) => x.thread === 'grokbot:bot1/')
  assert.equal(now.done, undefined)
  assert.equal(now.last, 'bot1-e10')
  assert.equal(now.context, `用户：能删旧分支吗？\nWriter：删好了吗？\n${NOTE('bot1/')}`)
  assert.ok(now.at > iso(second), 'a later move has a later time')

  // the user answers on the Agents page (agentsrc.send): replied; reading it afterwards keeps it replied
  events.length = 0
  await src.send({ session_key: 'bot1/', client_id: '6a1b7c1e-0000-4000-8000-0000000000aa', text: '删' })
  await tick()
  assert.deepEqual(changes(), [{ contribution: 'grokbot', scope: 'inbox' }])
  await src.mark_read({ session_key: 'bot1/' })
  assert.deepEqual(src.inboxThings().find((x) => x.thread === 'grokbot:bot1/'), { thread: 'grokbot:bot1/', kind: 'reply', done: 'replied', last: 'bot1-e10', at: now.at })

  // read with nothing known (an item left open from before a restart): done all the same
  await src.mark_read({ session_key: 'bot2/main' })
  assert.deepEqual(src.inboxThings().find((x) => x.thread === 'grokbot:bot2/main'), { thread: 'grokbot:bot2/main', kind: 'reply', done: 'read' })
  src.stop()
  assert.equal(t.pending() >= 0, true)
})

test('inbox: a session no longer listed is over; the connector switched off hands over nothing', async () => {
  const client = fakeClient()
  let only = false
  const list = client.listBots
  client.listBots = async (o) => {
    const r = await list(o)
    return only ? { ...r, bots: r.bots.filter((b) => b.id !== 'bot1') } : r
  }
  let clock = 1_000_000
  const t = timers()
  const src = createSource({ client, notify: () => {}, watchSessions: 2, now: () => clock, sleep: never, later: t.later })
  await src.start()
  client.streams.get('bot1/')({ type: 'message', id: 'c1', data: { seq: '5', entryId: 'e5', text: 'hi', replay: false } })
  await tick(); await tick()
  clock += 15_000
  assert.equal(src.inboxThings()[0].last, 'e5')
  assert.equal(src.inboxThings()[0].rules, undefined, 'no rules of its own: the hub uses its global ones')
  only = true
  clock += 60_000
  await src.sessions()
  assert.deepEqual(src.inboxThings(), [{ thread: 'grokbot:bot1/', kind: 'reply', done: 'read', last: 'e5', at: iso(1_000_000) }])
  src.stop()

  const off = fakeClient()
  const events = []
  const quiet = createSource({ client: off, notify: (e, p) => events.push([e, p]), watchSessions: 2, now: () => clock, sleep: never, later: t.later, inbox: false })
  await quiet.start()
  off.streams.get('bot1/')({ type: 'message', id: 'c1', data: { seq: '5', entryId: 'e5', text: 'hi', replay: false } })
  await tick(); await tick()
  clock += 60_000
  t.fire()
  await quiet.mark_read({ session_key: 'bot1/' })
  await tick()
  assert.deepEqual(quiet.inboxThings(), [])
  assert.deepEqual(events.filter(([e]) => e === 'connector.changed'), [])
  assert.equal((await quiet.sessions()).sessions[0].unreadCount, 0, 'the Agents page as before')
  quiet.stop()
})

test('inbox: Send on the Inbox card goes to the session once, under a stable message id', async () => {
  const client = fakeClient()
  let clock = 1_000_000
  const src = createSource({ client, notify: () => {}, watchSessions: 2, now: () => clock, sleep: never, later: timers().later })
  await src.start()
  const reply = { contribution: 'grokbot', thread: 'grokbot:bot1/', item_id: 'grokbot:0a1b2c3d', last: 'bot1-e8', text: '删' }
  assert.deepEqual(await src.inboxReply(reply), {})
  await src.inboxReply({ ...reply, last: 'bot1-e9' }) // the hub's retry: same item and text
  assert.equal(client.sent.length, 2)
  const [a, b] = client.sent
  assert.deepEqual({ ...a, messageId: '' }, { botId: 'bot1', sessionId: '', text: '删', messageId: '' })
  assert.equal(a.messageId, b.messageId, 'a retry is the same message: Grok Bot drops it')
  assert.match(a.messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(a.messageId, replyID(reply))
  assert.notEqual(replyID({ ...reply, text: '不删' }), a.messageId, 'another reply is another message')
  assert.notEqual(replyID({ ...reply, item_id: 'grokbot:ffff' }), a.messageId)
  assert.equal(replyID({ ...reply, client_id: '6A1B7C1E-0000-4000-8000-000000000001' }), '6a1b7c1e-0000-4000-8000-000000000001', 'the app’s own id')
  assert.equal(replyID({ ...reply, client_id: 'app-1' }), replyID({ ...reply, client_id: 'app-1', text: 'x' }), 'a client id names the send by itself')
  assert.deepEqual(src.inboxThings(), [{ thread: 'grokbot:bot1/', kind: 'reply', done: 'replied' }], 'answered: over')

  await src.inboxReply({ thread: 'grokbot:bot1/side-1234567890', text: 'ok' })
  assert.deepEqual(client.sent.at(-1).sessionId, 'side-1234567890')
  for (const [bad, code] of [
    [{ thread: 'bot1/', text: 'x' }, 'invalid'],
    [{ thread: 'grokbot:', text: 'x' }, 'invalid'],
    [{ thread: 'grokbot:a b/', text: 'x' }, 'invalid'],
    [{ thread: 'grokbot:bot1/', text: '  ' }, 'invalid'],
    [{ thread: 'grokbot:bot1/', text: '', changes: [{ ref: 'r', field: 'f', value: 'v' }] }, 'invalid'],
    [{ thread: 'grokbot:bot9/', text: 'x' }, 'not_found'],
  ]) await assert.rejects(src.inboxReply(bad), (e) => e.code === code, JSON.stringify(bad))
  const sent = client.sent.length
  client.setFailAuth(true)
  client.sendMessage = async () => { throw Object.assign(new Error('auth'), { code: 'RPC_FAILED', httpStatus: 401 }) }
  await assert.rejects(src.inboxReply({ thread: 'grokbot:bot1/', text: 'y' }), (e) => e.code === 'conflict' && /登录过期/.test(e.message))
  assert.equal(client.sent.length, sent)
  assert.equal(keyOf(threadOf('bot1/x')), 'bot1/x')
  src.stop()
})

test('connector status: from memory; an expired login is not_signed_in; nothing listed yet is an error', async () => {
  const client = fakeClient()
  let clock = 1_000_000
  const t = timers()
  const src = createSource({ client, notify: () => {}, watchSessions: 2, now: () => clock, sleep: never, later: t.later })
  await src.start()
  assert.deepEqual(src.connectorStatus(), { state: 'ok', last_sync: iso(1_000_000) })
  client.streams.get('bot1/')({ type: 'message', id: 'c1', data: { seq: '5', entryId: 'e5', text: '要继续吗？', replay: false } })
  await tick(); await tick()
  assert.equal(src.connectorStatus().last_event, iso(1_000_000))
  client.setFailAuth(true)
  clock += 61_000
  await src.status() // the Agents page's status lists again, and finds the login expired
  const st = src.connectorStatus()
  assert.equal(st.state, 'not_signed_in')
  assert.match(st.error, /登录过期/)
  assert.ok(st.guide.length)
  assert.equal(src.inboxThings()[0].last, 'e5', 'what came in stays: the hub does not collect while signed out')
  src.stop()

  const down = fakeClient()
  down.listBots = async () => { throw Object.assign(new Error('net'), { code: 'RPC_FAILED' }) }
  const none = createSource({ client: down, notify: () => {}, now: () => clock, sleep: never })
  await none.start()
  const e = none.connectorStatus()
  assert.equal(e.state, 'error')
  assert.match(e.error, /列会话失败/)
  none.stop()
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('manifest: the connector next to the agent source, its kind described, triage_rules, one version everywhere', () => {
  const m = JSON.parse(readFileSync(join(root, 'persona-plugin.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const main = readFileSync(join(root, 'src/main.mjs'), 'utf8')
  assert.equal(m.version, '0.3.0')
  assert.equal(pkg.version, m.version)
  assert.match(main, new RegExp(`const VERSION = '${m.version.replaceAll('.', '\\.')}'`))
  assert.deepEqual(m.contributes.agent_sources.map((a) => a.id), ['grokbot'])
  const [c] = m.contributes.connectors
  assert.deepEqual([c.id, c.name, c.capabilities, c.kinds], ['grokbot', 'Grok Bot', ['status', 'events', 'inbox'], ['reply']])
  assert.deepEqual(Object.keys(c.kind_descriptions), c.kinds)
  assert.match(c.kind_descriptions.reply, /拍板/)
  // the hub refuses an Inbox connector without the user's own rules (extension.CheckTriageRules)
  assert.equal(m.configuration.properties.triage_rules.type, 'string')
  assert.ok(m.configuration.properties.triage_rules.maxLength <= 4000)
})

test('plugin: the connector over the protocol before a Grok Bot login', async () => {
  const p = spawn(process.execPath, [join(root, 'src/main.mjs')], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: p.stdout })
  const waiting = new Map()
  const events = []
  lines.on('line', (l) => {
    const m = JSON.parse(l)
    if (m.event) events.push(m)
    else waiting.get(m.id)?.(m)
  })
  let n = 0
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = `k${++n}`
      waiting.set(id, resolve)
      p.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  try {
    const init = await call('initialize', { protocol: 1, config: { triage_rules: 'x' }, hub: { url: 'http://127.0.0.1:18660' }, active: { connectors: ['grokbot'] } })
    assert.equal(init.result.version, '0.3.0')
    const m = JSON.parse(readFileSync(join(root, 'persona-plugin.json'), 'utf8'))
    assert.deepEqual(init.result.contributes, { connectors: m.contributes.connectors }, 'the program says the connector the manifest has')
    const st = await call('connector.status', { contribution: 'grokbot' })
    assert.equal(st.result.state, 'not_configured')
    assert.match(st.result.error, /登录/)
    assert.deepEqual((await call('connector.inbox.collect', { contribution: 'grokbot' })).result, { things: [] })
    assert.equal((await call('connector.inbox.reply', { contribution: 'grokbot', thread: 'grokbot:b/', text: 'hi' })).error.code, 'conflict')
    assert.equal((await call('connector.tools.list', { contribution: 'grokbot' })).error.code, 'no_capability', 'the hub asks on every refresh')
    assert.equal((await call('connector.status', { contribution: 'other' })).error.code, 'no_contribution')
    assert.equal((await call('connector.nonexistent_method', { contribution: 'grokbot' })).error.code, 'unknown_method')
    assert.equal((await call('agentsrc.status', { contribution: 'other' })).error.code, 'no_contribution', 'every contribution is grokbot')
    assert.equal((await call('agentsrc.nope', {})).error.code, 'unknown_method', 'other namespaces as before')
    assert.equal((await call('agentsrc.status', { contribution: 'grokbot' })).result.setup, 'no_accounts')
    assert.deepEqual(events, [])
  } finally {
    p.kill()
  }
})
