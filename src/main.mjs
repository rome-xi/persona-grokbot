// Persona plugin: Grok Bot as a personal agents source (agent_sources, docs/plugins.md「个人 Agent 来源」), the bots'
// unread replies as an Inbox connector (connectors, src/inbox.mjs), and the assistant's `grok` command to read and
// answer those sessions (contributes.assistant, src/assistant.mjs).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrokBotClient } from '../vendor/grok-bot-sdk/sdk.mjs'
import { credentials, hubBase, summarize } from './assistant.mjs'
import { RPCError, serve } from './protocol.mjs'
import { CONNECTOR } from './inbox.mjs'
import { createSource } from './source.mjs'
import { proxyFetch } from './proxy-fetch.mjs'

const log = (msg) => process.stderr.write(`grokbot: ${msg}\n`)
const VERSION = '0.3.0'

// For end-to-end tests only: a GROKBOT_TEST_ORIGIN file in the plugin's data directory holding
// http://127.0.0.1:<port> sends every Grok Bot request to a local fake instead (the hub gives an installed plugin a
// clean environment, so it cannot come from there). Anything but a loopback address is refused.
function testFetch(dataDir) {
  let origin = ''
  try {
    origin = readFileSync(join(dataDir || '', 'GROKBOT_TEST_ORIGIN'), 'utf8').trim()
  } catch {}
  if (!dataDir || !origin) return undefined
  const u = new URL(origin)
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('GROKBOT_TEST_ORIGIN must be a loopback http address')
  return (url, init) => fetch(String(url).replace('https://api2.cursor.sh', u.origin), init)
}

// What the program contributes, said back at initialize: the hub (and the conformance kit) holds the connector the
// program declares to the manifest's, and logs each start where it says none.
function ownConnectors() {
  try {
    const m = JSON.parse(readFileSync(new URL('../persona-plugin.json', import.meta.url), 'utf8'))
    return Array.isArray(m?.contributes?.connectors) ? { connectors: m.contributes.connectors } : undefined
  } catch {
    return undefined
  }
}

let source = null
// The hub's API for the assistant's gate: its address on this machine and this run's token of the granted scopes.
let hubURL = ''
let hubToken = ''
let hubError = ''
const need = () => {
  if (!source) throw new RPCError('conflict', '还没登录 Grok Bot：在插件设置里填登录凭据')
  return source
}
const call = (name) => async (params) => need()[name](params)

// Every contribution of this plugin (agent source, connector, assistant) is "grokbot": a call naming another is refused.
const own = (handlers) =>
  Object.fromEntries(
    Object.entries(handlers).map(([method, h]) => [
      method,
      async (params) => {
        const c = params?.contribution
        if (c !== undefined && c !== CONNECTOR) throw new RPCError('no_contribution', `no contribution ${c}`)
        return h(params)
      },
    ]),
  )

// The connector protocol's calls from the hub (connector/serve/wire.go): the ones of capabilities this connector does
// not declare are no_capability (the hub asks tools.list on each refresh all the same); anything else is unknown.
const CONNECTOR_METHODS = new Set(['status', 'login.step', 'logout', 'archive.changes', 'inbox.collect', 'inbox.reply', 'catalog.list',
  'catalog.call', 'tools.list', 'tools.call', 'actions.list', 'actions.describe', 'actions.do', 'recall', 'recall.can', 'recall.do',
  'thread.page', 'thread.media', 'items.list', 'items.doc_title', 'archive.media', 'snapshot.get', 'history.chats', 'archive.history',
  'history.anchors', 'group.tool', 'group.append', 'group.fallback', 'options.get', 'options.set', 'inbox.settle', 'machines.online',
  'auth.get', 'auth.set'])
const NOT_CONFIGURED = {
  state: 'not_configured',
  error: '还没登录 Grok Bot',
  guide: ['App › 设置 › 插件 › Grok Bot，填「Grok Bot 登录凭据」'],
}

serve({
  id: 'grokbot',
  version: VERSION,
  contributes: ownConnectors(),
  initialize(params, hub) {
    const token = params?.secrets?.access_token
    let cfg = {}
    try {
      cfg = typeof params?.config === 'string' ? JSON.parse(params.config) : (params?.config ?? {})
    } catch {}
    // A bad hub_url turns off only the assistant's command; the Agents tab keeps working.
    try {
      hubURL = hubBase(cfg, params?.hub)
      hubError = ''
    } catch (err) {
      hubURL = ''
      hubError = err instanceof Error ? err.message : String(err)
      log(`hub_url: ${hubError}`)
    }
    hubToken = params?.hub?.token || process.env.PERSONA_HUB_TOKEN || ''
    if (typeof token !== 'string' || !token) {
      log('no access_token: waiting for the user to set it')
      return
    }
    let fetchImpl = testFetch(params?.plugin?.data_dir)
    if (!fetchImpl && cfg.proxy) {
      try {
        fetchImpl = proxyFetch(cfg.proxy)
      } catch (err) {
        log(`proxy: ${err.message}; connecting directly`)
      }
    }
    const client = new GrokBotClient({ accessToken: token, fetchImpl })
    source = createSource({
      client,
      notify: hub.notify,
      log,
      watchSessions: Number.isInteger(cfg.watch_sessions) ? cfg.watch_sessions : 6,
      includeTeamAgents: cfg.include_team_agents === true,
      triageRules: typeof cfg.triage_rules === 'string' ? cfg.triage_rules : '',
      // the connector switched off (Settings › Extensions) is not in this run's active ones: no Inbox then
      inbox: !Array.isArray(params?.active?.connectors) || params.active.connectors.includes(CONNECTOR),
    })
    void source.start()
  },
  handlers: own({
    'agentsrc.status': async () => {
      if (!source) {
        return {
          enabled: true,
          setup: 'no_accounts',
          providers: [{ provider: 'grok_bot', connection: 'server', available: true }],
          accounts: [],
        }
      }
      return source.status()
    },
    'agentsrc.sessions': async () => (source ? source.sessions() : { sessions: [] }),
    'agentsrc.messages': call('messages'),
    'agentsrc.send': call('send'),
    'agentsrc.mark_read': call('mark_read'),
    'agentsrc.delete_message': call('delete_message'),
    'agentsrc.search': call('search'),
    'connector.status': async () => (source ? source.connectorStatus() : NOT_CONFIGURED),
    'connector.inbox.collect': async () => ({ things: source ? source.inboxThings() : [] }),
    'connector.inbox.reply': call('inboxReply'),
    'assistant.credentials': async () => {
      if (hubError) throw new RPCError('invalid', hubError)
      return credentials(hubURL, hubToken)
    },
    'assistant.summary': async ({ summary }) => ({ summary: summarize(summary, source?.known() ?? []) }),
  }),
  missing: (method) =>
    method.startsWith('connector.') && CONNECTOR_METHODS.has(method.slice('connector.'.length))
      ? new RPCError('no_capability', `Grok Bot 的连接器没有 ${method}`)
      : undefined,
  onClose() {
    source?.stop()
    process.exit(0)
  },
})
