// Grok Bot transcript entries as Persona personal-agent messages (the olk-bridge shapes:
// {externalId, sessionKey, role, blocks, createTimeMs, position}).
//
// The entry kinds are not documented. What is known (grok-bot-sdk docs/guide/notes.md, and Open Lark's adapter
// that runs against the real service): a `send-message` entry whose message.type is "text" is the bot's reply;
// an entry whose kind or role says "user" is what the user sent. Everything else is kept as a folded step, so
// nothing is dropped before the kinds are calibrated.

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
    return { ...base, role: 'system', blocks: [{ type: 'status', status: 'unavailable', text: kind || 'entry' }] }
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
  const block = { type: 'tool-call', name: kind || 'entry' }
  if (content) block.summary = content.length > 2000 ? content.slice(0, 2000) + '…' : content
  return { ...base, role: 'tool', blocks: [block] }
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
