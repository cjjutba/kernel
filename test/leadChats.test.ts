import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Approval, Chat, ChatPart, PrCheck, PrState } from '@shared/types'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import type { QueueReason } from '../src/main/services/sessions'
import { Nudges } from '../src/main/services/nudges'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { tempRepo, trustRoom } from './helpers'

// KERNEL-105: with several chats open with the Lead, each workspace reports to the chat that handed it off.

// Keeps the deps the Kernel hands the Lead's server, so the tests can call one chat's tools. With sharing on, the
// server is built from kernelTools next to share_file rather than by kernelMcpServer (KERNEL-308), so both keep them.
let wired: KernelToolDeps | undefined
vi.mock('../src/main/services/kernelMcp', async (original) => {
  const m = await original<typeof import('../src/main/services/kernelMcp')>()
  return {
    ...m,
    kernelMcpServer: (d: KernelToolDeps) => { wired = d; return m.kernelMcpServer(d) },
    kernelTools: (d: KernelToolDeps) => { wired = d; return m.kernelTools(d) }
  }
})

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

async function dirs() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  return { dataDir, home }
}

/** A started Kernel on a temp repo with two Lead chats, `first` and `icons`. Sends are recorded, not run. */
async function setup(files: Record<string, string> = {}) {
  const repo = await tempRepo({ ...REPO, ...files })
  const where = await dirs()
  const k = new Kernel(where)
  await k.start()
  onTestFinished(() => k.stop())
  const sent: { chatId: string; text: string; from?: string }[] = []
  // What the next send answers, for the queue cases.
  const answer: { queued: boolean; why?: QueueReason } = { queued: false }
  k.sessions.send = async (chatId: string, parts: ChatPart[], o?: { from?: string }) => { sent.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), from: o?.from }); return { ...answer } }
  const room = await k.addRoom(repo)
  await trustRoom(k, room.id)
  const first = await k.leadChat(room.id)
  const icons = k.newChat(first.workspaceId, 'Chat icons sizing', { model: first.model, effort: first.effort, plan: false })
  const rowan = (await k.agents(room.id)).find((a) => a.lead) as AgentDef
  const run = async (chat: Chat, name: string, args: Record<string, unknown>) => {
    k.lead['leadTools'](room.id, rowan, chat)
    const tool = kernelTools(wired!).find((t) => t.name === name)!
    const r = await tool.handler(args as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  const call = async (chat: Chat, name: string, args: Record<string, unknown>) => (await run(chat, name, args)).text
  const byTitle = (title: string) => k.store.workspaces(room.id).find((w) => w.title === title)!
  const target = (owner?: string) => k.lead['leadUpdateTarget'](room.id, owner) as { chat: Chat; from?: { title: string; tab?: boolean } } | undefined
  /** A tab the + button opens in the Lead's workspace, in the Lead chat `threadId` or a new one (KERNEL-337). */
  const tab = (threadId?: string) => k.handlers()['chats.create']({ workspaceId: first.workspaceId, threadId })
  return { k, room, first, icons, call, run, byTitle, target, tab, sent, answer, where, rowan }
}

describe('Lead chats and the work they hand off (KERNEL-105)', () => {
  it('stamps each workspace with the chat that created it, and Restore keeps it', async () => {
    const { k, first, icons, call, byTitle } = await setup()
    expect(await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })).toMatch(/^Created /)
    await call(icons, 'create_workspace', { agent: 'kai', title: 'Chat tab state icons', brief: 'Go' })
    expect(byTitle('Drafts per chat').leadChatId).toBe(first.id)
    const iconsWs = byTitle('Chat tab state icons')
    expect(iconsWs.leadChatId).toBe(icons.id)
    await k.archiveWorkspace(iconsWs.id)
    expect((await k.restoreWorkspace(iconsWs.id)).leadChatId).toBe(icons.id)
  })

  it("links the plan step and board task from the calling chat's plan, not a newer plan from another chat", async () => {
    const { k, room, first, icons, call, byTitle } = await setup()
    const plan = (id: string, chat: Chat, createdAt: number) => k.store.saveApproval({
      id, kind: 'plan', source: 'sdk', roomId: room.id, workspaceId: chat.workspaceId, chatId: chat.id, agentId: 'rowan', title: id,
      steps: [{ title: `${id} step`, agentId: 'kai' }], status: 'allowed', createdAt
    } as Approval)
    k.tasks.fromPlan(plan('icons-plan', icons, Date.now() - 1000))
    k.tasks.fromPlan(plan('first-plan', first, Date.now()))
    await call(icons, 'create_workspace', { agent: 'kai', title: 'Chat tab state icons', brief: 'Go' })
    const ws = byTitle('Chat tab state icons')
    const step = (id: string) => k.store.approvals({ roomId: room.id }).find((a) => a.id === id)!.steps![0].workspaceId
    expect(step('icons-plan')).toBe(ws.id)
    expect(step('first-plan')).toBeUndefined()
    const task = (id: string) => k.tasks.list(room.id).find((t) => t.approvalId === id)!
    expect(task('icons-plan').workspaceId).toBe(ws.id)
    expect(task('first-plan').workspaceId).toBeUndefined()
    expect(ws.taskId).toBe(task('icons-plan').id)
  })

  it('sends updates to the open owner, then its newest open fork, then the first Lead chat', async () => {
    const { k, first, icons, target } = await setup()
    expect(target(icons.id)).toEqual({ chat: icons })
    expect(target()).toEqual({ chat: first })
    k.closeChat(icons.id)
    expect(target(icons.id)).toEqual({ chat: first, from: { title: 'Chat icons sizing' } })
    const fork = k.store.saveChat({ ...k.newChat(first.workspaceId, 'Fork of Chat icons sizing', { model: first.model, effort: first.effort, plan: false }), forkOf: { chatId: icons.id, itemId: '' } })
    expect(target(icons.id)).toEqual({ chat: fork })
    // A Lead workspace that was archived has nobody left to tell.
    k.store.saveWorkspace({ ...k.store.workspace(first.workspaceId)!, status: 'archived' })
    expect(target(icons.id)).toBeUndefined()
    expect(target()).toBeUndefined()
  })

  it("marks this chat's workspaces in list_workspaces, and says where another chat's workspace reports", async () => {
    const { k, room, first, icons, call, byTitle } = await setup()
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    await call(icons, 'create_workspace', { agent: 'kai', title: 'Chat tab state icons', brief: 'Go' })
    const mine = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Made by hand' })
    const drafts = byTitle('Drafts per chat')
    const iconsWs = byTitle('Chat tab state icons')
    const lines = (await call(first, 'list_workspaces', {})).split('\n')
    expect(lines.find((l) => l.startsWith(drafts.id))).toMatch(/ · yours$/)
    expect(lines.find((l) => l.startsWith(iconsWs.id))).toMatch(/ · from Lead chat "Chat icons sizing"$/)
    expect(lines.find((l) => l.startsWith(mine.id))).toMatch(/PR none$/)
    expect(await call(first, 'message_agent', { workspace_id: drafts.id, text: 'Rebase on main.' })).toBe('Sent.')
    expect(await call(first, 'message_agent', { workspace_id: iconsWs.id, text: 'Rebase on main.' }))
      .toBe('Sent. This workspace was handed off in the Lead chat "Chat icons sizing", so its updates go there, not here.')
    expect(k.store.workspace(iconsWs.id)!.leadChatId).toBe(icons.id)
  })

  it('asks the chat that handed off the newer workspace to sort out an overlap, and names the other chat', async () => {
    const { k, room, first, icons, call, byTitle, sent } = await setup()
    await call(first, 'create_workspace', { agent: 'kai', title: 'Pasted text preview', brief: 'Go' })
    await call(icons, 'create_workspace', { agent: 'kai', title: 'Chat tab state icons', brief: 'Go' })
    const older = byTitle('Pasted text preview')
    const newer = byTitle('Chat tab state icons')
    k['overlaps']['known'].set('o1', { id: 'o1', roomId: room.id, path: 'src/renderer/src/components/ChatTabs.tsx', ts: 1, parties: [
      { agentId: 'kai', workspaceId: older.id, lines: '+3 -1' }, { agentId: 'kai', workspaceId: newer.id, lines: '+5 -2' }
    ] })
    sent.length = 0
    await k.sortOverlap('o1')
    expect(sent.map((s) => s.chatId)).toEqual([icons.id])
    expect(sent[0].text).toContain('Part of this work was handed off in another Lead chat: "Lead".')
  })
})

