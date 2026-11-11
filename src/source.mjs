// The Grok Bot agent source: the user's bots and their sessions as Persona personal-agent sessions, kept fresh by
// watching the busiest few live (WatchGrokBotTranscripts) and re-listing the rest now and then.
import { RPCError } from './protocol.mjs'
import { mergeMessages, millis, parseSessionKey, sessionKey, toMessage } from './transcript.mjs'

const PROVIDER = 'grok_bot'
const ROOM_KINDS = new Set(['2', 'ROOM', 'GROK_BOT_AGENT_KIND_ROOM'])
const LIST_EVERY_MS = 60_000
const RELIST_UNKNOWN_MS = 5_000 // a key we do not know relists at most this often
const PAGE_MAX = 200
const LIVE_MAX = 200 // newest watched entries kept per session until its page is read
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXPIRED = '登录过期了：在插件设置里重新登录 Grok Bot'

/** An SDKError's HTTP status, when it had one. */
const httpStatus = (err) => (err && typeof err === 'object' && Number.isInteger(err.httpStatus) ? err.httpStatus : 0)
const authFailed = (err) => [401, 403].includes(httpStatus(err))

/**
 * @param {{
 *   client: import('../vendor/grok-bot-sdk/sdk.mjs').GrokBotClient,
 *   notify: (event: string, params: any) => void,
 *   log?: (msg: string) => void,
 *   watchSessions?: number,
 *   includeTeamAgents?: boolean,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} opts
 */
