import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Kernel } from '../src/main/kernel'
import { Store, KEEP_RECEIPT_MS } from '../src/main/db'
import { kernelServer } from '../src/main/services/kernelServer'
import { callIdOf, withReceipts } from '../src/main/services/toolReceipts'
import { callTool } from '../src/main/services/providers/codex/tools'
import { freePort, tempRepo } from './helpers'

// Durable tool calls (docs/decisions/durable-tool-calls.md): a repeat of a call id answers from its receipt.

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const meta = (id: string) => ({ _meta: { 'claudecode/toolUseId': id } })
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text

/** A tool that counts how often it really ran. */
function counted() {
  const ran: string[] = []
  const tools = [
    tool('do_it', 'Does it.', { what: z.string() }, async ({ what }) => { ran.push(what); return { content: [{ type: 'text' as const, text: `did ${what} #${ran.length}` }] } }),
    tool('refuse', 'Refuses.', {}, async () => { ran.push('refuse'); return { content: [{ type: 'text' as const, text: 'no' }], isError: true } }),
    tool('list_agents', 'Reads.', {}, async () => { ran.push('list'); return { content: [{ type: 'text' as const, text: 'things' }] } })
  ]
  return { ran, tools }
}

describe('tool receipts', () => {
  it('reads the call id from the SDK server and from Codex', async () => {
    const seen: unknown[] = []
    const server = kernelServer([tool('probe', 'Probe.', {}, async (_a, extra) => { seen.push(extra); return { content: [{ type: 'text' as const, text: 'ok' }] } })])
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    onTestFinished(async () => { await client.close() })
    await client.callTool({ name: 'probe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_abc' } })
    expect(callIdOf(seen[0])).toBe('toolu_abc')
    await client.callTool({ name: 'probe', arguments: {} })
    expect(callIdOf(seen[1])).toBeUndefined()
    expect(callIdOf({ callId: 'call_1' })).toBe('call_1')
    expect(callIdOf({})).toBeUndefined()

    // Codex's callTool passes its callId on to the handler.
    const got: unknown[] = []
    await callTool([tool('probe', 'Probe.', {}, async (_a, extra) => { got.push(extra); return { content: [] } })], 'kernel_probe', {}, { callId: 'call_9' })
    expect(callIdOf(got[0])).toBe('call_9')
  })

  it('answers a repeat of a call id from the first result and runs the tool once', async () => {
    const store = new Store(':memory:')
    const { ran, tools } = counted()
    const wrapped = Object.fromEntries(withReceipts(tools, { chatId: 'c1', store }).map((t) => [t.name, t]))
    const first = await wrapped.do_it.handler({ what: 'a' } as never, meta('t1'))
    const again = await wrapped.do_it.handler({ what: 'a' } as never, meta('t1'))
    expect(text(again as never)).toBe('did a #1')
    expect(again).toEqual(first)
    expect(ran).toEqual(['a'])
    // The key is the id, not the arguments: the same id with other arguments is the same call.
    expect(text(await wrapped.do_it.handler({ what: 'b' } as never, meta('t1')) as never)).toBe('did a #1')
    expect(ran).toEqual(['a'])
    // It holds across a restart: a new wrapper over the same rows still answers.
    const later = Object.fromEntries(withReceipts(tools, { chatId: 'c1', store }).map((t) => [t.name, t]))
    expect(text(await later.do_it.handler({ what: 'a' } as never, meta('t1')) as never)).toBe('did a #1')
    expect(ran).toEqual(['a'])
  })

  it('runs calls with different ids, other chats and no id each time, and never wraps a read', async () => {
    const store = new Store(':memory:')
    const { ran, tools } = counted()
    const one = Object.fromEntries(withReceipts(tools, { chatId: 'c1', store }).map((t) => [t.name, t]))
    const two = Object.fromEntries(withReceipts(tools, { chatId: 'c2', store }).map((t) => [t.name, t]))
    await one.do_it.handler({ what: 'a' } as never, meta('t1'))
    await one.do_it.handler({ what: 'b' } as never, meta('t2'))
    await two.do_it.handler({ what: 'c' } as never, meta('t1'))
    await one.do_it.handler({ what: 'd' } as never, {})
    await one.do_it.handler({ what: 'e' } as never, {})
    expect(ran).toEqual(['a', 'b', 'c', 'd', 'e'])
    await one.list_agents.handler({} as never, meta('t3'))
    await one.list_agents.handler({} as never, meta('t3'))
    expect(ran.slice(5)).toEqual(['list', 'list'])
    expect(store.toolReceipt('c1', 't3')).toBeUndefined()
  })

  it('stores nothing for a refusal or a stopped turn, so a repeat tries again', async () => {
    const store = new Store(':memory:')
    const { ran, tools } = counted()
    const t = Object.fromEntries(withReceipts(tools, { chatId: 'c1', store }).map((x) => [x.name, x]))
    await t.refuse.handler({} as never, meta('t1'))
    await t.refuse.handler({} as never, meta('t1'))
    expect(ran).toEqual(['refuse', 'refuse'])
    const stop = new AbortController()
    stop.abort()
    await t.do_it.handler({ what: 'a' } as never, { ...meta('t2'), signal: stop.signal })
    await t.do_it.handler({ what: 'a' } as never, meta('t2'))
    expect(ran.slice(2)).toEqual(['a', 'a'])
    expect(store.toolReceipt('c1', 't2')).toMatchObject({ tool: 'do_it' })
  })

  it('shares one run between two calls with one id at the same time', async () => {
    const store = new Store(':memory:')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let runs = 0
    const slow = tool('slow', 'Slow.', {}, async () => { runs++; await gate; return { content: [{ type: 'text' as const, text: 'done' }] } })
    const [t] = withReceipts([slow], { chatId: 'c1', store })
    const a = t.handler({} as never, meta('t1'))
    const b = t.handler({} as never, meta('t1'))
    release()
    expect(text(await a as never)).toBe('done')
    expect(text(await b as never)).toBe('done')
    expect(runs).toBe(1)
  })

  it('goes after 30 days, at start, and with its chat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-receipts-'))
    const file = join(dir, 'kernel.db')
    const store = new Store(file)
    const now = Date.now()
    store.saveToolReceipt({ chatId: 'c1', callId: 'old', tool: 'do_it', result: '{}', createdAt: now - KEEP_RECEIPT_MS - 1000 })
    store.saveToolReceipt({ chatId: 'c1', callId: 'new', tool: 'do_it', result: '{}', createdAt: now - KEEP_RECEIPT_MS + 60_000 })
    store.saveToolReceipt({ chatId: 'c1', callId: 'new', tool: 'other', result: '{"x":1}' })
    expect(store.toolReceipt('c1', 'new')?.tool).toBe('do_it')
    store.db.close()
    // The next start prunes.
    const next = new Store(file)
    onTestFinished(() => { next.db.close() })
    expect(next.toolReceipt('c1', 'old')).toBeUndefined()
    expect(next.toolReceipt('c1', 'new')).toBeDefined()
    expect(next.pruneReceipts(now + 2 * KEEP_RECEIPT_MS)).toBe(1)
    next.saveChat({ id: 'c1', workspaceId: 'w1', title: 'x', createdAt: 1 } as never)
    next.saveToolReceipt({ chatId: 'c1', callId: 'kept', tool: 'do_it', result: '{}' })
    next.deleteChats(['c1'])
    expect(next.toolReceipt('c1', 'kept')).toBeUndefined()
  })
})

