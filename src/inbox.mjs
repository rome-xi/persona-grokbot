// The Inbox connector (contributes.connectors grokbot, Persona's connector protocol v2: connector.status,
// connector.inbox.collect, connector.inbox.reply, event connector.changed): a bot's replies the user has not read, one
// thing per session, so Persona's triage can put the ones waiting for the user under "Needs you" and push them.
//
// - A thing is made from the replies the agent source counts as unread (src/source.mjs: assistant messages the watch
//   brings in, not the user's own, not notices, not steps). Its thread is the session's id on the Agents page
//   (grokbot:<sessionKey>), its last the newest unread reply's entry id: a later reply is a new move of the same open
//   item, a later piece of the same reply is not.
// - A reply streams in pieces, so a session is handed over only once it has been quiet for a while: the triage model
//   reads the whole reply (a question at its end is what makes it "Needs you").
// - Read on the Agents page (mark_read), or answered through Persona (the Agents page, the assistant, the Inbox card):
//   the thing says done (read / replied), which closes the open item. A new reply after that starts a new item.
// - Memory only, as collect must be: after a restart nothing is unread until the watch brings a new reply.

export const CONNECTOR = 'grokbot'
export const KIND = 'reply'

const QUIET_MS = 15_000 // a session is handed over once its replies have not moved for this long
const KEEP_REPLIES = 6 // unread replies kept per session for the context
const REPLY_MOST = 2000 // characters of one reply in the context
const USER_MOST = 500 // of the user's message before the replies
const CONTEXT_MOST = 4000
const PREVIEW_MOST = 200
const RULES_MOST = 4000

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
const oneLine = (s) => s.replace(/\s+/g, ' ').trim()
const textOf = (m) =>
  (m?.blocks ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()

/** The thread of a session: its id on the Agents page. */
export const threadOf = (key) => `${CONNECTOR}:${key}`

/** The session key of a thread, or null when it is not one of ours. */
export function keyOf(thread) {
  return typeof thread === 'string' && thread.startsWith(`${CONNECTOR}:`) && thread.length > CONNECTOR.length + 1
    ? thread.slice(CONNECTOR.length + 1)
    : null
}

/**
 * @param {{
 *   notify: (event: string, params: any) => void,
 *   now?: () => number,
 *   later?: (ms: number, fn: () => void) => () => void,
 *   rules?: string,
 *   on?: boolean,
 *   quietMs?: number,
 * }} opts
 */
export function createInbox(opts) {
  const now = opts.now ?? Date.now
  const quiet = opts.quietMs ?? QUIET_MS
  const later =
    opts.later ??
    ((ms, fn) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return () => clearTimeout(t)
    })
  // the user's own triage rules as every plugin reads them (pluginkit.TriageRules): a "\n" written out is a line break
  // (the apps' settings fields are one line), trimmed, at most 4000 characters
  const rules = [...String(opts.rules ?? '').replaceAll('\\n', '\n').trim()].slice(0, RULES_MOST).join('').trim()
  const on = opts.on !== false

  /**
   * key → {info: {title, bot, botId}, replies: [{id, text, position}], last, at, movedAt, done, user, cancel}
   * done: '' while the replies are unread, 'read' / 'replied' once they are not.
   */
  const records = new Map()

  // One connector.changed for any number of changes in one turn.
  let pending = false
  const changed = () => {
    if (!on || pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      opts.notify('connector.changed', { contribution: CONNECTOR, scope: 'inbox' })
    })
  }

  const record = (key) => {
    let r = records.get(key)
    if (!r) {
      r = { info: null, replies: [], last: '', at: 0, movedAt: 0, done: '', user: null, cancel: null }
      records.set(key, r)
    }
    return r
  }

  // Hand the session over once it has been quiet: the timer only wakes the hub, collect decides.
  const settle = (r) => {
    r.cancel?.()
    r.cancel = later(quiet, () => {
      r.cancel = null
      changed()
    })
  }

  const end = (key, how) => {
    if (!on) return
    const r = record(key)
    if (r.done === how || (r.done && how === 'read')) return // read after replied stays replied
    r.done = how
    r.cancel?.()
    r.cancel = null
    changed()
  }

  return {
    /** A new reply the agent source counted as unread. */
    replied(key, m, info) {
      if (!on) return
      const r = record(key)
      if (r.done) Object.assign(r, { replies: [], done: '' })
      r.info = info
      r.replies = [...r.replies.filter((x) => x.id !== m.externalId), { id: m.externalId, text: clip(textOf(m), REPLY_MOST), position: m.position }].slice(-KEEP_REPLIES)
      r.last = m.externalId
      // the hub's own clock and never back: a move older than the item's newest is taken as one read again
      r.at = Math.max(now(), r.at + 1)
      r.movedAt = now()
      settle(r)
    },

    /** A later piece of a reply already counted (the whole current text). */
    grew(key, m) {
      const r = records.get(key)
      const x = r && !r.done ? r.replies.find((y) => y.id === m.externalId) : null
      if (!x) return
      x.text = clip(textOf(m), REPLY_MOST)
      r.movedAt = now()
      settle(r)
    },

    /** What the user wrote, for the context of the replies after it. */
    userSaid(key, m) {
      if (!on) return
      const text = textOf(m)
      const r = record(key)
      if (text && (!r.user || m.position >= r.user.position)) r.user = { text: clip(oneLine(text), USER_MOST), position: m.position }
    },

    /** The session was marked read (agentsrc.mark_read). */
    read(key) {
      end(key, 'read')
    },

    /** The user sent to the session through Persona (agentsrc.send, connector.inbox.reply). */
    sent(key) {
      end(key, 'replied')
    },

    /** Sessions no longer listed: what they had is over. */
    gone(keys) {
      for (const key of keys) {
        const r = records.get(key)
        if (r && !r.done && r.replies.length) end(key, 'read')
      }
    },

    /** connector.inbox.collect's things, from memory. */
    things() {
      const out = []
      const t = now()
      for (const [key, r] of records) {
        const thread = threadOf(key)
        if (r.done) {
          out.push({ thread, kind: KIND, done: r.done, ...(r.last ? { last: r.last, at: new Date(r.at).toISOString() } : {}) })
          continue
        }
        if (!r.replies.length || t - r.movedAt < quiet) continue // still coming in
        const { title, bot, botId } = r.info
        const newest = r.replies.at(-1)
        out.push({
          thread,
          kind: KIND,
          label: '回复',
          title,
          sender: bot,
          preview: clip(oneLine(newest.text), PREVIEW_MOST),
          context: context(key, r),
          at: new Date(r.at).toISOString(),
          last: r.last,
          reply_to: `发到 Grok Bot「${title}」这个会话，Bot 会照着做`,
          can_reply: true,
          ...(rules ? { rules } : {}),
          tags: [
            { key: 'chat', value: thread, name: title },
            { key: 'sender', value: botId, name: bot },
          ],
        })
      }
      return out
    },

    stop() {
      for (const r of records.values()) r.cancel?.()
    },
  }

  // The user's message the replies answer (when the watch saw it), then the unread replies, oldest first, as many of
  // the newest as fit; last a note for the assistant: the session's id, which its grok command reads and answers.
  function context(key, r) {
    const { bot } = r.info
    const first = r.replies[0]
    const head = r.user && r.user.position < first.position ? `用户：${r.user.text}` : ''
    const note = `（Grok Bot 会话 ${threadOf(key)}：助手可用 grok 命令读全文、回复）`
    const lines = []
    let size = head.length + note.length
    for (const x of [...r.replies].reverse()) {
      const line = `${bot}：${x.text}`
      if (lines.length && size + line.length > CONTEXT_MOST) break
      lines.unshift(line)
      size += line.length + 1
    }
    return [head, ...lines, note].filter(Boolean).join('\n')
  }
}
