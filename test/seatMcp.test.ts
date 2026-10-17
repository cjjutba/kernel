import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentDef, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import type { Seats } from '../src/main/features/seats'
import { run } from '../src/main/services/exec'
import { LEAD_INSTRUCTIONS } from '../src/main/services/kernelMcp'
import { SeatRegistry } from '../src/main/services/seatMcp'
import { setUp, tempRepo, freePort } from './helpers'

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-997: Kernel's tools over local HTTP for a terminal seat, the same ones its chat would get.

const REPO = {
  'README.md': '# shop\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian. Open a PR for each task.',
  '.kernel/settings.toml': '[pr]\nmerge_method = "merge"\n'
}

let k: Kernel
let seats: Seats
let repo: string
let projectId: string
let lead: { ws: Workspace; chatId: string }
let build: { ws: Workspace; chatId: string }
let mate: { ws: Workspace; chatId: string }

const git = (dir: string, ...args: string[]) => run('git', ['-C', dir, ...args])

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false, requireReviewer: false, leadMerge: true } }))
  k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  repo = await tempRepo(REPO)
  const project = await k.addProject(repo)
  k.store.saveProject({ ...project, host: 'local' })
  projectId = project.id
  const chatWs = async (mode: 'handoff' | 'build') => {
    const c = await k.lead.newLeadChat(projectId, { prompt: '', leadMode: mode })
    const ws = await setUp(k, c.id, 'settled')
    return { ws, chatId: c.id }
  }
  lead = await chatWs('handoff')
  build = await chatWs('build')
  const made = await setUp(k, (await k.workspaces.createWorkspace(projectId, { prompt: 'Build the cart', agentId: 'christian', title: 'Cart' })).id)
  mate = { ws: made, chatId: k.store.chats(made.id)[0].id }
  seats = k.seats
  await seats.start()
}, 60_000)

afterAll(async () => {
  await seats?.stop()
  await k?.stop({ budgetMs: 0 })
})

const agentOf = (ws: Workspace): AgentDef | undefined => k.team.agentOf(ws.projectId, ws.agentId)
const toolsFor = (s: { ws: Workspace; chatId: string }) => k.tools.toolsFor(s.ws, agentOf(s.ws), k.store.chat(s.chatId)!)

