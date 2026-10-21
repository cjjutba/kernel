import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { PushEvent } from '@shared/ipc'
import type { RemoteDeviceRow } from '../db'
import type { RemoteAuth } from './remoteAuth'
import { refusal } from './remoteChannels'

/*
 * Remote access protocol (remote-access-server). Everything is JSON text.
 *
 *   GET  /          a page for a browser. `assets` serves the web client when there is one, else a placeholder.
 *   POST /pair      { code, name? } -> 200 { token, deviceId, name, expiresAt } | 400 | 401 | 429. One request per code.
 *   GET  /ws        WebSocket upgrade. The token is `Authorization: Bearer <token>`, or `?token=<token>` for a browser.
 *
 * On the socket the client sends { id, channel, req } and gets { id, ok: true, res } or { id, ok: false, error } back, in
 * any order. `channel` is one of the IPC channels the window calls, answered by the same handlers. The server pushes
 * { event } for every PushEvent. A socket is closed for a message over 1 MB (code 1009, which a client still sending may see as 1006), 4401 once its token is revoked or
 * ends, and 1001 when Kernel stops.
 */

/** The largest message the server takes on the socket. */
export const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_PAIR_BODY_BYTES = 4096
const MAX_SOCKETS = 20
const MAX_IN_FLIGHT = 32
/** A push is dropped for a socket, and the socket closed, when this much is waiting to be sent to it. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const PING_MS = 30_000
const PORT_TRIES = 20
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Close code for a token that was revoked or ended. */
export const CLOSE_UNAUTHORIZED = 4401

export type Handler = (req: unknown) => Promise<unknown>
export interface Asset { type: string; body: Buffer | string }

export interface RemoteServerOptions {
  /** The address to bind: `127.0.0.1`, or `0.0.0.0` for every interface. */
  host: string
  /** The port to try first. When it is taken the next ones are tried, and `start()` says the one it got. */
  port: number
  /** Accept any Host header. Off, only the loopback names are, which stops a DNS rebinding page from reaching a local-only server. */
  anyHost: boolean
  auth: RemoteAuth
  /** Every channel the server may answer. `refusal` still decides which of them a device gets. */
  handlers: Record<string, Handler>
  /**
   * The seam for the web client: the file for a URL path, or undefined for none. The provider keeps the path inside its own
   * folder. Nothing is served from disk until a later change passes one.
   */
  assets?: (path: string) => Promise<Asset | undefined>
}

interface Client { ws: WebSocket; device: RemoteDeviceRow; alive: boolean; inFlight: number }

