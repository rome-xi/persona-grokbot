// Persona plugin: Grok Bot as a personal agents source (agent_sources, docs/plugins.md「个人 Agent 来源」), and the
// assistant's `grok` command to read and answer those sessions (contributes.assistant, src/assistant.mjs).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrokBotClient } from '../vendor/grok-bot-sdk/sdk.mjs'
import { credentials, hubBase, summarize } from './assistant.mjs'
import { RPCError, serve } from './protocol.mjs'
import { createSource } from './source.mjs'
import { proxyFetch } from './proxy-fetch.mjs'

const log = (msg) => process.stderr.write(`grokbot: ${msg}\n`)
const VERSION = '0.2.2'

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

serve({
  id: 'grokbot',
  version: VERSION,
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
    })
    void source.start()
  },
  handlers: {
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
    'assistant.credentials': async () => {
      if (hubError) throw new RPCError('invalid', hubError)
      return credentials(hubURL, hubToken)
    },
    'assistant.summary': async ({ summary }) => ({ summary: summarize(summary, source?.known() ?? []) }),
  },
  onClose() {
    source?.stop()
    process.exit(0)
  },
})
