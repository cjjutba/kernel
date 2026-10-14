import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatPart, OpenItem, TeamUpdate, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { migrate, migrations } from '../src/main/migrations'
import { Kernel } from '../src/main/kernel'
import { kernelTools } from '../src/main/services/kernelMcp'
import { teammateTools } from '../src/main/services/teammateMcp'
import type { TeamEvent } from '../src/main/services/leadUpdates'
import { openReminder } from '../src/main/features/openItems'
import { tempRepo } from './helpers'

// KERNEL-749: Kernel holds the Lead to what its chat owes: a teammate's question, a review's blockers, a proposed hand-off and
// a teammate the user addressed. Each opens on its real event, closes when the Lead acts on it, and survives a restart.

// A scripted SDK, as in teammateAsk.test.ts. `tool` keeps the handler so the tools can run against a real Kernel.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (o: { name: string; tools: { name: string }[] }) => ({ name: o.name, tools: o.tools.map((t) => t.name) }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  query: ({ options }: { options: unknown }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    sdk.calls.push({ options, feed: (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 10 })
    }
  }
}))

const SLOW = { timeout: 10_000 }
const AGENT = (id: string, extra = '') => `---\nname: ${id}\ndescription: ${id}.\n${extra}---\nYou are ${id}. You build tasks and open pull requests.`
const result = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1, session_id: 's' })
const callsIn = (ws: Workspace) => sdk.calls.filter((c) => c.options.cwd === ws.path)

async function start(dataDir: string, home: string) {
  const k = new Kernel({ dataDir, home })
  await k.start()
  const posts: { chatId: string; text: string; update?: TeamUpdate }[] = []
  k.sessions.post = (chatId: string, parts: ChatPart[], o: { update?: TeamUpdate } = {}) => { posts.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), update: o.update }); return true }
  ;(k.leadUpdates as unknown as { d: { delayMs?: number } }).d.delayMs = 20
  return { k, posts }
}

/** A room with Kai and Noor at work, both handed off from the same Lead tab. */
async function setup() {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kernel.md': AGENT('kernel', 'lead: true\n'), '.claude/agents/kai.md': AGENT('kai'), '.claude/agents/noor.md': AGENT('noor') })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const { k, posts } = await start(dataDir, home)
  const room = await k.addRoom(repo)
  const lead = await k.leadChat(room.id)
  const kai = await k.createWorkspace(room.id, { prompt: 'Build the export', agentId: 'kai', title: 'Invoice export', leadChatId: lead.id })
  const noor = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'noor', title: 'Invoice table', leadChatId: lead.id })
  const teammate = (ws: Workspace, name: 'ask_lead' | 'propose_handoff', input: Record<string, unknown>) =>
    teammateTools(k.waits['teammateToolDeps'](ws.id)).find((x) => x.name === name)!.handler(input as never, {})
  const leadTool = async (name: string, input: Record<string, unknown>) => {
    const agent = (await k.agents(room.id)).find((a) => a.lead)!
    const r = await kernelTools(k.lead.leadToolDeps(room.id, agent, k.store.chat(lead.id)!)).find((t) => t.name === name)!.handler(input as never, {})
    return (r.content[0] as { text: string }).text
  }
  const kinds = (chatId = lead.id) => k.openItems.owed(chatId).map((i) => `${i.kind} ${i.name}`)
  return { k, dataDir, home, room, lead, kai, noor, posts, teammate, leadTool, kinds }
}

type Setup = Awaited<ReturnType<typeof setup>>
let n = 0
const ev = (ws: Workspace, e: Omit<TeamEvent, 'n' | 'workspaceId'>): TeamEvent => ({ n: n++, workspaceId: ws.id, ...e })
const question = (s: Setup, ws: Workspace, text = 'Keep drafts per tab?') => s.k.openItems.delivered(s.k.store.chat(s.lead.id)!, [{ ws, name: ws.agentId === 'kai' ? 'Kai' : 'Noor', events: [ev(ws, { kind: 'question', question: { text } })] }])
const proposal = (s: Setup, ws: Workspace, to: { agentId: string; agent: string }) =>
  s.k.openItems.delivered(s.k.store.chat(s.lead.id)!, [{ ws, name: 'Noor', events: [ev(ws, { kind: 'handoff.proposed', proposal: { ...to, task: 'Add the export button', why: 'It is UI' } })] }])