describe('backfilling the Lead chat on workspaces from before KERNEL-105', () => {
  it("stamps each workspace a chat's create_workspace made, once, and leaves stamped and unplaced ones alone", async () => {
    const repo = await tempRepo(REPO)
    const d = await dirs()
    const old = new Kernel(d)
    await old.start()
    old.sessions.send = async () => ({ queued: false })
    const room = await old.addRoom(repo)
    const lead = await old.leadChat(room.id)
    const handed = await old.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Old hand-off' })
    const stamped = await old.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Stamped', leadChatId: 'elsewhere' })
    const failed = await old.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Failed call' })
    const item = (id: string, wsId: string, status: 'done' | 'failed') => old.store.saveItem(lead.id, {
      kind: 'tool', id, ts: 1, toolUseId: id, name: 'mcp__kernel__create_workspace', label: '', detail: '', status, output: `Created ${wsId} on some-branch for kai.`
    })
    item('t1', handed.id, 'done'); item('t2', stamped.id, 'done'); item('t3', failed.id, 'failed')
    // As if this database came from a version before the field existed.
    old.store.saveMeta('leadChatBackfill', false)
    await old.stop()

    const k = new Kernel(d)
    await k.start()
    onTestFinished(() => k.stop())
    expect(k.store.workspace(handed.id)!.leadChatId).toBe(lead.id)
    expect(k.store.workspace(stamped.id)!.leadChatId).toBe('elsewhere')
    expect(k.store.workspace(failed.id)!.leadChatId).toBeUndefined()
    expect(k.store.meta('leadChatBackfill')).toBe(true)
  })
})

describe("marking the Lead's workspace (KERNEL-353)", () => {
  it('marks a new Lead workspace, and marks older ones once, by the Lead agent or by name in a room whose agents did not load', async () => {
    const d = await dirs()
    const old = new Kernel(d)
    await old.start()
    old.sessions.send = async () => ({ queued: false })
    const room = await old.addRoom(await tempRepo(REPO))
    const shut = await old.addRoom(await tempRepo(REPO))
    const lead = old.store.workspace((await old.lead.leadChat(room.id)).workspaceId)!
    const shutLead = old.store.workspace((await old.lead.leadChat(shut.id)).workspaceId)!
    expect(lead.lead).toBe(true)
    // A worktree handed to the Lead when its agent retired is the Lead agent's too, and isn't the Lead's workspace.
    const handed = await old.workspaces.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Handed over' })
    old.store.saveWorkspace({ ...old.store.workspace(handed.id)!, agentId: 'rowan' })
    // As if this database came from a version before the mark existed, when the Lead worked on the main checkout.
    for (const ws of [lead, shutLead]) old.store.saveWorkspace({ ...ws, lead: undefined, mode: 'current', path: old.store.room(ws.roomId)!.path, branch: 'main' })
    old.store.saveRoom({ ...old.store.room(shut.id)!, archived: true })
    old.store.saveMeta('leadWorkspaceBackfill', false)
    await old.stop()

    const k = new Kernel(d)
    await k.start()
    expect(k.team.isLeadWorkspace(k.store.workspace(lead.id)!)).toBe(true)
    expect(k.store.workspace(shutLead.id)!.lead).toBe(true)
    expect(k.store.workspace(handed.id)!.lead).toBeUndefined()
    expect(k.store.meta('leadWorkspaceBackfill')).toBe(true)
    k.store.saveWorkspace({ ...k.store.workspace(lead.id)!, lead: undefined })
    await k.stop()

    const again = new Kernel(d)
    await again.start()
    onTestFinished(() => again.stop())
    expect(again.store.workspace(lead.id)!.lead).toBeUndefined()
  })
})

describe("the Lead's messages in a teammate's chat (KERNEL-116)", () => {
  it("sends the hand-off brief and message_agent as the Lead's, not the user's", async () => {
    const { first, call, byTitle, sent } = await setup()
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Keep one draft per chat.' })
    const ws = byTitle('Drafts per chat')
    expect(sent.at(-1)).toMatchObject({ text: 'Keep one draft per chat.', from: 'lead' })
    await call(first, 'message_agent', { workspace_id: ws.id, text: 'Rebase on main first.' })
    expect(sent.at(-1)).toMatchObject({ text: 'Rebase on main first.', from: 'lead' })
  })
})