describe("Kernel's own tools", () => {
  async function boot() {
    const repo = await tempRepo({
      'README.md': '# shop\n',
      '.claude/agents/web.md': '---\nname: web\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash, Grep, Glob\n---\nYou build the UI.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home, starterDir: join(__dirname, '..', 'docs', 'starter-agents') })
    k.signedInReader = async () => true
    await k.start()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    k.sessions.send = async () => ({ queued: false })
    const project = await k.addProject(repo)
    const chat = await k.leadChat(project.id)
    const agent = (await k.agents(project.id)).find((a) => a.lead)!
    const tools = Object.fromEntries(k.tools.toolsFor(k.store.workspace(chat.workspaceId)!, agent, chat).map((t) => [t.name, t]))
    return { k, project, tools }
  }

  it('create_workspace with a repeated call id makes one workspace, and a new id makes another', async () => {
    const { k, project, tools } = await boot()
    const args = { agent: 'web', title: 'Cart page', brief: 'Build the cart page.' }
    const before = k.store.workspaces(project.id).length
    const first = await tools.create_workspace.handler(args as never, meta('toolu_1'))
    const again = await tools.create_workspace.handler(args as never, meta('toolu_1'))
    expect(text(again as never)).toBe(text(first as never))
    expect(text(first as never)).toMatch(/^Created /)
    expect(k.store.workspaces(project.id)).toHaveLength(before + 1)
    await tools.create_workspace.handler({ ...args, title: 'Checkout page' } as never, meta('toolu_2'))
    expect(k.store.workspaces(project.id)).toHaveLength(before + 2)
  })
})