async function connect(token: string) {
  const client = new Client({ name: 'seat-test', version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(seats.url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }

/** A raw POST, so a test can set the Host header, which fetch does not allow. */
function post(headers: Record<string, string>, body: unknown = initialize): Promise<number> {
  const u = new URL(seats.url!)
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('tools over HTTP for a seat', () => {
  it('lists and calls the tools of the seat with a valid token', async () => {
    const client = await connect(seats.makeToken(lead.chatId))
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('list_workspaces')
      expect(client.getInstructions()).toBe(LEAD_INSTRUCTIONS)
      const r = await client.callTool({ name: 'list_workspaces', arguments: {} })
      expect(r.isError).toBeFalsy()
      expect(JSON.stringify(r.content)).toContain('feat/cart')
    } finally { await client.close() }
  })

  it('serves the same tools as toolsFor for a Lead, a Build here and a teammate seat', async () => {
    expect(seats.roleOf(lead.chatId)).toBe('lead')
    expect(seats.roleOf(build.chatId)).toBe('build')
    expect(seats.roleOf(mate.chatId)).toBe('teammate')
    const lists: string[][] = []
    for (const s of [lead, build, mate]) {
      const client = await connect(seats.makeToken(s.chatId))
      try {
        const over = (await client.listTools()).tools
        const own = toolsFor(s)
        expect(over.map((t) => t.name)).toEqual(own.map((t) => t.name))
        expect(over.map((t) => t.description)).toEqual(own.map((t) => t.description))
        for (const t of over) expect(Object.keys(t.inputSchema.properties ?? {}), t.name).toEqual(Object.keys(own.find((x) => x.name === t.name)!.inputSchema))
        lists.push(over.map((t) => t.name))
      } finally { await client.close() }
    }
    expect(lists[0]).not.toEqual(lists[2])
    expect(lists[2]).toContain('ask_lead')
  })

  it('refuses a missing token, an unknown one, another tab\'s after revoke, a revoked one and a foreign Host', async () => {
    const token = seats.makeToken(lead.chatId)
    const other = seats.makeToken(mate.chatId)
    expect(await post({ authorization: `Bearer ${token}` })).toBe(200)
    expect(await post({})).toBe(401)
    expect(await post({ authorization: 'Bearer nope' })).toBe(401)
    expect(await post({ authorization: token })).toBe(401)
    expect(await post({ authorization: `Bearer ${token}`, host: 'evil.example:80' })).toBe(401)
    expect(await post({ authorization: `Bearer ${token}`, host: `localhost:${new URL(seats.url!).port}` })).toBe(200)

    const client = await connect(other)
    try { expect((await client.listTools()).tools.map((t) => t.name)).toContain('ask_lead') } finally { await client.close() }
    expect(seats.revokeToken(other)).toBe(true)
    expect(await post({ authorization: `Bearer ${other}` })).toBe(401)
    expect(await post({ authorization: `Bearer ${token}` })).toBe(200)

    seats.revokeChat(lead.chatId)
    expect(await post({ authorization: `Bearer ${token}` })).toBe(401)
  })

  it('gives each tab only its own tools, and a new token for a chat ends its old one', async () => {
    const first = seats.makeToken(mate.chatId)
    const second = seats.makeToken(mate.chatId)
    expect(await post({ authorization: `Bearer ${first}` })).toBe(401)
    expect(await post({ authorization: `Bearer ${second}` })).toBe(200)
    const client = await connect(second)
    try { expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('create_workspace') } finally { await client.close() }
  })

  it('revokes with the workspace and at stop, and finds no tools for a seat whose workspace is gone', async () => {
    const t = seats.makeToken(mate.chatId)
    expect(seats.revokeWorkspace(mate.ws.id)).toBe(1)
    expect(await post({ authorization: `Bearer ${t}` })).toBe(401)
    const gone = seats.registry.make({ chatId: 'nope', workspaceId: 'nope', role: 'teammate' })
    expect(await post({ authorization: `Bearer ${gone}` })).toBe(404)
    seats.registry.revokeAll()
    expect(seats.registry.size).toBe(0)
  })

  it('refuses a foreign Host before routing, on a path that does not exist too', async () => {
    const u = new URL(seats.url!)
    const status = (path: string, host: string) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: u.port, path, method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject)
      req.end('{}')
    })
    expect(await status('/other', 'evil.example:80')).toBe(401)
    expect(await status('/other', `127.0.0.1:${u.port}`)).toBe(404)
  })

  it('refuses a request whose token was revoked or replaced while its body was still arriving', async () => {
    const u = new URL(seats.url!)
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const slow = (token: string) => {
      const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })
      const done = new Promise<number>((resolve, reject) => { req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) }); req.on('error', reject) })
      req.write(list.slice(0, 10))
      return { finish: () => req.end(list.slice(10)), done }
    }
    const revoked = seats.makeToken(lead.chatId)
    const a = slow(revoked)
    await new Promise((r) => setTimeout(r, 50))
    seats.revokeToken(revoked)
    a.finish()
    expect(await a.done).toBe(401)

    const old = seats.makeToken(mate.chatId)
    const b = slow(old)
    await new Promise((r) => setTimeout(r, 50))
    seats.makeToken(mate.chatId)
    b.finish()
    expect(await b.done).toBe(401)

    const live = seats.makeToken(lead.chatId)
    const c = slow(live)
    c.finish()
    expect(await c.done).toBe(200)
  })

  it('refuses a non-JSON post and any other method or path', async () => {
    const token = seats.makeToken(lead.chatId)
    expect(await post({ authorization: `Bearer ${token}`, 'content-type': 'text/plain' })).toBe(415)
    const base = seats.url!
    expect((await fetch(base, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405)
    expect((await fetch(base.replace('/mcp', '/other'), { method: 'POST' })).status).toBe(404)
  })

  it('ends two merges of one PR, one in process and one over HTTP, in one merge and one refusal', async () => {
    const w = mate.ws
    await writeFile(join(w.path, 'cart.ts'), 'export const cart = []\n')
    await git(w.path, 'add', '-A')
    await git(w.path, 'commit', '-q', '-m', 'feat: cart')
    await k.prs.refreshPr(w.id)
    const token = seats.makeToken(lead.chatId)
    const client = await connect(token)
    try {
      const inProcess = toolsFor(lead).find((t) => t.name === 'merge_workspace')!
      const text = (r: object) => ((r as { content: unknown }).content as { text: string }[])[0].text
      const [a, b] = await Promise.all([
        inProcess.handler({ workspace_ids: [w.id] } as never, {}).then(text),
        client.callTool({ name: 'merge_workspace', arguments: { workspace_ids: [w.id] } }).then(text)
      ])
      const results = [a, b]
      expect(results.filter((r) => r.startsWith('Merged'))).toHaveLength(1)
      expect(results.filter((r) => r.startsWith('Skipped'))).toHaveLength(1)
      const merges = (await git(repo, 'log', '--merges', '--format=%s')).trim().split('\n').filter(Boolean)
      expect(merges).toHaveLength(1)
    } finally { await client.close() }
  })
})

describe('SeatRegistry', () => {
  it('looks a token up and forgets it once revoked', () => {
    const r = new SeatRegistry()
    const t = r.make({ chatId: 'c', workspaceId: 'w', role: 'lead' })
    expect(r.seatOf(t)).toEqual({ chatId: 'c', workspaceId: 'w', role: 'lead' })
    expect(r.seatOf(undefined)).toBeUndefined()
    expect(r.seatOf('')).toBeUndefined()
    expect(r.seatOf([t])).toBeUndefined()
    expect(r.revoke(t)).toBe(true)
    expect(r.seatOf(t)).toBeUndefined()
    expect(r.revoke(t)).toBe(false)
  })
})