const blockers = (s: Setup, of: Workspace, o: { current?: boolean; verdict?: 'blockers' | 'approved' } = {}) =>
  s.k.openItems.delivered(s.k.store.chat(s.lead.id)!, [{ ws: s.noor, name: 'Noor', events: [ev(s.noor, { kind: 'review', review: { verdict: o.verdict ?? 'blockers', summary: 'Two problems', blockers: [{ text: 'a' }, { text: 'b' }], total: 2, of: of.id, ofName: of.agentId === 'kai' ? 'Kai' : 'Noor', current: o.current ?? true } })] }])

describe('open items open on real events (KERNEL-749)', () => {
  it("opens a teammate's question once the Team update that carries it reaches the Lead, not before", async () => {
    const s = await setup()
    await s.teammate(s.kai, 'ask_lead', { question: 'Keep drafts per tab or one per chat?' })
    expect(s.kinds()).toEqual([])
    callsIn(s.kai)[0].feed(result('r1'))
    await vi.waitFor(() => expect(s.posts).toHaveLength(1), SLOW)
    expect(s.k.openItems.owed(s.lead.id)).toEqual([expect.objectContaining({ kind: 'question', workspaceId: s.kai.id, agentId: 'kai', text: 'Keep drafts per tab or one per chat?', threadId: s.k.store.chat(s.lead.id)!.threadId })])
  }, 20_000)

  it('opens a proposed hand-off and current blockers from the update, and nothing for an approval or a stale verdict', async () => {
    const s = await setup()
    await s.teammate(s.noor, 'propose_handoff', { agent: 'kai', task: 'Add the export button', why: 'It is UI work' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1), SLOW)
    expect(s.k.openItems.owed(s.lead.id)).toEqual([expect.objectContaining({ kind: 'handoff.proposed', workspaceId: s.noor.id, proposed: { agentId: 'kai', name: 'Kai' }, text: 'Add the export button' })])
    blockers(s, s.kai, { verdict: 'approved' })
    blockers(s, s.kai, { current: false })
    expect(s.kinds()).toEqual(['handoff.proposed Noor'])
    blockers(s, s.kai)
    expect(s.k.openItems.owed(s.lead.id).at(-1)).toMatchObject({ kind: 'blockers', workspaceId: s.kai.id, name: 'Kai', blockers: 2 })
  }, 20_000)

  it('keeps one question per workspace, the newest', async () => {
    const s = await setup()
    question(s, s.kai, 'First?')
    question(s, s.kai, 'Second?')
    expect(s.k.openItems.owed(s.lead.id).map((i) => i.text)).toEqual(['Second?'])
  }, 20_000)
})

