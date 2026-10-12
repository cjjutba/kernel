import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Chat, ChatArchivePreview, Room, Thread, Workspace } from '../src/shared/types'

// The chat row's Archive and closing a chat's last tab (KERNEL-405): one click when nothing would be lost, else the confirm.
let preview: ChatArchivePreview | null = null
const calls: { channel: string; req: unknown }[] = []
vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => String(e),
  onPush: () => () => undefined,
  call: async (channel: string, req: unknown) => {
    calls.push({ channel, req })
    if (channel === 'threads.archivePreview') { if (!preview) throw new Error('gone'); return preview }
    // Main stores the archived workspace and pushes it before it answers.
    if (channel === 'threads.archive') {
      const { apply, getState } = await import('../src/renderer/src/store')
      for (const w of getState().workspaces.filter((x) => x.threadId === (req as { threadId: string }).threadId)) apply({ type: 'workspace', workspace: { ...w, status: 'archived', archivedAt: 9 } })
    }
    return { ok: true }
  }
}))

const { actions, getState, setState } = await import('../src/renderer/src/store')
const { archiveChatFromSidebar, stopsSomething } = await import('../src/renderer/src/screens/workspace/archiveChat')
const { followArchives } = await import('../src/renderer/src/screens/workspace/archiveLanding')
const { archivedList, historyName } = await import('../src/renderer/src/screens/history/model')

const room: Room = { id: 'r1', name: 'Client A', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 }
const rowan = { id: 'rowan', lead: true } as AgentDef
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: 'r1', name: id, branch: `rowan/${id}`, baseRef: 'origin/main', path: `/w/${id}`, mode: 'worktree', agentId: 'rowan', lead: true, port: 0, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const thread = (id: string, at: number): Thread => ({ id, roomId: 'r1', title: `Chat ${id}`, createdAt: at })
const tab = (id: string, workspaceId: string, threadId: string): Chat => ({ id, workspaceId, threadId, title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 })
const clean = (id: string): ChatArchivePreview['workspaces'][number] => ({ id, name: id, own: true, running: false, dirty: 0, unpushed: 0 })

let stop: () => void
beforeEach(() => {
  stop = followArchives()
  calls.length = 0
  setState({
    rooms: [room], agents: { r1: [rowan] },
    workspaces: [ws('a', { threadId: 't1' }), ws('b', { threadId: 't2' })],
    threads: { t1: thread('t1', 1), t2: thread('t2', 2) },
    chats: { a: [tab('a1', 'a', 't1')], b: [tab('b1', 'b', 't2')] }
  })
  setState((s) => ({ ui: { ...s.ui, route: { name: 'workspace', workspaceId: 'b' }, modal: null, toasts: [], tabs: {} } }))
})

afterEach(() => stop())

describe('archiving a chat with Rowan from the sidebar (KERNEL-405)', () => {
  it("archives in one click when nothing would be lost, adds no toast, and goes to the room's front door (KERNEL-596)", async () => {
    preview = { threadId: 't2', title: 'Chat t2', workspaces: [clean('b')] }
    await archiveChatFromSidebar(getState().threads.t2)
    expect(calls.map((c) => c.channel)).toEqual(['threads.archivePreview', 'threads.archive'])
    expect(getState().ui.toasts).toEqual([])
    expect(getState().ui.modal).toBeNull()
    expect(getState().ui.route).toEqual({ name: 'leadNew', roomId: 'r1' })
  })

  it('asks first when it would stop a running agent, an open PR, uncommitted changes or unpushed commits, or when it cannot tell', async () => {
    for (const row of [{ running: true }, { pr: 41 }, { dirty: 2 }, { unpushed: 1 }, { unknown: true }]) {
      calls.length = 0
      preview = { threadId: 't2', title: 'Chat t2', workspaces: [{ ...clean('kai'), own: false, ...row }, clean('b')] }
      expect(stopsSomething(preview.workspaces[0])).toBe(true)
      await archiveChatFromSidebar(getState().threads.t2)
      expect(calls.map((c) => c.channel)).toEqual(['threads.archivePreview'])
      expect(getState().ui.modal).toEqual({ name: 'confirm', kind: 'archiveChat', threadId: 't2' })
      actions.ui.closeModal()
    }
    preview = null
    await archiveChatFromSidebar(getState().threads.t2)
    expect(getState().ui.modal).toEqual({ name: 'confirm', kind: 'archiveChat', threadId: 't2' })
  })
})

describe('History and chats with Rowan (KERNEL-405)', () => {
  it("lists an archived chat by its title, and leaves out the shared Lead workspace from before", () => {
    const list = [ws('a', { threadId: 't1', status: 'archived', archivedAt: 5, name: 'lead' }), ws('old', { name: 'lead', status: 'archived', archivedAt: 6 }), ws('kai', { lead: undefined, agentId: 'kai', status: 'archived', archivedAt: 4 })]
    expect(archivedList(list).map((w) => w.id)).toEqual(['a', 'kai'])
    expect(historyName(list[0], getState().threads)).toBe('Chat t1')
    expect(historyName(list[2], getState().threads)).toBe('kai')
  })
})