const PLACEHOLDER = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kernel</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#e8e8ea;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:26rem;padding:2rem}h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#9a9aa0}</style>
<main><h1>Kernel remote access is on</h1><p>The web client is coming. This Mac is ready to pair with it.</p></main></html>`

/** The HTTP and WebSocket server behind Settings, Remote access. One instance listens on one address until `stop()`. */
export class RemoteServer {
  private http?: Server
  private wss?: WebSocketServer
  private ping?: NodeJS.Timeout
  private clients = new Map<WebSocket, Client>()
  private actualPort = 0

  constructor(private readonly o: RemoteServerOptions) {}

  get port(): number { return this.actualPort }

  /** Starts listening, on the first free port from the one asked for. Throws when none is free or the address can't be bound. */
  async start(): Promise<{ host: string; port: number }> {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
    let last: unknown
    for (let p = this.o.port; p < this.o.port + PORT_TRIES && p <= 65535; p++) {
      const server = this.build()
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(p, this.o.host, () => { server.off('error', reject); resolve() })
        })
      } catch (err) {
        last = err
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
        throw err
      }
      this.http = server
      this.actualPort = (server.address() as AddressInfo).port
      this.ping = setInterval(() => this.heartbeat(), PING_MS)
      this.ping.unref()
      return { host: this.o.host, port: this.actualPort }
    }
    throw new Error(`No free port from ${this.o.port} to ${this.o.port + PORT_TRIES - 1}${last instanceof Error ? ` (${last.message})` : ''}`)
  }

  /** Closes every socket and stops listening. */
  async stop(): Promise<void> {
    clearInterval(this.ping)
    for (const c of this.clients.values()) c.ws.close(1001, 'Kernel is stopping')
    this.clients.clear()
    this.wss?.close()
    const http = this.http
    this.http = undefined
    if (!http) return
    await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections() })
  }

  /** Sends a push to every connected device. */
  broadcast(event: PushEvent) {
    if (!this.clients.size) return
    const text = JSON.stringify({ event })
    const now = Date.now()
    for (const c of this.clients.values()) {
      // A session that ended while its socket sat idle gets no more events.
      if (c.device.expiresAt <= now) { c.ws.close(CLOSE_UNAUTHORIZED, 'Session ended'); continue }
      if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) { c.ws.close(1013, 'Too far behind'); continue }
      this.send(c, text)
    }
  }

  /** The ids of the devices with a socket open. */
  connectedIds(): Set<string> { return new Set([...this.clients.values()].map((c) => c.device.id)) }

  /** Closes the sockets of a device whose session ended. */
  closeDevice(id: string) {
    for (const [ws, c] of this.clients) if (c.device.id === id) { ws.close(CLOSE_UNAUTHORIZED, 'Session ended'); this.clients.delete(ws) }
  }

  private build(): Server {
    const server = createServer((req, res) => { void this.route(req, res).catch(() => { if (!res.headersSent) text(res, 500, 'Something went wrong'); else res.end() }) })
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    return server
  }

  /** The Host header names this server: our port, and a loopback name unless the server listens for the network. */
  private hostOk(req: IncomingMessage): boolean {
    const m = /^(\[[0-9a-f:]+\]|[^:/\s]+)(?::(\d+))?$/i.exec(req.headers.host ?? '')
    if (!m || Number(m[2] ?? 80) !== this.actualPort) return false
    return this.o.anyHost || LOOPBACK.has(m[1].toLowerCase())
  }

  /** A browser says where its page came from. Only this server's own page may call it. Other clients send none and need the token. */
  private originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    return origin === undefined || origin === `http://${req.headers.host}`
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    if (!this.hostOk(req) || !this.originOk(req)) return text(res, 403, 'Forbidden')
    let path: string
    try { path = new URL(req.url ?? '/', 'http://kernel').pathname } catch { return text(res, 400, 'Bad request') }
    if (path === '/pair') return req.method === 'POST' ? this.pair(req, res) : text(res, 405, 'Use POST')
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed')
    const asset = await this.o.assets?.(path)
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.type })
      return res.end(req.method === 'HEAD' ? undefined : asset.body)
    }
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(req.method === 'HEAD' ? undefined : PLACEHOLDER)
    }
    return text(res, 404, 'Not found')
  }

  private async pair(req: IncomingMessage, res: ServerResponse) {
    // A form on another site can post text/plain without asking first, but not JSON.
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return text(res, 415, 'Expected application/json')
    let body: { code?: unknown; name?: unknown }
    try {
      const parsed: unknown = JSON.parse(await readBody(req, MAX_PAIR_BODY_BYTES))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      body = parsed
    } catch (err) {
      if (!(err instanceof TooLarge)) return text(res, 400, 'Expected a JSON object')
      // The rest of the body is not read: the connection ends once the answer is out.
      res.setHeader('Connection', 'close')
      res.once('finish', () => req.socket.destroy())
      return text(res, 413, 'Too large')
    }
    const r = this.o.auth.pair(body.code, body.name, req.socket.remoteAddress ?? 'unknown')
    if (!r.ok) {
      if (r.retryAfterSec) res.setHeader('Retry-After', String(r.retryAfterSec))
      return json(res, r.status, { error: r.error })
    }
    return json(res, 200, { token: r.token, deviceId: r.device.id, name: r.device.name, expiresAt: r.device.expiresAt })
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://kernel') } catch { return refuse(socket, 400, 'Bad Request') }
    if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found')
    if (!this.hostOk(req) || !this.originOk(req)) return refuse(socket, 403, 'Forbidden')
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const device = this.o.auth.verify(bearer ?? url.searchParams.get('token'))
    if (!device) return refuse(socket, 401, 'Unauthorized')
    if (this.clients.size >= MAX_SOCKETS || !this.wss) return refuse(socket, 503, 'Service Unavailable')
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, device))
  }

  private accept(ws: WebSocket, device: RemoteDeviceRow) {
    const client: Client = { ws, device, alive: true, inFlight: 0 }
    this.clients.set(ws, client)
    this.o.auth.seen(device.id)
    ws.on('pong', () => { client.alive = true })
    ws.on('close', () => this.clients.delete(ws))
    ws.on('error', () => ws.terminate())
    ws.on('message', (data, binary) => void this.onMessage(client, data, binary))
  }

  private heartbeat() {
    for (const [ws, c] of this.clients) {
      if (!c.alive) { ws.terminate(); this.clients.delete(ws); continue }
      c.alive = false
      ws.ping()
    }
  }

  private async onMessage(c: Client, data: RawData, binary: boolean) {
    if (c.device.expiresAt <= Date.now()) { c.ws.close(CLOSE_UNAUTHORIZED, 'Session ended'); return }
    this.o.auth.seen(c.device.id)
    const fail = (id: unknown, error: string) => this.send(c, JSON.stringify({ id, ok: false, error }))
    let msg: { id?: unknown; channel?: unknown; req?: unknown }
    try {
      if (binary) throw new Error('binary')
      const parsed: unknown = JSON.parse(data.toString())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      msg = parsed
    } catch {
      return fail(null, 'Messages are JSON text like { "id", "channel", "req" }')
    }
    const { id, channel, req } = msg
    if (!(typeof id === 'string' && id.length > 0 && id.length <= 64) && !Number.isSafeInteger(id)) return fail(null, 'A message needs an id, a string or a whole number')
    if (typeof channel !== 'string') return fail(id, 'A message needs a channel name')
    const why = refusal(channel, req)
    if (why) return fail(id, why)
    // Own keys only, so "constructor" and "__proto__" are not channels.
    if (!Object.hasOwn(this.o.handlers, channel)) return fail(id, `Unknown channel ${channel.slice(0, 80)}`)
    if (c.inFlight >= MAX_IN_FLIGHT) return fail(id, 'Too many calls at once')
    c.inFlight++
    try {
      this.send(c, JSON.stringify({ id, ok: true, res: await this.o.handlers[channel](req) }))
    } catch (err) {
      fail(id, err instanceof Error ? err.message : String(err))
    } finally {
      c.inFlight--
    }
  }

  private send(c: Client, payload: string) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload)
  }
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) { req.removeAllListeners('data'); req.resume(); reject(new TooLarge()); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/** Ends an upgrade that is not allowed with a plain HTTP answer. */
function refuse(socket: Duplex, status: number, reason: string) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
