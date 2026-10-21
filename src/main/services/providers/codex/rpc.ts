import type { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'

// `codex app-server` speaks JSON-RPC 2.0 over stdio, one message per line and without the "jsonrpc" field. Kernel sends
// requests and notifications, and answers the requests Codex sends back (approvals, questions, Kernel's tools).

/** A JSON-RPC error from Codex, with its code and data. */
export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown, readonly timedOut = false) {
    super(message)
    this.name = 'RpcError'
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }

export interface RpcHandlers {
  /** A notification from Codex: an item, a turn's end, new rate limits. */
  notify?: (method: string, params: any) => void
  /** A request from Codex that waits for Kernel's answer. A thrown error goes back as a JSON-RPC error. */
  request?: (method: string, params: any) => Promise<unknown>
}

/** One connection to an app-server process, by its stdin and stdout. */
export class Rpc {
  private next = 1
  private pending = new Map<number | string, Pending>()
  private closed?: Error

  constructor(private readonly input: Writable, output: Readable, private readonly handlers: RpcHandlers = {}) {
    createInterface({ input: output }).on('line', (line) => this.receive(line))
    output.on('close', () => this.close(new Error('Codex closed the connection.')))
    input.on('error', (e: Error) => this.close(e))
  }

  /** Send a request and wait for its answer. `timeoutMs` rejects when Codex doesn't answer in time. */
  request<T = unknown>(method: string, params?: unknown, o: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject }
      if (o.timeoutMs) entry.timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`Codex did not answer ${method} in time.`, undefined, undefined, true)) }, o.timeoutMs)
      this.pending.set(id, entry)
      this.write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown) { if (!this.closed) this.write({ method, ...(params === undefined ? {} : { params }) }) }

  /** Every waiting request fails with `reason`, and nothing more is sent. */
  close(reason = new Error('Codex closed the connection.')) {
    if (this.closed) return
    this.closed = reason
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(reason); this.pending.delete(id) }
  }

  get isClosed() { return !!this.closed }

  private write(msg: object) {
    try { this.input.write(JSON.stringify(msg) + '\n') } catch (e) { this.close(e as Error) }
  }

  private receive(line: string) {
    if (!line.trim()) return
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new RpcError(msg.error.message ?? 'Codex returned an error.', msg.error.code, msg.error.data))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === undefined) return
    if (msg.id === undefined) { this.handlers.notify?.(msg.method, msg.params); return }
    const id = msg.id
    const answer = this.handlers.request ? this.handlers.request(msg.method, msg.params) : Promise.reject(new RpcError(`Kernel can't answer ${msg.method}.`, -32601))
    answer.then(
      (result) => this.write({ id, result: result ?? {} }),
      (e: Error) => this.write({ id, error: { code: e instanceof RpcError && e.code !== undefined ? e.code : -32000, message: e.message } })
    )
  }
}

/** Kernel's name and version in `initialize`. Experimental methods carry the plan mode, questions and dynamic tools. */
export function initializeParams(version: string) {
  return { clientInfo: { name: 'kernel', title: 'Kernel', version }, capabilities: { experimentalApi: true, requestAttestation: false } }
}