describe("create_workspace when the teammate's setup fails (KERNEL-126)", () => {
  it('says so with the exit code after the Created prefix, which the backfill still reads', async () => {
    const { first, call } = await setup({ '.kernel/settings.toml': '[scripts]\nsetup = "exit 3"\n' })
    const said = await call(first, 'create_workspace', { agent: 'kai', title: 'Invoice table', brief: 'Build T-14' })
    expect(said).toMatch(/^Created \S+ on \S+ for kai\. Setup failed \(exit code 3\), so Kai hasn't started\. The brief waits until the user fixes setup and clicks Run again in that workspace\.$/)
    // Kernel's backfill of older chats parses this prefix (backfillLeadChats).
    expect(/^Created (\S+) on /.exec(said)?.[1]).toBeTruthy()
  })
})

describe('create_workspace when every agent slot is in use (KERNEL-272)', () => {
  it("says Kai hasn't started after the Created prefix, while the brief waits in Kai's queue", async () => {
    const { k, first, call, byTitle } = await setup()
    // The real send, so the brief meets the agent limit. One slot, taken by another teammate's running turn.
    delete (k.sessions as { send?: unknown }).send
    k.settings = { ...k.settings, models: { ...k.settings.models, agentLimit: 1 } }
    const live = k.sessions['live'] as Map<string, unknown>
    live.set('busy', { running: true, abort: new AbortController(), query: {} })
    try {
      const said = await call(first, 'create_workspace', { agent: 'kai', title: 'Back and forward', brief: 'Build KERNEL-200' })
      expect(said).toMatch(/^Created \S+ on \S+ for kai\. Every agent slot in Settings, Models is in use, so Kai hasn't started\. The brief goes out when a slot frees up\.$/)
      expect(/^Created (\S+) on /.exec(said)?.[1]).toBe(byTitle('Back and forward').id)
      const brief = k.chatTabs(byTitle('Back and forward').id).find((c) => c.kind !== 'terminal')!
      expect(k.sessions.queued(brief.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build KERNEL-200' }]])
      expect(k.sessions.isRunning(brief.id)).toBe(false)
    } finally { live.delete('busy') }
  })
})

describe('message_agent says what really happened (KERNEL-118)', () => {
  it('refuses an archived workspace, an unknown id, a missing folder, the Lead\'s own workspace and another room\'s, sending nothing', async () => {
    const { k, first, run, byTitle, sent } = await setup()
    const talks: unknown[] = []
    const onActivity = (e: { kind: string }) => { if (e.kind === 'agent.talk') talks.push(e) }
    bus.on('activity', onActivity)
    onTestFinished(() => { bus.off('activity', onActivity) })
    await run(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    await run(first, 'create_workspace', { agent: 'kai', title: 'Chat tab icons', brief: 'Go' })
    const drafts = byTitle('Drafts per chat')
    const icons = byTitle('Chat tab icons')
    sent.length = 0
    k.store.saveWorkspace({ ...drafts, status: 'archived' })
    expect(await run(first, 'message_agent', { workspace_id: drafts.id, text: 'Rebase' })).toEqual({ isError: true, text: `Not sent: ${drafts.name} is archived. Ask the user to restore it from History, or hand the work out again with create_workspace.` })
    expect(await run(first, 'message_agent', { workspace_id: 'nope', text: 'Rebase' })).toEqual({ isError: true, text: 'Not sent: there is no workspace nope in this room. Call list_workspaces for the ids.' })
    await rm(icons.path, { recursive: true, force: true })
    expect(await run(first, 'message_agent', { workspace_id: icons.id, text: 'Rebase' })).toEqual({ isError: true, text: `Not sent: ${icons.name}'s folder is gone. Ask the user to archive it, or hand the work out again with create_workspace.` })
    expect(await run(first, 'message_agent', { workspace_id: first.workspaceId, text: 'Rebase' })).toEqual({ isError: true, text: 'Not sent: that is your own workspace.' })
    // A real workspace, but in another room.
    const other = await k.addRoom(await tempRepo(REPO))
    const elsewhere = await k.createWorkspace(other.id, { prompt: 'Go', agentId: 'kai', title: 'Elsewhere' })
    expect(await run(first, 'message_agent', { workspace_id: elsewhere.id, text: 'Rebase' })).toEqual({ isError: true, text: `Not sent: there is no workspace ${elsewhere.id} in this room. Call list_workspaces for the ids.` })
    expect(sent.filter((x) => x.text === 'Rebase')).toEqual([])
    expect(talks).toEqual([])
  })

  it('says when the message waits, and why', async () => {
    const { first, call, byTitle, answer } = await setup()
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const id = byTitle('Drafts per chat').id
    const said: [QueueReason, string][] = [
      ['running', 'Kai is mid-turn, so the message goes out when that turn ends.'],
      ['setup', "Setup failed in Kai's workspace, so the message waits until the user clicks Run again."],
      ['paused', 'The room is paused, so the message goes out when the user resumes it.'],
      ['offline', 'Kernel is offline or signed out, so the message goes out once it is back.'],
      ['capacity', 'Every agent slot in Settings, Models is in use, so the message goes out when a slot frees up.']
    ]
    for (const [why, note] of said) {
      Object.assign(answer, { queued: true, why })
      expect(await call(first, 'message_agent', { workspace_id: id, text: 'Rebase' })).toBe(note)
    }
  })

  it('opens a chat in a workspace whose chats are all closed, and sends there', async () => {
    const { k, first, call, byTitle, sent } = await setup()
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const ws = byTitle('Drafts per chat')
    for (const c of k.store.chats(ws.id)) k.store.saveChat({ ...c, closed: true })
    expect(await call(first, 'message_agent', { workspace_id: ws.id, text: 'Rebase' })).toBe("Opened a new chat in Kai's workspace and sent it.")
    const open = k.chatTabs(ws.id)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ model: k.settings.models.engineers, effort: k.settings.models.effort, plan: false })
    expect(sent.at(-1)).toMatchObject({ chatId: open[0].id, text: 'Rebase', from: 'lead' })
  })

  it('sends a message the Lead wrote while setup ran with the brief, and holds both when setup fails', async () => {
    for (const [script, fails] of [['sleep 0.4', false], ['sleep 0.4 && false', true]] as const) {
      const { k, room, first, call } = await setup({ '.kernel/settings.toml': `[scripts]\nsetup = "${script}"\n` })
      // The brief and the Lead's message come in one call, as the chat's first turn (KERNEL-393).
      const sentAll: { chatId: string; messages: (string | undefined)[][] }[] = []
      k.sessions.sendAll = async (chatId: string, messages: { parts: ChatPart[]; from?: string }[]) => { sentAll.push({ chatId, messages: messages.map((m) => [m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), m.from]) }); return { queued: false } }
      const made = k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: first.id })
      const ws = await vi.waitFor(() => { const w = k.store.workspaces(room.id).find((x) => x.title === 'Invoice table'); if (!w) throw new Error('not yet'); return w })
      expect(ws.status).toBe('setup')
      expect(await call(first, 'message_agent', { workspace_id: ws.id, text: 'Use EmptyState' })).toBe("Kai's workspace is still setting up, so the message goes out with the brief.")
      await made
      const chat = k.store.chats(ws.id)[0]
      if (fails) expect(k.sessions.queued(chat.id).map((q) => [(q.parts[0] as { text: string }).text, q.from])).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
      else expect(sentAll.filter((x) => x.chatId === chat.id)).toEqual([{ chatId: chat.id, messages: [['Build T-14', 'lead'], ['Use EmptyState', 'lead']] }])
    }
  })
})

