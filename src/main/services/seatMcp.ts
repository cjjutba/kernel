import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { KERNEL_SERVER } from './kernelServer'
import { hostOk } from './hookServer'

export type SeatRole = 'lead' | 'build' | 'teammate'

export interface Seat { chatId: string; workspaceId: string; role: SeatRole }

export interface SeatTools { tools: SdkMcpToolDefinition<any>[]; instructions?: string }

const digest = (s: string) => createHash('sha256').update(s).digest()

/** Which seat each bearer token belongs to (KERNEL-997). A seat has one token at a time, and a closed seat has none. */
export class SeatRegistry {
  private readonly seats = new Map<string, Seat>()

  /** A new token for the seat's chat. The chat's earlier token stops working, as when its pty starts again. */
  make(seat: Seat): string {
    this.revokeChat(seat.chatId)
    const token = randomBytes(32).toString('base64url')
    this.seats.set(token, { ...seat })
    return token
  }

  revoke(token: string): boolean { return this.seats.delete(token) }

  revokeChat(chatId: string): number {
    let n = 0
    for (const [token, seat] of this.seats) if (seat.chatId === chatId) { this.seats.delete(token); n++ }
    return n
  }

  revokeWorkspace(workspaceId: string): number {
    let n = 0
    for (const [token, seat] of this.seats) if (seat.workspaceId === workspaceId) { this.seats.delete(token); n++ }
    return n
  }

  revokeAll() { this.seats.clear() }

  get size() { return this.seats.size }

  /** Constant time in the guess: every token is compared, on digests of equal length, so timing says nothing about a near miss. */
  seatOf(sent: string | string[] | undefined): Seat | undefined {
    if (typeof sent !== 'string' || sent === '') return undefined
    const a = digest(sent)
    let found: Seat | undefined
    for (const [token, seat] of this.seats) if (timingSafeEqual(a, digest(token))) found = seat
    return found
  }
}

export interface SeatMcpOptions {
  registry: SeatRegistry
  /** The tools and instructions a seat gets, read on each request so a Settings change reaches the next call. Undefined refuses the seat. */
  serve: (seat: Seat) => SeatTools | undefined
  /** 0 takes a free port. */
  port?: number
}

export interface SeatMcp { server: Server; port: number; url: string; close: () => Promise<void> }

const bearer = (header: string | string[] | undefined) => (typeof header === 'string' ? /^Bearer (\S+)$/.exec(header)?.[1] : undefined)

/**
 * Kernel's tools for a terminal seat, as a Streamable HTTP MCP server on 127.0.0.1 (KERNEL-997). Each request builds a server
 * from the seat's own tools, so a seat reaches what its chat would get and nothing else, and no state outlives a request.
 */
export function startSeatMcp(o: SeatMcpOptions): Promise<SeatMcp> {
  let port = 0
  const server = createServer(async (req, res) => {
    // Before anything else, routing included: a foreign Host is DNS rebinding and learns nothing, not even which paths exist.
    if (!hostOk(req.headers.host, port)) return fail(res, 401, 'unauthorized')
    if (!req.url?.startsWith('/mcp')) return fail(res, 404, 'not found')
    const sent = bearer(req.headers.authorization)
    if (!o.registry.seatOf(sent)) return fail(res, 401, 'unauthorized')
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed', { allow: 'POST' })
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(res, 415, 'expected application/json')
    let body: unknown
    try { body = JSON.parse(await readBody(req)) } catch { return fail(res, 400, 'invalid json') }
    // The body can take a while to arrive, and the token may have been revoked or replaced meanwhile.
    const seat = o.registry.seatOf(sent)
    if (!seat) return fail(res, 401, 'unauthorized')
    const given = o.serve(seat)
    if (!given) return fail(res, 404, 'no such seat')
    const mcp = new McpServer({ name: KERNEL_SERVER, version: '0.1.0' }, given.instructions ? { instructions: given.instructions } : undefined)
    for (const t of given.tools) {
      mcp.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}), ...(t._meta ? { _meta: t._meta } : {}) }, ((args: unknown, extra: unknown) => t.handler(args as never, extra)) as never)
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void mcp.close() })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch {
      if (!res.headersSent) fail(res, 500, 'internal error')
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      resolve({ server, port, url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections() }) })
    })
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 5_000_000) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function fail(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers })
  res.end(JSON.stringify({ error }))
}
