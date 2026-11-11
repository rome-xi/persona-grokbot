// The assistant's side of the plugin (manifest contributes.assistant): the credentials of the `grok` command's gate
// (assistant/gate.json) and the phone card's text with session ids turned into Bot names.
//
// The gate's API is the hub's own personal Agents API (/api/v1/agents, what the App's Agents tab calls), reached with
// this plugin's hub token (permissions.hub: agents.read, agents.control). The node running the assistant keeps the
// token in its gate proxy: the assistant only gets the proxy's address, and every send is confirmed on the phone first.
import { RPCError } from './protocol.mjs'

export const DEFAULT_HUB_URL = 'http://127.0.0.1:18660'

function httpURL(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/**
 * The hub's address as the assistant's machine reaches it: the hub_url setting, else the hub's own address when it is
 * a loopback one (a sandboxed plugin's is the sandbox's name for the hub, which the node cannot reach), else the
 * hub's default port here. The hub only takes this plugin's token from its own machine: the assistant must run there.
 */
export function hubBase(cfg, hub) {
  const set = httpURL(cfg?.hub_url)
  const valid = (u) => u && ['127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'
  if (cfg?.hub_url && !valid(set)) throw new RPCError('invalid', 'hub_url 必须是本机回环地址（127.0.0.1 或 [::1]），不能含路径、账号或查询参数')
  const own = httpURL(hub?.url)
  const u = set ?? (valid(own) ? own : null)
  return u ? u.origin : DEFAULT_HUB_URL
}

/** assistant.credentials → {env}: the gate's base (base_env) and the token its proxy puts on each request. */
export function credentials(base, token) {
  if (typeof token !== 'string' || !token) {
    throw new RPCError('conflict', 'hub 没给这个插件令牌：在 hub 上重新同意插件的权限（agents.read、agents.control）')
  }
  return { env: { GROKBOT_API: `${base}/api/v1/agents`, GROKBOT_TOKEN: token } }
}

/**
 * assistant.summary: the card shows the call's path, whose session id says nothing to a person. Each known session's
 * id (as typed, or percent-encoded) becomes its Bot's name; the longest first, so that a Bot's main session
 * ("grokbot:bot1/") does not eat into one of its side sessions ("grokbot:bot1/side-1").
 */
export function summarize(summary, sessions) {
  let out = String(summary ?? '')
  const named = (sessions ?? [])
    .filter((s) => typeof s?.sessionKey === 'string' && s.sessionKey)
    .map((s) => ({ id: `grokbot:${s.sessionKey}`, name: `「${s.title || 'Grok Bot'}」` }))
    .sort((a, b) => b.id.length - a.id.length)
  // Only an exact request-path line is presentation metadata; never alter JSON/body lines.
  return out.split('\n').map((line) => {
    const match = /^(POST \/sessions\/)(\S+)(\/(?:messages|read))$/.exec(line)
    if (!match) return line
    for (const { id, name } of named) {
      if (match[2] === id || match[2] === encodeURIComponent(id)) return match[1] + name + match[3]
    }
    return line
  }).join('\n')
}