describe('open items close when the Lead acts or the user dismisses them (KERNEL-749)', () => {
  it("message_agent closes what the chat owes that workspace, and nothing else's", async () => {
    const s = await setup()
    question(s, s.kai)
    blockers(s, s.kai)
    question(s, s.noor)
    expect(await s.leadTool('message_agent', { workspace_id: s.kai.id, text: 'Per tab. And fix the two blockers.' })).not.toMatch(/^Not sent/)
    expect(s.kinds()).toEqual(['question Noor'])
  }, 20_000)

  it('create_workspace for the proposed teammate closes the proposal', async () => {
    const s = await setup()
    proposal(s, s.noor, { agentId: 'kai', agent: 'Kai' })
    s.k.openItems.created(s.lead.id, 'noor')
    expect(s.kinds()).toEqual(['handoff.proposed Noor'])
    s.k.openItems.created(s.lead.id, 'kai')
    expect(s.kinds()).toEqual([])
  }, 20_000)

  it('ask_user about a workspace closes its question and proposal but never its blockers', async () => {
    const s = await setup()
    question(s, s.kai)
    blockers(s, s.kai)
    proposal(s, s.noor, { agentId: 'kai', agent: 'Kai' })
    s.k.openItems.asked(s.lead.id)
    expect(s.kinds()).toEqual(['question Kai', 'blockers Kai', 'handoff.proposed Noor'])
    s.k.openItems.asked(s.lead.id, [s.kai.id, 'noor'])
    expect(s.kinds()).toEqual(['blockers Kai'])
  }, 20_000)

  it('ask_user without about closes the mentions of its tab, and the user writing again does too', async () => {
    const s = await setup()
    const chat = s.k.store.chat(s.lead.id)!
    s.k.openItems.mentioned(chat, [{ agentId: 'kai', name: 'Kai' }])
    s.k.openItems.asked(s.lead.id)
    expect(s.kinds()).toEqual([])
    s.k.openItems.mentioned(chat, [{ agentId: 'kai', name: 'Kai' }])
    s.k.openItems.userSent(s.lead.id)
    expect(s.kinds()).toEqual([])
  }, 20_000)

  it('the user dismisses an item', async () => {
    const s = await setup()
    question(s, s.kai)
    const threadId = s.k.store.chat(s.lead.id)!.threadId!
    const [item] = await s.k.handlers()['openItems.list']({ threadId })
    expect(await s.k.handlers()['openItems.dismiss']({ id: item.id })).toEqual({ ok: true })
    expect(await s.k.handlers()['openItems.list']({ threadId })).toEqual([])
  }, 20_000)

  it("an archived workspace's items close, since nobody is left to answer", async () => {
    const s = await setup()
    question(s, s.kai)
    s.k.store.saveWorkspace({ ...s.k.store.workspace(s.kai.id)!, status: 'archived' })
    expect(s.kinds()).toEqual([])
    expect(s.k.store.openItems(s.k.store.chat(s.lead.id)!.threadId!)).toEqual([])
  }, 20_000)
})

describe('the reminder at Stop (KERNEL-749)', () => {
  it('lists what is open once, and again with everything only after a new item opens', async () => {
    const s = await setup()
    expect(s.k.openItems.atStop(s.lead.id)).toBeUndefined()
    question(s, s.kai)
    const first = s.k.openItems.atStop(s.lead.id)
    expect(first).toBe(openReminder(s.k.openItems.owed(s.lead.id)))
    expect(first).toContain(`Kai asked you: "Keep drafts per tab?" (workspace ${s.kai.id}). Answer with mcp__kernel__message_agent to it.`)
    expect(s.k.openItems.atStop(s.lead.id)).toBeUndefined()
    blockers(s, s.noor)
    const second = s.k.openItems.atStop(s.lead.id)!
    expect(second).toContain('Kai asked you')
    expect(second).toContain(`A review found 2 blockers in Noor's work (workspace ${s.noor.id})`)
    expect(s.k.openItems.atStop(s.lead.id)).toBeUndefined()
  }, 20_000)

  it("goes to every tab of the Lead chat, with a mention only in its own tab's", async () => {
    const s = await setup()
    const chat = s.k.store.chat(s.lead.id)!
    const tab: Chat = { ...chat, id: 'tab-2', createdAt: chat.createdAt + 1 }
    s.k.store.saveChat(tab)
    s.k.openItems.mentioned(tab, [{ agentId: 'noor', name: 'Noor' }])
    question(s, s.kai)
    expect(s.kinds()).toEqual(['question Kai'])
    expect(s.kinds(tab.id)).toEqual(['mention Noor', 'question Kai'])
    const reminder = s.k.openItems.atStop(tab.id)!
    expect(reminder).toContain('The user addressed their message to Noor.')
    // The other tab already heard the question in that reminder.
    expect(s.k.openItems.atStop(s.lead.id)).toBeUndefined()
  }, 20_000)

  it('list_workspaces marks the workspaces the chat owes something', async () => {
    const s = await setup()
    question(s, s.kai)
    blockers(s, s.kai)
    const listed = (await s.leadTool('list_workspaces', {})).split('\n')
    expect(listed.find((l) => l.startsWith(s.kai.id))).toMatch(/ · yours · open: question, blockers to pass on$/)
    expect(listed.find((l) => l.startsWith(s.noor.id))).not.toContain('open:')
  }, 20_000)
})

