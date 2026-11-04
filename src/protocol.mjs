// The Persona plugin protocol (docs/plugins.md「进程插件协议」): one JSON message per line on stdin / stdout.
// Requests {"id","method","params"}, answers {"id","result"} / {"id","error":{"message","code"}}, events
// {"event","params"}. stderr is the log: never secrets or message text.
import { createInterface } from 'node:readline'

export class RPCError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const PROTOCOL = 1

/**
 * @param {{
 *   id: string, version: string,
 *   initialize: (params: any, hub: {notify: (event: string, params: any) => void}) => Promise<void> | void,
 *   handlers: Record<string, (params: any) => Promise<any>>,
 *   onClose?: () => void,
 *   input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
 * }} prog
 */
export function serve(prog) {
  const input = prog.input ?? process.stdin
  const output = prog.output ?? process.stdout
  const write = (msg) => output.write(JSON.stringify(msg) + '\n')
  const hub = { notify: (event, params) => write({ event, params: params ?? {} }) }
  let initialized = false

  const answer = async (msg) => {
    const { id, method } = msg
    const params = msg.params ?? {}
    try {
      if (method === 'initialize') {
        if (params.protocol !== PROTOCOL) throw new RPCError('wrong_protocol', `protocol ${params.protocol}, not ${PROTOCOL}`)
        if (!initialized) {
          await prog.initialize(params, hub)
          initialized = true
        }
        return write({ id, result: { protocol: PROTOCOL, id: prog.id, version: prog.version } })
      }
      if (method === 'manifest') throw new RPCError('unknown_method', 'no manifest here: it is in the package')
      if (!initialized) throw new RPCError('not_initialized', 'not initialized')
      if (method === 'ping') return write({ id, result: {} })
      const h = prog.handlers[method]
      if (!h) throw new RPCError('unknown_method', `unknown method ${method}`)
      write({ id, result: (await h(params)) ?? {} })
    } catch (err) {
      const code = err instanceof RPCError ? err.code : undefined
      const message = err instanceof Error ? err.message : String(err)
      write({ id, error: code ? { code, message } : { message } })
    }
  }

  const rl = createInterface({ input, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg && typeof msg.method === 'string' && msg.id !== undefined) void answer(msg)
    // answers to our own calls and events from the hub: this plugin calls nothing and listens to nothing
  })
  rl.on('close', () => {
    prog.onClose?.()
  })
  return { hub }
}
