import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtures } from '../fixtures'
import { fixtureHandlers } from '../src/main/fixtures'

const entries = Object.entries(fixtures)
/** Fixtures for states the canvas doesn't draw, kept for screenshots (DECISIONS.md says which). */
const noCanvas = ['WorkspaceTabStates', 'WorkspaceDiffTab', 'WorkspaceLeadPlan', 'WorkspaceLeadUpdate', 'WorkspaceContextRing', 'WorkspaceContextPopover', 'InboxOverlap', 'TeamEmpty', 'QuickAskAnswered', 'QuickAskOpenChat', 'QuickAskLeadGone', 'SidebarLeadChats']

describe('fixtures', () => {
  it('every fixture key has a PNG in design/screens, except the DevUi component gallery and noCanvas', () => {
    const missing = entries.map(([name]) => name).filter((name) => !name.startsWith('DevUi') && !noCanvas.includes(name) && !existsSync(join('design/screens', `${name}.png`)))
    expect(missing).toEqual([])
  })

  it.each(entries)('%s points only at things that exist', (_name, f) => {
    const rooms = new Set(f.rooms.map((r) => r.id))
    const workspaces = new Set(f.workspaces.map((w) => w.id))
    const chats = new Set(f.chats.map((c) => c.id))
    const agentIn = (roomId: string, agentId: string) => (f.agents[roomId] ?? []).some((a) => a.id === agentId)

    for (const w of f.workspaces) {
      expect(rooms.has(w.roomId), `workspace ${w.id} room`).toBe(true)
      expect(agentIn(w.roomId, w.agentId), `workspace ${w.id} agent`).toBe(true)
    }
    for (const c of f.chats) expect(workspaces.has(c.workspaceId), `chat ${c.id} workspace`).toBe(true)
    for (const id of Object.keys(f.items)) expect(chats.has(id), `items for chat ${id}`).toBe(true)
    for (const id of [...Object.keys(f.changes), ...Object.keys(f.diffs)]) expect(workspaces.has(id), `changes for ${id}`).toBe(true)
    for (const a of f.approvals) {
      if (a.roomId) expect(rooms.has(a.roomId), `approval ${a.id} room`).toBe(true)
      if (a.workspaceId) expect(workspaces.has(a.workspaceId), `approval ${a.id} workspace`).toBe(true)
      if (a.roomId && a.agentId) expect(agentIn(a.roomId, a.agentId), `approval ${a.id} agent`).toBe(true)
    }
    for (const [roomId, byAgent] of Object.entries(f.status)) for (const agentId of Object.keys(byAgent)) expect(agentIn(roomId, agentId), `status ${agentId}`).toBe(true)
    for (const e of f.push) {
      if ('workspaceId' in e) expect(workspaces.has(e.workspaceId), `push ${e.type} workspace`).toBe(true)
      if ('chatId' in e) expect(chats.has(e.chatId), `push ${e.type} chat`).toBe(true)
    }
    if (f.ui.route && 'roomId' in f.ui.route && f.ui.route.roomId) expect(rooms.has(f.ui.route.roomId)).toBe(true)
    if (f.ui.route?.name === 'workspace') expect(workspaces.has(f.ui.route.workspaceId)).toBe(true)
  })
})

describe('fixture handlers', () => {
  const f = fixtures.Workspace
  const h = fixtureHandlers(f)

  it('serve the fixture', async () => {
    expect(await h['rooms.list']()).toEqual(f.rooms)
    const [chat] = await h['chats.list']({ workspaceId: 'ws-invoice-table' })
    expect((await h['chats.items']({ chatId: chat.id })).length).toBeGreaterThan(0)
    expect(await h['workspaces.changes']({ workspaceId: 'ws-invoice-table' })).toHaveLength(4)
    const activity = await h['activity.recent']({ roomId: 'room-a' })
    expect(activity.map((e) => e.ts)).toEqual([...activity.map((e) => e.ts)].sort((a, b) => b - a))
  })

  it('answer writes without changing later reads', async () => {
    const before = structuredClone(f)
    await h['rooms.setPaused']({ roomId: 'room-a', paused: true })
    await h['chats.send']({ chatId: 'chat-invoice-table', parts: [{ type: 'text', text: 'hi' }] })
    await h['chats.configure']({ chatId: 'chat-invoice-table', plan: true })
    await h['chats.create']({ workspaceId: 'ws-invoice-table', kind: 'terminal' })
    const decided = await h['approvals.decide']({ id: 'ap-migrate', decision: { behavior: 'allow' } })
    expect(decided.status).toBe('allowed')
    await h['workspaces.archive']({ workspaceId: 'ws-invoice-table' })
    expect(f).toEqual(before)
    expect((await h['approvals.list']({})).find((a) => a.id === 'ap-migrate')?.status).toBe('pending')
  })

  it('refuse to create a workspace', async () => {
    await expect(h['workspaces.create']({ roomId: 'room-a', prompt: 'x' })).rejects.toThrow(/Fixture mode/)
  })
})
