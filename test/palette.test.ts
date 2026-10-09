import { describe, expect, it } from 'vitest'
import { buildItems, fuzzyScore, rank, visibleItems } from '../src/renderer/src/screens/search/model'
import { groupOf, inTab, matches, prLabel } from '../src/renderer/src/screens/history/model'
import type { AgentDef, Room, Workspace } from '../src/shared/types'

const room = (id: string, name: string): Room => ({ id, name, path: `/p/${id}`, defaultBranch: 'main', paused: false, createdAt: 0 })
const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, roomId: 'a', name: id, branch: `feat/${id}`, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'none', createdAt: 1, ...over })
const act = { go: () => undefined, newWorkspace: () => undefined, newRoom: () => undefined, whatsNew: () => undefined, approve: () => undefined, newChat: () => undefined, openLead: () => undefined, openRoom: () => undefined }
const rowan: AgentDef = { id: 'rowan', name: 'Rowan', role: 'Lead', description: 'Lead.', model: 'opus', lead: true, prompt: '', file: '.claude/agents/rowan.md' }

describe('command palette', () => {
  it('matches in order, prefers word starts and shorter text, and rejects the rest', () => {
    expect(fuzzyScore('xyz', 'Inbox')).toBe(0)
    expect(fuzzyScore('ibx', 'Inbox')).toBeGreaterThan(0)
    expect(fuzzyScore('hist', 'History')).toBeGreaterThan(fuzzyScore('hist', 'Settings: Hooks list'))
    expect(rank([{ label: 'Settings: Git and worktrees' }, { label: 'Team' }, { label: 'History' }], 'tm').map((x) => x.label)).toEqual(['Team'])
    expect(rank([{ label: 'Team', also: 'agents' }], 'agents')).toHaveLength(1)
  })

  it('suggests from where you are and lists every room', () => {
    const rooms = [room('a', 'Client A'), room('b', 'Client B')]
    const workspaces = [ws('invoice-table', { stat: { files: 4, added: 412, removed: 38 } })]
    const input = { rooms, workspaces, approvals: [], agents: {}, act }
    const home = buildItems({ ...input, route: { name: 'home' } })
    expect(home.items.filter((i) => i.section === 'Suggested').map((i) => i.label)).toEqual(['New workspace in Client A', 'Create PR for invoice-table'])
    expect(home.items.filter((i) => i.section === 'Rooms').map((i) => i.label)).toEqual(['Client A', 'Client B', 'New room'])
    const inWs = buildItems({ ...input, route: { name: 'workspace', workspaceId: 'invoice-table' } })
    expect(inWs.items.map((i) => i.label)).toContain('Big terminal tab')
    // Typing searches the longer list, one ranked group.
    const found = visibleItems(inWs.items, inWs.more, 'appear')
    expect(found).toHaveLength(1)
    expect(found[0].list.map((i) => i.label)).toEqual(['Settings: Appearance'])
  })

  it('suggests Create PR only for a workspace with changes', () => {
    const rooms = [room('a', 'Client A')]
    const labels = (workspaces: Workspace[], route: Parameters<typeof buildItems>[0]['route']) =>
      buildItems({ rooms, workspaces, approvals: [], agents: {}, act, route }).items.map((i) => i.label).filter((l) => l.startsWith('Create PR for'))
    const stat = (files: number) => ({ files, added: files, removed: 0 })
    const here = { name: 'workspace', workspaceId: 'a1' } as const
    expect(labels([ws('a1')], here)).toEqual([])
    expect(labels([ws('a1', { stat: stat(0) })], { name: 'home' })).toEqual([])
    expect(labels([ws('a1', { stat: stat(2) })], here)).toEqual(['Create PR for a1'])
    // The current workspace is empty, so the suggestion falls back to the newest one in the room that has changes.
    expect(labels([ws('a1', { stat: stat(0) }), ws('a2', { stat: stat(3), createdAt: 2 }), ws('a3', { createdAt: 3 })], here)).toEqual(['Create PR for a2'])
  })

  it("opens the Lead's chat in the room in view, and finds any room's Lead by typing", () => {
    const opened: string[] = []
    // A short room name used to outrank the room in view.
    const rooms = [room('a', 'Client A'), room('b', 'Client B'), room('o', 'Own')]
    const input = { rooms, workspaces: [], approvals: [], agents: { a: [rowan], b: [{ ...rowan, name: 'Sol' }], o: [{ ...rowan, name: 'Oz' }] }, act: { ...act, openLead: (id: string) => { opened.push(id) } } }
    const home = buildItems({ ...input, route: { name: 'home' } })
    const suggested = home.items.filter((i) => i.section === 'Suggested')
    expect(suggested.map((i) => i.label)).toEqual(['New workspace in Client A', "Open Rowan's chat"])
    expect(suggested[1].keys).toEqual(['⌘', '⇧', 'L'])
    suggested[1].run()
    // Typing "lead chat" puts the room in view first, and other rooms' Leads are found by name.
    expect(visibleItems(home.items, home.more, 'lead chat')[0].list[0].label).toBe("Open Rowan's chat")
    expect(home.more.map((i) => i.label)).not.toContain("Rowan's chat in Client A")
    const found = visibleItems(home.items, home.more, 'sol')[0].list
    expect(found[0].label).toBe("Sol's chat in Client B")
    found[0].run()
    expect(opened).toEqual(['a', 'b'])
    // A room with no Lead has nothing to open.
    expect(buildItems({ ...input, agents: {}, route: { name: 'home' } }).items.map((i) => i.id)).not.toContain('lead-chat')
  })
})

describe('history', () => {
  it('groups by day, filters by merged and finds by branch, room or agent', () => {
    const now = new Date(2026, 9, 7, 15, 0).getTime()
    expect(groupOf(new Date(2026, 9, 7, 9, 0).getTime(), now)).toBe('Today')
    expect(groupOf(new Date(2026, 9, 4, 9, 0).getTime(), now)).toBe('This week')
    expect(groupOf(new Date(2026, 8, 20, 9, 0).getTime(), now)).toBe('Earlier')
    const merged = ws('m', { prState: 'merged', prNumber: 41 })
    expect([inTab(merged, 'merged'), inTab(merged, 'notMerged'), inTab(ws('x'), 'notMerged')]).toEqual([true, false, true])
    expect(prLabel(merged)).toBe('#41 merged')
    expect(prLabel(ws('x'))).toBe('No PR')
    expect(matches(merged, 'feat client noor', 'Client A', 'Kai')).toBe(false)
    expect(matches(merged, 'feat client kai', 'Client A', 'Kai')).toBe(true)
  })
})