describe('open items survive a restart (KERNEL-749)', () => {
  it('keeps what is open and what the Lead was reminded of', async () => {
    const s = await setup()
    question(s, s.kai)
    expect(s.k.openItems.atStop(s.lead.id)).toBeDefined()
    proposal(s, s.noor, { agentId: 'kai', agent: 'Kai' })
    const before: OpenItem[] = s.k.openItems.owed(s.lead.id)
    await s.k.stop()
    const again = await start(s.dataDir, s.home)
    try {
      expect(again.k.openItems.owed(s.lead.id)).toEqual(before)
      // The question was reminded before the restart; the proposal wasn't, so it reminds now, with both.
      const reminder = again.k.openItems.atStop(s.lead.id)!
      expect(reminder).toContain('Kai asked you')
      expect(reminder).toContain('Noor proposed handing "Add the export button" to Kai')
      expect(again.k.openItems.atStop(s.lead.id)).toBeUndefined()
    } finally { await again.k.stop() }
  }, 20_000)
})

describe('open items go with their Lead chat (KERNEL-791)', () => {
  it('deleting the Lead chat from History leaves none of its items behind', async () => {
    const s = await setup()
    question(s, s.kai)
    s.k.openItems.mentioned(s.k.store.chat(s.lead.id)!, [{ agentId: 'noor', name: 'Noor' }])
    const ws = s.k.store.workspace(s.lead.workspaceId)!
    const threadId = ws.threadId!
    expect(await s.k.handlers()['openItems.list']({ threadId })).toHaveLength(2)
    await s.k.archive.archiveWorkspace(ws.id, false, { noScript: true })
    expect(await s.k.history.deleteWorkspaces([ws.id], { deleteUnpushed: true })).toMatchObject({ deleted: [ws.id] })
    expect(s.k.store.thread(threadId)).toBeUndefined()
    expect(await s.k.handlers()['openItems.list']({ threadId })).toEqual([])
    expect((s.k.store as unknown as { db: Database.Database }).db.prepare('select count(*) n from open_items where thread_id = ?').get(threadId)).toEqual({ n: 0 })
    await s.k.stop({ budgetMs: 0 })
  }, 20_000)

  it('the migration deletes the items of Lead chats deleted before', () => {
    const db = new Database(':memory:')
    migrate(db, ':memory:', Date.now(), migrations.filter((m) => m.version <= 6))
    db.prepare('insert into threads (id, room_id, data, created_at) values (?, ?, ?, ?)').run('kept', 'r', '{}', 1)
    const item = db.prepare('insert into open_items (id, thread_id, room_id, key, data, created_at) values (?, ?, ?, ?, ?, ?)')
    item.run('a', 'kept', 'r', 'k', '{}', 1)
    item.run('b', 'gone', 'r', 'k', '{}', 1)
    migrate(db, ':memory:')
    expect(db.prepare('select id from open_items').all()).toEqual([{ id: 'a' }])
    db.close()
  })
})

describe('the window hears when open items change (KERNEL-791)', () => {
  it('pushes openItems.changed once per open, close and dismiss, and not when nothing changed', async () => {
    const s = await setup()
    const threadId = s.k.store.chat(s.lead.id)!.threadId!
    const seen: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'openItems.changed') seen.push(e.threadId) }
    bus.on('push', on)
    try {
      question(s, s.kai)
      blockers(s, s.kai)
      question(s, s.noor)
      expect(seen).toEqual([threadId, threadId, threadId])
      // Two items close in one go, one push.
      s.k.openItems.messaged(s.lead.id, s.kai)
      expect(seen).toHaveLength(4)
      s.k.openItems.messaged(s.lead.id, s.kai)
      s.k.openItems.dismiss('no-such-item')
      expect(seen).toHaveLength(4)
      const [left] = s.k.store.openItems(threadId)
      await s.k.handlers()['openItems.dismiss']({ id: left.id })
      expect(seen).toHaveLength(5)
      // An archived workspace's items close when the chat next reads what it owes.
      question(s, s.kai)
      s.k.store.saveWorkspace({ ...s.k.store.workspace(s.kai.id)!, status: 'archived' })
      expect(s.kinds()).toEqual([])
      expect(seen).toHaveLength(7)
      expect(s.kinds()).toEqual([])
      expect(seen).toHaveLength(7)
    } finally { bus.off('push', on); await s.k.stop({ budgetMs: 0 }) }
  }, 20_000)
})
