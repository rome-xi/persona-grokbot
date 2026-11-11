// Grok Bot transcript entries as Persona personal-agent messages (the olk-bridge shapes:
// {externalId, sessionKey, role, blocks, createTimeMs, position}).
//
// The entry kinds are not documented. What is known (grok-bot-sdk docs/guide/notes.md, Open Lark's adapter that
// runs against the real service, and real transcripts): a `send-message` entry whose message.type is "text" is the
// bot's reply, and so is a `message` entry with text (a report the bot posts on its own); an entry whose kind or
// role says "user" is what the user sent; a `notice` is the service's own line ("A background task was stopped…").
// `event` and `spend-initiation` entries carry nothing to read and are left out when empty. Anything else is a
// folded step, so nothing unknown is dropped.

/** @param {unknown} v */
const text = (v) => (typeof v === 'string' ? v : '')

/** @param {unknown} v */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {})

/** @param {unknown} v */
export function millis(v) {
  const n = typeof v === 'number' ? v : Number(text(v))
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** The session key Persona uses: <botId>/<sessionId> (sessionId '' is the bot's main session). */
export const sessionKey = (botId, sessionId) => `${botId}/${sessionId ?? ''}`

/** @param {string} key */
export function parseSessionKey(key) {
  const i = typeof key === 'string' ? key.indexOf('/') : -1
  if (i <= 0) return null
  const botId = key.slice(0, i)
  const sessionId = key.slice(i + 1)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId) || sessionId.length > 256) return null
  return { botId, sessionId }
}

const clip = (s) => (s.length > 2000 ? s.slice(0, 2000) + '…' : s)

// Bookkeeping kinds with nothing to show when they have no text.
const QUIET_KINDS = new Set(['event', 'spend-initiation'])

// What a non-text send-message is, for its step's name.
const MESSAGE_TYPES = { image: '图片', file: '文件', audio: '语音', video: '视频', card: '卡片', link: '链接' }

// The service's notices people see most, in the user's language; others stay as they are.
const NOTICES = [
  [/^A background task was stopped after (\d+) minutes? so it would not hang\.?$/i, (m) => `后台任务运行超过 ${m[1]} 分钟，已自动停止，避免卡住。`],
]

/** @param {string} raw */
export function noticeText(raw) {
  const t = raw.trim()
  for (const [re, say] of NOTICES) {
    const m = re.exec(t)
    if (m) return say(m)
  }
  return t
}

// A notice reads as a quiet line under the conversation (a quote in Markdown), not as the bot's words.
export const NOTICE_MARK = '> ⚙️ '

function bodyText(body) {
  const message = obj(body.message)
  return text(message.content) || text(body.text) || text(body.content) || text(message.text)
}

/**
 * One entry as the SDK normalizes it ({seq, updatedSeq, entryId, entryKind, bodyOmitted, body}) or as the watch
 * stream yields it ({seq, entryId, entryKind?, entry?|text?}).
 * @returns {null | {externalId: string, sessionKey: string, role: string, blocks: object[], createTimeMs: number, position: number}}
 */
export function toMessage(key, entry) {
  const e = obj(entry)
  const seq = millis(e.seq)
  const externalId = text(e.entryId) || (seq ? `seq-${seq}` : '')
  if (!externalId) return null
  const body = e.body !== undefined ? e.body : e.entry
  const kind = text(e.entryKind) || text(obj(body).kind)
  const base = { externalId, sessionKey: key, position: seq, createTimeMs: 0 }
  if (typeof e.text === 'string') {
    // the watch stream's own "message" event: a reply's whole current text
    return { ...base, role: 'assistant', blocks: [{ type: 'text', text: e.text }] }
  }
  if (!body || typeof body !== 'object') {
    // a folded step (the apps show unknown block types as raw JSON); status kept for clients that read it
    return { ...base, role: 'tool', blocks: [{ type: 'tool-call', name: '内容不可用', status: 'unavailable', summary: kind || 'entry' }] }
  }
  const b = obj(body)
  base.createTimeMs = millis(b.sentAtMs) || millis(b.createdAtMs) || millis(b.timestampMs)
  const content = bodyText(b)
  const message = obj(b.message)
  if (/user/i.test(kind) || b.role === 'user') {
    return { ...base, role: 'user', blocks: content ? [{ type: 'text', text: content }] : [] }
  }
  if (kind === 'send-message' && message.type === 'text') {
    return { ...base, role: 'assistant', blocks: [{ type: 'text', text: content }] }
  }
  if (kind === 'message' && content.trim()) {
    return { ...base, role: 'assistant', blocks: [{ type: 'text', text: content }] }
  }
  if (kind === 'notice' && content.trim()) {
    return { ...base, role: 'system', blocks: [{ type: 'text', text: NOTICE_MARK + noticeText(content) }] }
  }
  if (!content.trim() && QUIET_KINDS.has(kind)) return null
  if (kind === 'send-message') {
    const type = text(message.type)
    const block = { type: 'tool-call', name: `发送了${MESSAGE_TYPES[type] ?? (type ? `${type} 消息` : '非文本消息')}` }
    if (content) block.summary = clip(content)
    return { ...base, role: 'tool', blocks: [block] }
  }
  const block = { type: 'tool-call', name: kind || 'entry' }
  if (content) block.summary = clip(content)
  return { ...base, role: 'tool', blocks: [block] }
}

/**
 * Runs of the same notice one after another (a stuck task stopped every 50 minutes, forty times) as one line: the
 * latest of the run, with how many times it came.
 */
export function collapseNotices(list) {
  const out = []
  for (const m of list) {
    const prev = out.at(-1)
    const notice = (x) => x?.role === 'system' && x.blocks?.length === 1 && x.blocks[0].type === 'text' && x.blocks[0].text.startsWith(NOTICE_MARK)
    if (notice(m) && notice(prev?.m) && prev.m.blocks[0].text === m.blocks[0].text) {
      out[out.length - 1] = { m, n: prev.n + 1 }
      continue
    }
    out.push({ m, n: 1 })
  }
  return out.map(({ m, n }) => (n > 1 ? { ...m, blocks: [{ ...m.blocks[0], text: `${m.blocks[0].text}（连续 ${n} 次）` }] } : m))
}

/** Messages in display order, one per externalId (a later update of the same entry replaces it). */
export function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map((m) => [m.externalId, m]))
  for (const m of incoming) {
    const old = byId.get(m.externalId)
    byId.set(m.externalId, old && !m.createTimeMs ? { ...m, createTimeMs: old.createTimeMs } : m)
  }
  return [...byId.values()].sort((a, b) => a.position - b.position)
}