describe('the loop guard on automatic requests (KERNEL-125)', () => {
  const ASK = { text: 'Fix the failing check' }
  const SPENT = 'Not sent: Kernel has passed 3 automatic requests to Kai on this workspace and it still needs help. Tell the user what keeps failing and ask how to go on.'

  async function guarded() {
    const t = await setup()
    await t.call(t.first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const ws = t.byTitle('Drafts per chat')
    const ask = () => t.run(t.first, 'message_agent', { workspace_id: ws.id, ...ASK })
    const spend = async () => { for (let i = 0; i < 3; i++) expect((await ask()).isError).toBe(false) }
    return { ...t, ws, ask, spend }
  }

  it('lets three requests from Kernel-started turns through, refuses the fourth, and starts over when the user writes to Rowan', async () => {
    const { k, first, ask, spend, sent } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    await spend()
    sent.length = 0
    expect(await ask()).toEqual({ isError: true, text: SPENT })
    expect(sent).toEqual([])
    await k.handlers()['chats.send']({ chatId: first.id, parts: [{ type: 'text', text: 'Try once more' }] })
    expect((await ask()).isError).toBe(false)
  })

  /** GitHub as the PR is now: its state and the checks on its head commit. */
  function github(k: Kernel) {
    const pr = { state: 'cifail' as PrState, checks: [{ name: 'test', state: 'fail' }] as PrCheck[], head: undefined as string | undefined, conflictsUnknown: false }
    k.github = { info: async (_cwd, _ref, workspaceId) => ({ workspaceId, number: 7, url: 'https://github.com/o/r/pull/7', title: 't', state: pr.state, baseRef: 'main', checks: pr.checks, comments: [], conflicts: [], head: pr.head, conflictsUnknown: pr.conflictsUnknown }), merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
    return pr
  }

  it('starts over when the PR becomes ready with checks that ran, or merges, or when the user writes to the teammate', async () => {
    const { k, first, ws, ask, spend } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    const pr = github(k)
    await k.refreshPr(ws.id)
    await spend()
    // Just after a push GitHub has no checks for the new commit, and the PR reads as ready for a moment. Nothing moved on.
    Object.assign(pr, { state: 'ready', checks: [] })
    await k.refreshPr(ws.id)
    expect((await ask()).isError).toBe(true)
    // The checks run and pass before the next read, which reads ready again: that is the work moving on.
    pr.checks = [{ name: 'test', state: 'pass' }]
    await k.refreshPr(ws.id)
    await spend()
    expect((await ask()).isError).toBe(true)
    bus.push({ type: 'pr', workspaceId: ws.id, state: 'merged' })
    await spend()
    expect((await ask()).isError).toBe(true)
    await k.handlers()['chats.send']({ chatId: k.chatTabs(ws.id)[0].id, parts: [{ type: 'text', text: 'Use the other approach' }] })
    expect((await ask()).isError).toBe(false)
  })

  it('starts over when a PR in a repo without checks becomes ready', async () => {
    const { k, first, ws, ask, spend } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    const pr = github(k)
    Object.assign(pr, { state: 'conflict', checks: [] })
    await k.refreshPr(ws.id)
    await spend()
    pr.state = 'ready'
    await k.refreshPr(ws.id)
    expect((await ask()).isError).toBe(false)
  })

  it("doesn't start over when a ready PR reads as checks and ready again on the same commit, as each time main moves (KERNEL-283)", async () => {
    const { k, first, ws, ask, spend } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    const pr = github(k)
    Object.assign(pr, { state: 'ready', checks: [{ name: 'test', state: 'pass' }], head: 'abc' })
    await k.prs.refreshPr(ws.id)
    await spend()
    // Main moved: GitHub checks the PR for conflicts again, then says it is still fine. Nothing moved on.
    Object.assign(pr, { state: 'checks', conflictsUnknown: true })
    await k.prs.refreshPr(ws.id)
    Object.assign(pr, { state: 'ready', conflictsUnknown: false })
    await k.prs.refreshPr(ws.id)
    expect((await ask()).isError).toBe(true)
    // A new commit whose checks pass is the work moving on.
    Object.assign(pr, { state: 'checks', checks: [{ name: 'test', state: 'running' }], head: 'def' })
    await k.prs.refreshPr(ws.id)
    Object.assign(pr, { state: 'ready', checks: [{ name: 'test', state: 'pass' }] })
    await k.prs.refreshPr(ws.id)
    expect((await ask()).isError).toBe(false)
  })

  it('never counts a turn the user started', async () => {
    const { k, ws, ask } = await guarded()
    k.sessions.kernelTurn = () => false
    for (let i = 0; i < 5; i++) expect((await ask()).isError).toBe(false)
    expect(new Nudges(k.store).count(ws.id)).toBe(0)
  })

  it('keeps the counts across a restart', async () => {
    const { k, first, ws, spend, where, rowan, room } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    await spend()
    await k.stop()
    const k2 = new Kernel(where)
    await k2.start()
    onTestFinished(() => k2.stop())
    k2.sessions.send = async () => ({ queued: false })
    k2.sessions.kernelTurn = (id) => id === first.id
    k2.lead['leadTools'](room.id, rowan, first)
    const tool = kernelTools(wired!).find((t) => t.name === 'message_agent')!
    const r = await tool.handler({ workspace_id: ws.id, ...ASK } as never, {})
    expect((r as { isError?: boolean }).isError).toBe(true)
  })

  it('counts several messages in one Kernel turn as one try', async () => {
    const { k, first, ws, ask } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    const turn = (n: number) => k.store.saveItem(first.id, { kind: 'user', id: `turn-${n}`, ts: n, from: 'kernel', parts: [{ type: 'text', text: 'Team update from Kernel, not from the user.' }] })
    for (const n of [1, 2, 3]) { turn(n); expect((await ask()).isError).toBe(false); expect((await ask()).isError).toBe(false) }
    expect(new Nudges(k.store).count(ws.id)).toBe(3)
    // A fourth turn is refused, but the turn that made the third try can still say more.
    expect((await ask()).isError).toBe(false)
    turn(4)
    expect(await ask()).toEqual({ isError: true, text: SPENT })
  })

  it('starts over when the user answers the Lead\'s question or the PR merges, and not on an Ask Rowan question', async () => {
    const { k, room, first, ws, ask, spend, call } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    await spend()
    const asking = call(first, 'ask_user', { question: 'Checks keep failing on the snapshot test. Skip it?' })
    const pending = await vi.waitFor(() => { const p = k.store.approvals({ pendingOnly: true })[0]; if (!p) throw new Error('not yet'); return p })
    k.approvals.decide(pending.id, { behavior: 'answer', text: 'Update the snapshot' })
    await asking
    expect(new Nudges(k.store).count(ws.id)).toBe(0)
    await spend()
    // The question gets a Lead chat of its own (KERNEL-145), which hears none of this workspace's updates.
    await k.askLead(room.id, 'How is Kai doing?')
    expect(new Nudges(k.store).count(ws.id)).toBe(3)
    bus.push({ type: 'pr', workspaceId: ws.id, state: 'merged' })
    expect(new Nudges(k.store).count(ws.id)).toBe(0)
    expect((await ask()).isError).toBe(false)
  })

  it("starts over from the Lead chat that gets a closed chat's work, and not from another Lead chat", async () => {
    const { k, first, icons, ws, ask, spend } = await guarded()
    k.sessions.kernelTurn = (id) => id === first.id
    await spend()
    // Another open Lead chat writing changes nothing for work the first chat handed off.
    await k.handlers()['chats.send']({ chatId: icons.id, parts: [{ type: 'text', text: 'Unrelated' }] })
    expect((await ask()).isError).toBe(true)
    // Once the first chat is closed, its work reports to the other chat, and writing there starts over.
    k.store.saveChat({ ...k.store.chat(first.id)!, closed: true })
    await k.handlers()['chats.send']({ chatId: icons.id, parts: [{ type: 'text', text: 'Take over' }] })
    expect(new Nudges(k.store).count(ws.id)).toBe(0)
  })
})

describe("the Lead's ask_user options (KERNEL-407)", () => {
  const waiting = async (k: Kernel) => vi.waitFor(() => { const p = k.store.approvals({ pendingOnly: true })[0]; if (!p) throw new Error('not yet'); return p })

  it('keeps each option\'s description for the card and sends back the label that was picked', async () => {
    const { k, first, call } = await setup()
    const options = [{ label: 'Guided sign-in', description: 'Kernel opens the sign-in in your browser. Recommended.' }, { label: 'Paste a token' }]
    const asking = call(first, 'ask_user', { question: 'How should adding a Claude account work?', options })
    const p = await waiting(k)
    expect(p).toMatchObject({ kind: 'question', options: ['Guided sign-in', 'Paste a token'], questions: [{ question: 'How should adding a Claude account work?', options }] })
    k.approvals.decide(p.id, { behavior: 'answer', text: 'Guided sign-in' })
    expect(await asking).toBe('Guided sign-in')
  })

  it('still takes plain string options', async () => {
    const { k, first, call } = await setup()
    const asking = call(first, 'ask_user', { question: 'Skip the snapshot test?', options: ['Yes', 'No'] })
    const p = await waiting(k)
    expect(p).toMatchObject({ options: ['Yes', 'No'], questions: [{ options: [{ label: 'Yes' }, { label: 'No' }] }] })
    k.approvals.decide(p.id, { behavior: 'answer', text: 'No' })
    expect(await asking).toBe('No')
  })
})

describe('Ask Rowan (KERNEL-145)', () => {
  it('opens a new Lead chat tab for each question, past a busy first tab, and gives it the Lead tools', async () => {
    const { k, room, first, icons, sent, rowan } = await setup()
    k.sessions.isRunning = (id: string) => id === first.id
    const a = await k.askLead(room.id, 'What is kai working on?')
    const b = await k.askLead(room.id, 'Is the release branch ready to merge?')
    expect(sent).toEqual([
      { chatId: a.chatId, text: 'What is kai working on?', from: undefined },
      { chatId: b.chatId, text: 'Is the release branch ready to merge?', from: undefined }
    ])
    expect(k.chatTabs(first.workspaceId).map((c) => c.id)).toEqual([first.id, icons.id, a.chatId, b.chatId])
    expect([a, b].map(({ chatId }) => k.store.chat(chatId)!.plan)).toEqual([false, false])
    expect(await k.leadChat(room.id)).toEqual(first)
    // Each tab gets the Lead's kernel server, bound to that tab.
    const ws = k.store.workspace(first.workspaceId)!
    expect(k.sessions['d'].mcpFor(ws, rowan, k.store.chat(b.chatId)!)).toHaveProperty('kernel')
    expect(wired!.chatId).toBe(b.chatId)
  })

  it('leaves an unused Lead tab alone, since the user may be typing a brief there', async () => {
    const { k, room, first, icons, sent } = await setup()
    // Nothing sent yet, so the engine sees it as unused, but the composer may hold a draft.
    const drafting = k.newChat(first.workspaceId, 'Lead', { model: 'claude-fable-5-1', effort: 'xhigh', plan: true })
    for (const c of [first, icons]) k.store.saveChat({ ...k.store.chat(c.id)!, closed: true })
    const { chatId } = await k.askLead(room.id, 'What is kai working on?')
    expect(chatId).not.toBe(drafting.id)
    expect(sent.map((s) => s.chatId)).toEqual([chatId])
    expect(k.store.chat(drafting.id)).toEqual(drafting)
    // The New chat modal leaves it too (KERNEL-242).
    const brief = await k.startLeadChat(room.id, { prompt: 'Add PDF export' })
    expect(brief.id).not.toBe(drafting.id)
    expect(sent.map((s) => s.chatId)).toEqual([chatId, brief.id])
    expect(k.store.chat(drafting.id)).toEqual(drafting)
  })
})

describe('Lead chats with several tabs (KERNEL-337)', () => {
  it('starts a new Lead chat from lead.start, lead.ask, the + button and a first leadChat, and joins the one it is given', async () => {
    const { k, room, first, tab } = await setup()
    const h = k.handlers()
    const thread = (c: Chat) => k.store.thread(k.store.chat(c.id)!.threadId!)
    // The first leadChat starts a Lead chat named like its tab.
    expect(thread(first)).toMatchObject({ roomId: room.id, title: 'Lead' })
    const started = await h['lead.start']({ roomId: room.id, prompt: 'Plan the release' })
    expect(started.title).toBe('New tab')
    const asked = k.store.chat((await h['lead.ask']({ roomId: room.id, text: 'How is Kai doing?' })).chatId)!
    const opened = await tab()
    expect(opened).toMatchObject({ title: 'New tab', autoTitle: { turns: 0 } })
    const threads = [first, started, asked, opened].map((c) => thread(c)!.id)
    expect(new Set(threads).size).toBe(4)
    expect(thread(opened)).toMatchObject({ title: 'New tab' })
    // Given a Lead chat, a tab joins it.
    expect((await tab(started.threadId)).threadId).toBe(started.threadId)
    const askedIn = (await h['lead.ask']({ roomId: room.id, text: 'And Noor?', threadId: first.threadId })).chatId
    expect(k.store.chat(askedIn)!.threadId).toBe(first.threadId)
    expect((await h['threads.list']({ roomId: room.id })).map((t) => t.id)).toEqual(threads)
    // A big terminal belongs to no Lead chat, and a Lead chat that is gone or in another room takes no tab.
    expect((await h['chats.create']({ workspaceId: first.workspaceId, kind: 'terminal' })).threadId).toBeUndefined()
    await expect(tab('gone')).rejects.toThrow('That chat no longer exists.')
    const other = await k.rooms.addRoom(await tempRepo(REPO))
    await trustRoom(k, other.id)
    await expect(tab((await k.lead.leadChat(other.id)).threadId)).rejects.toThrow('That chat no longer exists.')
  })

  it('keeps a fork of a Lead tab in its Lead chat, and leaves a workspace chat out of Lead chats', async () => {
    const { k, room, first } = await setup()
    const h = k.handlers()
    const fork = await h['chats.fork']({ chatId: first.id })
    expect(fork.threadId).toBe(first.threadId)
    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Tabs' })
    expect((await h['chats.create']({ workspaceId: ws.id })).threadId).toBeUndefined()
    expect(k.store.chats(ws.id).every((c) => !c.threadId)).toBe(true)
  })

  it('closes a Lead chat with its last open tab, and opens it again for a new tab', async () => {
    const { k, room, first, icons, tab } = await setup()
    const second = await tab(first.threadId)
    const pushed: string[] = []
    const listen = (e: { type: string; thread?: { id: string; closedAt?: number } }) => { if (e.type === 'thread') pushed.push(`${e.thread!.id}:${e.thread!.closedAt ? 'closed' : 'open'}`) }
    bus.on('push', listen)
    onTestFinished(() => { bus.off('push', listen) })
    k.chats.closeChat(first.id)
    expect(k.store.thread(first.threadId!)!.closedAt).toBeUndefined()
    expect(pushed).toEqual([])
    k.chats.closeChat(second.id)
    const closed = k.store.thread(first.threadId!)!
    expect(closed.closedAt).toBeGreaterThan(0)
    expect(closed.title).toBe('Lead')
    expect(pushed).toEqual([`${closed.id}:closed`])
    // Closing the last tab in the Lead's workspace starts nothing (KERNEL-365).
    k.chats.closeChat(icons.id)
    expect(k.chats['chatTabs'](first.workspaceId)).toEqual([])
    expect(k.store.threads(room.id).map((t) => t.id)).toEqual([first.threadId])
    // A new tab in the closed Lead chat opens it again.
    await tab(first.threadId)
    expect(k.store.thread(first.threadId!)!.closedAt).toBeUndefined()
    expect(pushed.at(-1)).toBe(`${first.threadId}:open`)
  })

  it("names the Lead chat after its first tab's auto name until the user names it", async () => {
    const { k, first, tab } = await setup()
    const second = await tab(first.threadId)
    const named = (c: Chat, title: string) => k.lead.tabNamed(k.store.saveChat({ ...k.store.chat(c.id)!, title }))
    named(second, 'Second tab subject')
    expect(k.store.thread(first.threadId!)!.title).toBe('Lead')
    named(first, 'Release plan')
    expect(k.store.thread(first.threadId!)!.title).toBe('Release plan')
    // Closing tabs leaves the name alone.
    k.chats.closeChat(first.id)
    expect(k.store.thread(first.threadId!)!.title).toBe('Release plan')
    const renamed = await k.handlers()['threads.rename']({ threadId: first.threadId!, title: '  Q3 release  ' })
    expect(renamed).toMatchObject({ title: 'Q3 release', renamed: true })
    named(first, 'Something else')
    expect(k.store.thread(first.threadId!)!.title).toBe('Q3 release')
    await expect(k.handlers()['threads.rename']({ threadId: first.threadId!, title: ' ' })).rejects.toThrow()
  })

  it('sends work to the owner tab, then the newest open tab of its Lead chat, then the first Lead tab, and says where it came from', async () => {
    const { k, first, icons, target, tab } = await setup()
    const older = await tab(icons.threadId)
    const owner = await tab(older.threadId)
    const newer = await tab(owner.threadId)
    k.store.saveThread({ ...k.store.thread(owner.threadId!)!, title: 'Chat icons work' })
    expect(target(owner.id)).toEqual({ chat: owner })
    k.chats.closeChat(owner.id)
    expect(target(owner.id)).toEqual({ chat: k.store.chat(newer.id), from: { title: owner.title, tab: true } })
    k.chats.closeChat(newer.id)
    expect(target(owner.id)).toEqual({ chat: k.store.chat(older.id), from: { title: owner.title, tab: true } })
    k.chats.closeChat(older.id)
    expect(target(owner.id)).toEqual({ chat: first, from: { title: 'Chat icons work' } })
    expect(icons.threadId).toBeUndefined()
  })

  it('treats work handed off in any tab of the Lead chat as yours, and names the Lead chat for the rest', async () => {
    const { k, first, call, byTitle, tab } = await setup()
    const sibling = await tab(first.threadId)
    const elsewhere = await tab()
    k.store.saveThread({ ...k.store.thread(elsewhere.threadId!)!, title: 'Composer unit tests' })
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    await call(elsewhere, 'create_workspace', { agent: 'kai', title: 'Composer tests', brief: 'Go' })
    const drafts = byTitle('Drafts per chat')
    const composer = byTitle('Composer tests')
    const lines = (await call(sibling, 'list_workspaces', {})).split('\n')
    expect(lines.find((l) => l.startsWith(drafts.id))).toMatch(/ · yours$/)
    expect(lines.find((l) => l.startsWith(composer.id))).toMatch(/ · from Lead chat "Composer unit tests"$/)
    expect(await call(sibling, 'message_agent', { workspace_id: drafts.id, text: 'Rebase on main.' })).toBe('Sent.')
    // The same task from another tab of the chat is the one already handed off.
    expect(await call(sibling, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })).toBe(`Not created: this task is already handed off to Kai (workspace ${drafts.id}). Follow up with message_agent.`)
    expect(drafts.leadChatId).toBe(first.id)
  })

  it("links a plan step from a plan approved in another tab of the Lead chat, and read_plans reads only this chat's plans", async () => {
    const { k, room, first, call, byTitle, tab } = await setup()
    const sibling = await tab(first.threadId)
    const elsewhere = await tab()
    const plan = (id: string, chat: Chat, createdAt: number, status: Approval['status'] = 'allowed') => k.store.saveApproval({
      id, kind: 'plan', source: 'sdk', roomId: room.id, workspaceId: chat.workspaceId, chatId: chat.id, agentId: 'rowan', title: id, detail: `${id} text`,
      steps: [{ title: `${id} step`, agentId: 'kai' }], status, createdAt
    } as Approval)
    const now = Date.now()
    plan('first-plan', first, now - 3000)
    plan('sibling-plan', sibling, now - 2000)
    plan('rejected-plan', sibling, now - 1500, 'denied')
    plan('elsewhere-plan', elsewhere, now - 1000)
    expect(await call(sibling, 'read_plans', {})).toBe([
      `Approved in the tab "${sibling.title}" at ${new Date(now - 2000).toISOString()}:\nsibling-plan text`,
      `Approved in the tab "${first.title}" at ${new Date(now - 3000).toISOString()}:\nfirst-plan text`
    ].join('\n\n'))
    expect(await call(await tab(), 'read_plans', {})).toBe('No plan has been approved in this chat yet.')
    // The step goes to the newest plan of the chat, approved in the other tab.
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const ws = byTitle('Drafts per chat')
    const step = (id: string) => k.store.approvals({ roomId: room.id }).find((a) => a.id === id)!.steps![0].workspaceId
    expect(step('sibling-plan')).toBe(ws.id)
    expect(step('first-plan')).toBeUndefined()
    expect(step('elsewhere-plan')).toBeUndefined()
  })

  it('starts the loop guard over when the user writes in the tab that took over a closed tab of the same chat', async () => {
    const { k, first, call, byTitle, run, tab } = await setup()
    const sibling = await tab(first.threadId)
    const elsewhere = await tab()
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const ws = byTitle('Drafts per chat')
    k.sessions.kernelTurn = (id) => id === first.id
    for (let i = 0; i < 3; i++) expect((await run(first, 'message_agent', { workspace_id: ws.id, text: 'Fix the failing check' })).isError).toBe(false)
    k.chats.closeChat(first.id)
    await k.handlers()['chats.send']({ chatId: elsewhere.id, parts: [{ type: 'text', text: 'Unrelated' }] })
    expect(new Nudges(k.store).count(ws.id)).toBe(3)
    await k.handlers()['chats.send']({ chatId: sibling.id, parts: [{ type: 'text', text: 'Take over' }] })
    expect(new Nudges(k.store).count(ws.id)).toBe(0)
  })

  it('keeps a workspace with its Lead chat after the tab that handed it off closes and Kernel restarts', async () => {
    const { k, room, first, call, byTitle, tab, where } = await setup()
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const ws = byTitle('Drafts per chat')
    expect(ws).toMatchObject({ leadChatId: first.id, threadId: first.threadId })
    const sibling = await tab(first.threadId)
    k.chats.closeChat(first.id)
    await k.stop()
    const k2 = new Kernel(where)
    await k2.start()
    onTestFinished(() => k2.stop())
    // The renderer sees only open tabs, so the workspace has to name the Lead chat itself.
    const h = k2.handlers()
    expect((await h['chats.list']({ workspaceId: first.workspaceId })).map((c) => c.id)).not.toContain(first.id)
    expect((await h['workspaces.list']({ roomId: room.id })).find((w) => w.id === ws.id)!.threadId).toBe(sibling.threadId)
    expect((await h['threads.list']({ roomId: room.id })).find((t) => t.id === sibling.threadId)!.closedAt).toBeUndefined()
  })

  it('names other Lead chats in an overlap by their titles, and not other tabs of its own', async () => {
    const { k, room, first, call, byTitle, tab, sent } = await setup()
    const sibling = await tab(first.threadId)
    k.store.saveChat({ ...k.store.chat(sibling.id)!, title: 'Side question' })
    const elsewhere = await tab()
    k.store.saveChat({ ...k.store.chat(elsewhere.id)!, title: 'Tab title' })
    k.store.saveThread({ ...k.store.thread(elsewhere.threadId!)!, title: 'Composer unit tests' })
    await call(first, 'create_workspace', { agent: 'kai', title: 'Pasted text preview', brief: 'Go' })
    await call(sibling, 'create_workspace', { agent: 'kai', title: 'Chat tab state icons', brief: 'Go' })
    await call(elsewhere, 'create_workspace', { agent: 'kai', title: 'Composer tests', brief: 'Go' })
    await call(first, 'create_workspace', { agent: 'kai', title: 'Composer snapshots', brief: 'Go' })
    // The newest hand-off decides who hears about it, so they get apart in time.
    const age = (...titles: string[]) => titles.forEach((t, i) => k.store.saveWorkspace({ ...byTitle(t), createdAt: 1000 + i }))
    age('Pasted text preview', 'Chat tab state icons', 'Composer tests', 'Composer snapshots')
    const overlap = (id: string, ...titles: string[]) => k['overlaps']['known'].set(id, { id, roomId: room.id, path: 'src/a.ts', ts: 1, parties: titles.map((t) => ({ agentId: 'kai', workspaceId: byTitle(t).id, lines: '+1 -1' })) })
    overlap('o1', 'Pasted text preview', 'Chat tab state icons')
    overlap('o2', 'Pasted text preview', 'Composer tests')
    sent.length = 0
    await k.lead.sortOverlap('o1')
    expect(sent.map((s) => s.chatId)).toEqual([sibling.id])
    expect(sent[0].text).not.toContain('another Lead chat')
    await k.lead.sortOverlap('o2')
    expect(sent[1].chatId).toBe(elsewhere.id)
    expect(sent[1].text).toContain('Part of this work was handed off in another Lead chat: "Lead".')
    overlap('o3', 'Composer tests', 'Composer snapshots')
    await k.lead.sortOverlap('o3')
    expect(sent[2].chatId).toBe(first.id)
    expect(sent[2].text).toContain('Part of this work was handed off in another Lead chat: "Composer unit tests".')
  })
})

describe('a room with no open Lead chat (KERNEL-365)', () => {
  /** Records Kernel's updates instead of running them, and closes every open tab in the Lead's workspace. */
  const quiet = async (s: Awaited<ReturnType<typeof setup>>) => {
    const posts: { chatId: string; text: string }[] = []
    s.k.sessions.post = (chatId: string, parts: ChatPart[]) => { posts.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }); return true }
    for (const c of s.k.chats['chatTabs'](s.first.workspaceId)) s.k.chats.closeChat(c.id)
    expect(s.k.chats['chatTabs'](s.first.workspaceId)).toEqual([])
    /** Sends what waits now, without the few seconds Kernel waits for more. */
    const flush = () => {
      const u = s.k.leadUpdates
      for (const t of u['timers'].values()) clearTimeout(t)
      u['timers'].clear()
      u.flushAll()
    }
    const open = () => s.k.chats['chatTabs'](s.first.workspaceId).filter((c) => c.kind !== 'terminal')
    return { posts, flush, open }
  }

  it('leaves the Lead chat closed when its last tab closes, and still replaces the last tab in a teammate workspace', async () => {
    const s = await setup()
    const { k, room, first } = s
    await quiet(s)
    expect(k.store.thread(first.threadId!)!.closedAt).toBeGreaterThan(0)
    expect(k.store.threads(room.id)).toHaveLength(1)
    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Tabs' })
    const [brief] = k.chats['chatTabs'](ws.id)
    k.chats.closeChat(brief.id)
    const left = k.chats['chatTabs'](ws.id)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ title: 'New chat' })
    expect(left[0].id).not.toBe(brief.id)
  })

  it('opens the Lead workspace with lead.open and adds no chat or thread', async () => {
    const s = await setup()
    const { k, room, first } = s
    await quiet(s)
    const chats = k.store.chats(first.workspaceId).length
    const threads = k.store.threads(room.id).length
    expect((await k.handlers()['lead.open']({ roomId: room.id })).id).toBe(first.workspaceId)
    expect(k.store.chats(first.workspaceId)).toHaveLength(chats)
    expect(k.store.threads(room.id)).toHaveLength(threads)
  })

  it("delivers an update with no open tab into one new tab of the owner's Lead chat, which opens again", async () => {
    const s = await setup()
    const { k, first, call, byTitle, tab } = s
    const sibling = await tab(first.threadId)
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    await call(sibling, 'create_workspace', { agent: 'kai', title: 'Composer tests', brief: 'Go' })
    const { posts, flush, open } = await quiet(s)
    const pushed: string[] = []
    const listen = (e: { type: string; chat?: Chat }) => { if (e.type === 'chat' && e.chat) pushed.push(e.chat.id) }
    bus.on('push', listen)
    onTestFinished(() => { bus.off('push', listen) })
    // Two batches from two closed tabs of the same Lead chat, sent in one flush.
    k.leadUpdates.crashed(byTitle('Drafts per chat'), 'Out of memory')
    k.leadUpdates.crashed(byTitle('Composer tests'), 'Out of memory')
    flush()
    const tabs = open()
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ threadId: first.threadId, title: 'New tab' })
    expect(k.store.thread(first.threadId!)!.closedAt).toBeUndefined()
    expect(pushed).toContain(tabs[0].id)
    expect(posts.map((p) => p.chatId)).toEqual([tabs[0].id])
    expect(posts[0].text).toContain(`From "${first.title}", a tab you closed.`)
    expect(posts[0].text).toContain(`From "${sibling.title}", a tab you closed.`)
    expect(k.leadUpdates['pending'].size).toBe(0)
  })

  it('starts a new Lead chat for work from a chat with no thread, and for work no chat handed off', async () => {
    const s = await setup()
    const { k, room, first, icons, call, byTitle } = s
    expect(icons.threadId).toBeUndefined()
    await call(icons, 'create_workspace', { agent: 'kai', title: 'Chat tab state icons', brief: 'Go' })
    const { posts, flush, open } = await quiet(s)
    k.leadUpdates.crashed(byTitle('Chat tab state icons'), 'Out of memory')
    flush()
    const [fresh] = open()
    expect(open()).toHaveLength(1)
    expect(fresh.threadId).not.toBe(first.threadId)
    expect(k.store.thread(fresh.threadId!)).toMatchObject({ roomId: room.id, title: 'New tab' })
    expect(posts.map((p) => p.chatId)).toEqual([fresh.id])
    expect(posts[0].text).toContain(`From "${icons.title}", a Lead chat that is now closed.`)
    // Work no Lead tab handed off gets a new Lead chat too.
    k.chats.closeChat(fresh.id)
    const unowned = k.lead.openUpdateTab(room.id)!
    expect(unowned.from).toBeUndefined()
    expect(open().map((c) => c.id)).toEqual([unowned.chat.id])
    expect(unowned.chat.threadId).not.toBe(fresh.threadId)
    // A Lead workspace that was archived has nobody left to tell.
    k.chats.closeChat(unowned.chat.id)
    k.store.saveWorkspace({ ...k.store.workspace(first.workspaceId)!, status: 'archived' })
    expect(k.lead.openUpdateTab(room.id)).toBeUndefined()
  })

  it('opens no tab for an update that needs nothing from the Lead yet', async () => {
    const s = await setup()
    const { k, first, call, byTitle } = s
    await call(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const { posts, flush, open } = await quiet(s)
    k.leadUpdates.crashed(byTitle('Drafts per chat'), 'Out of memory', { resumed: true })
    flush()
    expect(open()).toEqual([])
    expect(posts).toEqual([])
    expect(k.store.thread(first.threadId!)!.closedAt).toBeGreaterThan(0)
  })
})