export function createSource(opts) {
  const client = opts.client
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now
  const watchMax = opts.watchSessions ?? 6
  const sleep =
    opts.sleep ??
    ((ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
      }))

  /** @type {Map<string, any>} key → session */
  let sessions = new Map()
  let listedAt = 0
  let listing = null
  /** @type {{status: string, error?: string}} */
  let account = { status: 'active' }
  /** key → messages watched since the last page was read: replies arriving while the app is not asking */
  const live = new Map()
  /** key → externalIds already counted as unread (a reply streamed in pieces is one unread) */
  const counted = new Map()
  /** key → {control, since} */
  const watches = new Map()
  /** key → {isRunning, isComposingMessage} */
  const busy = new Map()
  const stopped = new AbortController()

  const changed = (keys) => opts.notify('agentsrc.updated', keys ? { session_keys: keys } : {})

  async function list(force = false) {
    if (!force && sessions.size && now() - listedAt < LIST_EVERY_MS) return sessions
    if (listing) return listing
    listing = (async () => {
      try {
        const { bots } = await client.listBots({ includeTeamAgents: opts.includeTeamAgents ?? false })
        const next = new Map()
        for (const bot of bots) {
          if (!bot?.id) continue
          const name = bot.name || bot.title || 'Grok Bot'
          const room = ROOM_KINDS.has(String(bot.kind ?? ''))
          const main = bot.sessionId ?? ''
          const add = (sessionId, activity, title) => {
            const key = sessionKey(bot.id, sessionId)
            if (next.has(key)) return
            const prev = sessions.get(key)
            next.set(key, {
              sessionKey: key,
              accountId: 'grok',
              provider: PROVIDER,
              title,
              kind: sessionId === main ? 'main' : room ? 'room' : 'side',
              ...(sessionId === main ? {} : { parentSessionKey: sessionKey(bot.id, main) }),
              canSend: true,
              unreadCount: prev?.unreadCount ?? 0,
              rankTimeMs: Math.max(activity, prev?.rankTimeMs ?? 0),
            })
          }
          add(main, millis(bot.updatedAtMs) || millis(bot.createdAtMs), name)
          let others = []
          try {
            ;({ sessions: others } = await client.listSessions(bot.id))
          } catch (err) {
            if (authFailed(err)) throw err
            log(`sessions of a bot: ${err?.code ?? 'failed'}`)
          }
          for (const s of others) {
            const id = s.sessionId ?? ''
            add(id, millis(s.lastActivityAtMs) || millis(s.updatedAtMs) || millis(s.createdAtMs), `${name} · ${id.slice(0, 8)}`)
          }
        }
        sessions = next
        listedAt = now()
        account = { status: 'active' }
        for (const k of [...live.keys()]) if (!next.has(k)) (live.delete(k), counted.delete(k))
        rewatch()
        return sessions
      } catch (err) {
        account = authFailed(err)
          ? { status: 'paused', error: EXPIRED }
          : { status: account.status, error: `列会话失败（${err?.code ?? 'error'}）` }
        if (authFailed(err)) throw new RPCError('conflict', account.error)
        throw err
      } finally {
        listing = null
      }
    })()
    return listing
  }

  // The busiest sessions are watched live; one that drops out of the top is let go.
  function rewatch() {
    const want = [...sessions.values()]
      .sort((a, b) => b.rankTimeMs - a.rankTimeMs)
      .slice(0, watchMax)
      .map((s) => s.sessionKey)
    for (const [key, w] of watches) {
      if (!want.includes(key)) {
        w.control.abort()
        watches.delete(key)
      }
    }
    for (const key of want) if (!watches.has(key)) watch(key)
  }

  function watch(key) {
    const ref = parseSessionKey(key)
    if (!ref) return
    const control = new AbortController()
    const signal = AbortSignal.any([control.signal, stopped.signal])
    const me = { control }
    watches.set(key, me)
    void (async () => {
      let resumeFrom
      let failures = 0
      try {
        while (!signal.aborted) {
          let data = false
          try {
            for await (const ev of client.watchBot({ botId: ref.botId, sessionId: ref.sessionId, resumeFrom, signal })) {
              if (ev.type === 'resync-required' || (ev.type === 'reset' && !ev.id)) resumeFrom = undefined // start over from the newest
              else if (ev.id) resumeFrom = ev.id
              if (ev.type !== 'connected' && ev.type !== 'heartbeat') data = true
              onEvent(key, ev)
            }
            // the server ended it (its lifetime, a resync): go again; one that brought nothing backs off
            failures = data ? 0 : failures + 1
          } catch (err) {
            if (signal.aborted) return
            if (authFailed(err)) {
              account = { status: 'paused', error: EXPIRED }
              changed()
              return // the next list that works watches it again
            }
            failures++
            if (err?.code === 'CURSOR_INVALID' || err?.code === 'CURSOR_SCOPE_MISMATCH') resumeFrom = undefined
            log(`watch: ${err?.code ?? 'failed'}; again in ${Math.min(60, 2 ** failures)}s`)
          }
          if (signal.aborted) return
          await sleep(failures ? Math.min(60_000, 1000 * 2 ** failures) : 500, signal)
        }
      } finally {
        if (watches.get(key) === me) watches.delete(key) // gone for good: rewatch may start it again
      }
    })()
  }

  function onEvent(key, ev) {
    switch (ev.type) {
      case 'message':
      case 'entry':
      case 'entry.unavailable': {
        const m = toMessage(key, ev.type === 'message' ? { seq: ev.data.seq, entryId: ev.data.entryId, text: ev.data.text } : ev.data)
        if (!m) return
        live.set(key, mergeMessages(live.get(key) ?? [], [m]).slice(-LIVE_MAX))
        const s = sessions.get(key)
        if (s && !ev.data.replay) {
          s.rankTimeMs = Math.max(s.rankTimeMs, m.createTimeMs || now())
          // one unread per new reply: not the user's own, not a step, not a piece of a reply already counted
          const seen = counted.get(key) ?? new Set()
          if (m.role === 'assistant' && !seen.has(m.externalId)) {
            seen.add(m.externalId)
            if (seen.size > LIVE_MAX) seen.delete(seen.values().next().value)
            counted.set(key, seen)
            s.unreadCount++
          }
        }
        changed([key])
        return
      }
      case 'message.deleted':
        live.set(key, (live.get(key) ?? []).filter((m) => m.externalId !== ev.data.entryId))
        changed([key])
        return
      case 'reset':
      case 'resync-required':
        live.delete(key)
        changed([key])
        return
      case 'agent.state': {
        const st = ev.data.live?.[0]
        if (st) busy.set(key, { isRunning: st.isRunning, isComposingMessage: st.isComposingMessage })
        return
      }
      case 'turn.failed':
        log(`turn failed: code ${ev.data.code}`)
        changed([key])
        return
    }
  }

  function session(key) {
    const s = sessions.get(key)
    if (!s) throw new RPCError('not_found', `no Grok Bot session ${key}`)
    return s
  }

  // A key we do not know: it may be new since the last list; relisted at most every few seconds.
  async function find(key) {
    if (!sessions.has(key) && now() - listedAt >= RELIST_UNKNOWN_MS) await list(true)
    return session(key)
  }

  return {
    async status() {
      try {
        await list()
      } catch {
        // the account's error says it
      }
      return {
        enabled: true,
        ...(account.status === 'active' && sessions.size === 0 && listedAt ? { setup: 'no_accounts' } : {}),
        providers: [{ provider: PROVIDER, connection: 'server', available: account.status === 'active' }],
        accounts: [
          {
            accountId: 'grok',
            provider: PROVIDER,
            displayName: 'Grok Bot',
            status: account.status,
            sessionCount: sessions.size,
            lastSyncedAt: listedAt || undefined,
            ...(account.error ? { lastError: account.error } : {}),
          },
        ],
      }
    },

    async sessions() {
      await list()
      return { sessions: [...sessions.values()].sort((a, b) => b.rankTimeMs - a.rankTimeMs) }
    },

    // The sessions as last listed, without listing: for the phone card's names, which the hub waits on only briefly.
    known() {
      return [...sessions.values()]
    },

    async messages({ session_key: key, cursor: rawCursor, limit }) {
      // the hub passes "" for the newest page; an older page's cursor is the oldest seq we gave out
      const cursor = typeof rawCursor === 'string' && /^\d{1,20}$/.test(rawCursor) ? rawCursor : ''
      if (rawCursor && !cursor) throw new RPCError('invalid', 'cursor is not one this source gave out')
      const s = await find(key)
      const ref = parseSessionKey(key)
      const n = Math.min(PAGE_MAX, Math.max(1, Number(limit) || 50))
      const page = await client.listTranscript({
        botId: ref.botId,
        sessionId: ref.sessionId,
        limit: n,
        ...(cursor ? { beforeSeq: String(cursor) } : {}),
      })
      let messages = page.entries.map((e) => toMessage(key, e)).filter(Boolean)
      messages.sort((a, b) => a.position - b.position)
      if (!cursor) {
        const newest = messages.at(-1)?.position ?? 0
        // what the watch saw after this page was cut (a reply still being written) is kept on top of it
        const newer = (live.get(key) ?? []).filter((m) => m.position > newest)
        messages = mergeMessages(messages, newer)
        live.set(key, newer)
      }
      const oldest = messages[0]?.position
      const hasMore = page.entries.length >= n && Boolean(oldest)
      return { session: s, messages, hasMore, ...(hasMore ? { nextCursor: String(oldest) } : {}) }
    },

    async send({ session_key: key, client_id: clientId, text }) {
      // the client id is Grok Bot's message id: the same one again is a duplicate there, not a second message
      if (typeof clientId !== 'string' || !UUID.test(clientId)) throw new RPCError('invalid', 'client_id must be a UUID')
      if (typeof text !== 'string' || !text.trim()) throw new RPCError('invalid', 'text is empty')
      const s = await find(key)
      const ref = parseSessionKey(s.sessionKey)
      try {
        const sent = await client.sendMessage({ botId: ref.botId, sessionId: ref.sessionId, text, messageId: clientId })
        s.rankTimeMs = now()
        if (!watches.has(key)) rewatch()
        return { delivery: sent.delivery, dispatched: sent.dispatched }
      } catch (err) {
        if (authFailed(err)) throw new RPCError('conflict', EXPIRED)
        if (err?.code === 'MESSAGE_INVALID' || err?.code === 'BOT_ID_REQUIRED') throw new RPCError('invalid', `Grok Bot 不收这条（${err.code}）`)
        throw new Error(`Grok Bot 没确认收到（${err?.code ?? 'error'}）：可以用同一条重试，它会去重`)
      }
    },

    async mark_read({ session_key: key }) {
      const s = session(key)
      s.unreadCount = 0 // what was counted stays counted: a later piece of a read reply is not unread again
      return {}
    },

    async delete_message() {
      throw new RPCError('unsupported', 'Grok Bot 不能撤回消息')
    },

    async search() {
      throw new RPCError('unsupported', 'Grok Bot 没有搜索')
    },

    /** Lists once and starts the watches; keeps listing in the background. */
    async start() {
      try {
        await list(true)
        changed()
      } catch (err) {
        log(`first list: ${err?.code ?? err?.message ?? 'failed'}`)
      }
      void (async () => {
        while (!stopped.signal.aborted) {
          await sleep(LIST_EVERY_MS, stopped.signal)
          if (stopped.signal.aborted) return
          const before = new Map([...sessions].map(([k, s]) => [k, s.rankTimeMs]))
          try {
            await list(true)
          } catch {
            continue
          }
          const moved = [...sessions].filter(([k, s]) => before.get(k) !== s.rankTimeMs).map(([k]) => k)
          if (moved.length || before.size !== sessions.size) changed(before.size !== sessions.size ? undefined : moved)
        }
      })()
    },

    stop() {
      stopped.abort()
      for (const w of watches.values()) w.control.abort()
      watches.clear()
    },

    /** for tests */
    _state: () => ({ watching: [...watches.keys()], live, busy, account }),
  }
}
