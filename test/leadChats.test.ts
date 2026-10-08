import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Approval, Chat, ChatPart } from '@shared/types'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

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
async function setup() {
  const repo = await tempRepo(REPO)
  const k = new Kernel(await dirs())
  await k.start()
  onTestFinished(() => k.stop())
  const sent: { chatId: string; text: string }[] = []
  k.sessions.send = async (chatId: string, parts: ChatPart[]) => { sent.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }); return { queued: false } }
  const room = await k.addRoom(repo)
  const first = await k.leadChat(room.id)
  const icons = k.newChat(first.workspaceId, 'Chat icons sizing', { model: first.model, effort: first.effort, plan: false })
  const rowan = (await k.agents(room.id)).find((a) => a.lead) as AgentDef
  const call = async (chat: Chat, name: string, args: Record<string, unknown>) => {
    k['leadTools'](room.id, rowan, chat)
    const tool = kernelTools(wired!).find((t) => t.name === name)!
    return ((await tool.handler(args as never, {})).content[0] as { text: string }).text
  }
  const byTitle = (title: string) => k.store.workspaces(room.id).find((w) => w.title === title)!
  const target = (owner?: string) => k['leadUpdateTarget'](room.id, owner) as { chat: Chat; closed?: Chat } | undefined
  return { k, room, first, icons, call, byTitle, target, sent }
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