describe('create_workspace when the task is already handed off (KERNEL-287)', () => {
  it('refuses a second hand-off of the same issue from any Lead chat, and hands it off again once the first is archived', async () => {
    const { k, room, first, icons, run } = await setup()
    const made = await run(first, 'create_workspace', { agent: 'kai', title: 'Issues screen', brief: 'Go', issue: 'KERNEL-83' })
    expect(made.text).toMatch(/^Created /)
    const ws = k.store.workspaces(room.id).find((w) => w.title === 'Issues screen')!
    const again = { isError: true, text: `Not created: KERNEL-83 is already handed off to Kai (workspace ${ws.id}). Follow up with message_agent.` }
    expect(await run(first, 'create_workspace', { agent: 'kai', title: 'Issues screen', brief: 'Go', issue: 'KERNEL-83' })).toEqual(again)
    // Another title, another chat, the key in another case: still the same issue.
    expect(await run(icons, 'create_workspace', { agent: 'kai', title: 'Build the issues list', brief: 'Go', issue: 'kernel-83' })).toEqual({ ...again, text: again.text.replace('KERNEL-83 is', 'kernel-83 is') })
    expect(k.store.workspaces(room.id).filter((w) => w.title === 'Issues screen' || w.title === 'Build the issues list')).toHaveLength(1)
    await k.archiveWorkspace(ws.id)
    expect((await run(first, 'create_workspace', { agent: 'kai', title: 'Issues screen', brief: 'Go', issue: 'KERNEL-83' })).text).toMatch(/^Created /)
  })

  it('refuses the same agent and title from the same Lead chat, but not from another chat or for another agent', async () => {
    const { k, room, first, icons, run } = await setup({ '.claude/agents/noor.md': '---\nname: noor\ndescription: Engine engineer.\n---\nYou are Noor.' })
    expect((await run(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })).text).toMatch(/^Created /)
    const ws = k.store.workspaces(room.id).find((w) => w.title === 'Drafts per chat')!
    expect(await run(first, 'create_workspace', { agent: 'kai', title: ' drafts per chat ', brief: 'Go again' })).toEqual({ isError: true, text: `Not created: this task is already handed off to Kai (workspace ${ws.id}). Follow up with message_agent.` })
    expect((await run(icons, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })).text).toMatch(/^Created /)
    expect((await run(first, 'create_workspace', { agent: 'noor', title: 'Drafts per chat', brief: 'Go' })).text).toMatch(/^Created /)
    expect(k.store.workspaces(room.id).filter((w) => w.title === 'Drafts per chat')).toHaveLength(3)
  })

  it('lets a task whose PR merged or closed be handed off again', async () => {
    const { k, room, first, run } = await setup()
    for (const [i, prState] of (['merged', 'closed'] as PrState[]).entries()) {
      const issue = `KERNEL-${90 + i}`
      expect((await run(first, 'create_workspace', { agent: 'kai', title: 'Fix it', brief: 'Go', issue })).text).toMatch(/^Created /)
      const ws = k.store.workspaces(room.id).find((w) => w.source?.kind === 'issue' && w.source.id === issue)!
      k.store.saveWorkspace({ ...ws, prState })
      expect((await run(first, 'create_workspace', { agent: 'kai', title: 'Fix it', brief: 'Go', issue })).text).toMatch(/^Created /)
    }
  })

  it('counts a task that waits for another PR as handed off', async () => {
    const { k, room, first, run } = await setup()
    await run(first, 'create_workspace', { agent: 'kai', title: 'Base', brief: 'Go' })
    const base = k.store.workspaces(room.id).find((w) => w.title === 'Base')!
    k.store.saveWorkspace({ ...base, prState: 'open', prNumber: 164 })
    expect((await run(first, 'create_workspace', { agent: 'kai', title: 'On top', brief: 'Go', wait_for: [base.id] })).text).toMatch(/^Created /)
    const waiting = k.store.workspaces(room.id).find((w) => w.title === 'On top')!
    expect(waiting.waitsFor?.on).toEqual([base.id])
    expect(await run(first, 'create_workspace', { agent: 'kai', title: 'On top', brief: 'Go', wait_for: [base.id] })).toEqual({ isError: true, text: `Not created: this task is already handed off to Kai (workspace ${waiting.id}). Follow up with message_agent.` })
  })
})

