// A local stand-in for the Grok Bot service, for end-to-end tests: the RPCs the plugin uses and a Connect stream
// for WatchGrokBotTranscripts. POST /_test/reply {botId, sessionId, entryId, seq, text} pushes a reply on the
// watches of that session. Prints "listening <port>".
import { createServer } from 'node:http'

const bots = [{ agentId: 'bot1', name: 'Writer', viewerSessionId: '', kind: 'GROK_BOT_AGENT_KIND_AGENT', updatedAtMs: String(Date.now()) }]
const entries = [
  { seq: '1', updatedSeq: '1', entryId: 'e1', entryKind: 'user-message', body: Buffer.from(JSON.stringify({ text: 'hello?' })).toString('base64') },
  { seq: '2', updatedSeq: '2', entryId: 'e2', entryKind: 'send-message', body: Buffer.from(JSON.stringify({ kind: 'send-message', message: { type: 'text', content: 'hi there' } })).toString('base64') },
]
const watchers = new Set()
const sent = []

const frame = (obj, flags = 0) => {
  const data = Buffer.from(JSON.stringify(obj))
  const head = Buffer.alloc(5)
  head[0] = flags
  head.writeUInt32BE(data.length, 1)
  return Buffer.concat([head, data])
}

const read = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))) })

createServer(async (req, res) => {
  const raw = await read(req)
  const auth = req.headers.authorization === 'Bearer test-token'
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.url === '/_test/reply') {
    const r = JSON.parse(raw)
    const entry = { seq: String(r.seq), updatedSeq: String(r.seq), entryId: r.entryId, entryKind: 'send-message',
      body: Buffer.from(JSON.stringify({ kind: 'send-message', message: { type: 'text', content: r.text } })).toString('base64') }
    const i = entries.findIndex((e) => e.entryId === r.entryId)
    if (i >= 0) entries[i] = entry; else entries.push(entry)
    for (const w of watchers) if (w.botId === r.botId && w.sessionId === (r.sessionId ?? '')) { entry.updatedSeq = String(Number(entry.seq) * 100 + (w.n = (w.n ?? 0) + 1)); w.res.write(frame({ rows: { agentId: r.botId, sessionId: r.sessionId ?? '', generation: 1, entries: [entry] } })) }
    return json(200, { watchers: watchers.size })
  }
  if (req.url === '/_test/sent') return json(200, { sent })
  if (process.env.FAKE_GROK_LOG) process.stderr.write(`fake-grok: ${req.method} ${req.url} auth=${req.headers.authorization ? req.headers.authorization.slice(0, 13) : 'none'}\n`)
  if (!auth) return json(401, { error: { code: 'unauthenticated' } })
  const method = req.url.split('/').pop()
  const body = req.url.includes('WatchGrokBotTranscripts') ? JSON.parse(raw.subarray(5)) : (raw.length ? JSON.parse(raw) : {})
  switch (method) {
    case 'ListGrokBotAgents': return json(200, { agents: bots })
    case 'ListGrokBotAgentSessions': return json(200, { sessions: [] })
    case 'ListGrokBotTranscriptEntries': {
      const rows = entries.filter((e) => !body.beforeSeq || Number(e.seq) < Number(body.beforeSeq))
      return json(200, { generation: 1, entries: rows.slice(-(body.limit ?? 50)) })
    }
    case 'SendGrokBotUserMessage':
      sent.push({ agentId: body.agentId, sessionId: body.sessionId, text: body.text, messageId: body.messageId })
      return json(200, { delivery: 1, dispatched: true })
    case 'WatchGrokBotTranscripts': {
      const c = body.cursors[0]
      res.writeHead(200, { 'content-type': 'application/connect+json' })
      res.write(frame({ connected: { serverTimeMs: String(Date.now()), absoluteLifetimeMs: '600000' } }))
      const w = { botId: c.agentId, sessionId: c.sessionId ?? '', res }
      watchers.add(w)
      req.on('close', () => watchers.delete(w))
      return
    }
  }
  json(404, { error: { code: 'unimplemented' } })
}).listen(0, '127.0.0.1', function () { console.log(`listening ${this.address().port}`) })
