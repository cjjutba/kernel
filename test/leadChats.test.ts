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

// Keeps the deps the Kernel hands the Lead's server, so the tests can call one chat's tools.
let wired: KernelToolDeps | undefined
vi.mock('../src/main/services/kernelMcp', async (original) => {
  const m = await original<typeof import('../src/main/services/kernelMcp')>()
  return { ...m, kernelMcpServer: (d: KernelToolDeps) => { wired = d; return m.kernelMcpServer(d) } }
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
    k['leadTools'](room.id, rowan, chat)
    const tool = kernelTools(wired!).find((t) => t.name === name)!
    const r = await tool.handler(args as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  const call = async (chat: Chat, name: string, args: Record<string, unknown>) => (await run(chat, name, args)).text
  const byTitle = (title: string) => k.store.workspaces(room.id).find((w) => w.title === title)!
  const target = (owner?: string) => k['leadUpdateTarget'](room.id, owner) as { chat: Chat; closed?: Chat } | undefined
  return { k, room, first, icons, call, run, byTitle, target, sent, answer, where, rowan }
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
    const closed = k.store.chat(icons.id)!
    expect(target(icons.id)).toEqual({ chat: first, closed })
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

  it('sends a message the Lead wrote while setup ran after the brief, and holds both when setup fails', async () => {
    for (const [script, fails] of [['sleep 0.4', false], ['sleep 0.4 && false', true]] as const) {
      const { k, room, first, call, sent } = await setup({ '.kernel/settings.toml': `[scripts]\nsetup = "${script}"\n` })
      const made = k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: first.id })
      const ws = await vi.waitFor(() => { const w = k.store.workspaces(room.id).find((x) => x.title === 'Invoice table'); if (!w) throw new Error('not yet'); return w })
      expect(ws.status).toBe('setup')
      expect(await call(first, 'message_agent', { workspace_id: ws.id, text: 'Use EmptyState' })).toBe("Kai's workspace is still setting up, so the message waits behind the brief.")
      await made
      const chat = k.store.chats(ws.id)[0]
      if (fails) expect(k.sessions.queued(chat.id).map((q) => [(q.parts[0] as { text: string }).text, q.from])).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
      else expect(sent.filter((x) => x.chatId === chat.id).map((x) => [x.text, x.from])).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
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
    const pr = { state: 'cifail' as PrState, checks: [{ name: 'test', state: 'fail' }] as PrCheck[] }
    k.github = { info: async (_cwd, _ref, workspaceId) => ({ workspaceId, number: 7, url: 'https://github.com/o/r/pull/7', title: 't', state: pr.state, baseRef: 'main', checks: pr.checks, comments: [], conflicts: [] }), merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
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
    k2['leadTools'](room.id, rowan, first)
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