describe('create_workspace when the handed-off task is a review, failed setup or older work (KERNEL-287)', () => {
  const NOOR = { '.claude/agents/noor.md': '---\nname: noor\ndescription: Engine engineer.\n---\nYou are Noor.' }

  it('says when the task is handed off but its setup failed, with or without an issue key', async () => {
    const { k, room, first, run } = await setup()
    await run(first, 'create_workspace', { agent: 'kai', title: 'Issues screen', brief: 'Go', issue: 'KERNEL-83' })
    await run(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const keyed = k.store.workspaces(room.id).find((w) => w.title === 'Issues screen')!
    const plain = k.store.workspaces(room.id).find((w) => w.title === 'Drafts per chat')!
    k.store.saveWorkspace({ ...keyed, status: 'failed' })
    k.store.saveWorkspace({ ...plain, status: 'failed' })
    expect(await run(first, 'create_workspace', { agent: 'kai', title: 'Issues screen', brief: 'Go', issue: 'KERNEL-83' })).toEqual({ isError: true, text: `Not created: KERNEL-83 is already handed off to Kai (workspace ${keyed.id}), and its setup failed. Tell the user to fix it and click Run again there.` })
    expect(await run(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })).toEqual({ isError: true, text: `Not created: this task is already handed off to Kai (workspace ${plain.id}), and its setup failed. Tell the user to fix it and click Run again there.` })
  })

  it('never lets an open review block a hand-off with the same issue, or the same agent and title', async () => {
    const { k, room, first, run } = await setup(NOOR)
    await run(first, 'create_workspace', { agent: 'kai', title: 'Base work', brief: 'Go' })
    const base = k.store.workspaces(room.id).find((w) => w.title === 'Base work')!
    expect((await run(first, 'create_workspace', { agent: 'noor', title: 'Review it', brief: 'Review', issue: 'KERNEL-83', review_of: base.id })).text).toMatch(/^Created /)
    expect(k.store.workspaces(room.id).find((w) => w.title === 'Review it')).toMatchObject({ reviewOf: base.id, source: { kind: 'issue', id: 'KERNEL-83' } })
    expect((await run(first, 'create_workspace', { agent: 'kai', title: 'Issues screen', brief: 'Go', issue: 'KERNEL-83' })).text).toMatch(/^Created /)
    expect((await run(first, 'create_workspace', { agent: 'noor', title: 'Review it', brief: 'Go' })).text).toMatch(/^Created /)
  })

  it('leaves a review to its own guard when open work has the same issue', async () => {
    const { k, room, first, run } = await setup(NOOR)
    await run(first, 'create_workspace', { agent: 'kai', title: 'Issues screen', brief: 'Go', issue: 'KERNEL-83' })
    const work = k.store.workspaces(room.id).find((w) => w.title === 'Issues screen')!
    expect((await run(first, 'create_workspace', { agent: 'noor', title: 'Review issues screen', brief: 'Review', issue: 'KERNEL-83', review_of: work.id })).text).toMatch(/^Created /)
  })

  it('never refuses a task without an issue key because of a workspace from before Lead chats', async () => {
    const { k, room, first, run } = await setup()
    await run(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })
    const old = k.store.workspaces(room.id).find((w) => w.title === 'Drafts per chat')!
    k.store.saveWorkspace({ ...old, leadChatId: undefined })
    expect((await run(first, 'create_workspace', { agent: 'kai', title: 'Drafts per chat', brief: 'Go' })).text).toMatch(/^Created /)
  })
})
