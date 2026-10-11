import { describe, expect, it } from 'vitest'
import { buildItems, fuzzyScore, rank, visibleItems } from '../src/renderer/src/screens/search/model'
import { groupOf, inTab, matches, prLabel } from '../src/renderer/src/screens/history/model'
import type { AgentDef, Room, SharedFile, Workspace } from '../src/shared/types'

const room = (id: string, name: string): Room => ({ id, name, path: `/p/${id}`, defaultBranch: 'main', paused: false, createdAt: 0 })
const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, roomId: 'a', name: id, branch: `feat/${id}`, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'none', createdAt: 1, ...over })
const act = { go: () => undefined, newWorkspace: () => undefined, newRoom: () => undefined, whatsNew: () => undefined, approve: () => undefined, newChat: () => undefined, openLead: () => undefined, openRoom: () => undefined, openShared: () => undefined }
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
    const input = { rooms, workspaces, approvals: [], shared: [], agents: {}, act }
    const home = buildItems({ ...input, route: { name: 'home' } })
    expect(home.items.filter((i) => i.section === 'Suggested').map((i) => i.label)).toEqual(['New chat in Client A', 'Create PR for invoice-table'])
    expect(home.items.filter((i) => i.section === 'Rooms').map((i) => i.label)).toEqual(['Client A', 'Client B', 'New room'])
    const inWs = buildItems({ ...input, terminal: { enabled: true }, route: { name: 'workspace', workspaceId: 'invoice-table' } })
    expect(inWs.items.map((i) => i.label)).toContain('Big terminal tab')
    // Typing searches the longer list, one ranked group.
    const found = visibleItems(inWs.items, inWs.more, 'appear')
    expect(found).toHaveLength(1)
    expect(found[0].list.map((i) => i.label)).toEqual(['Settings: Appearance'])
  })

  it('offers a big terminal tab that names the preset, and only while the big terminal is on', () => {
    const rooms = [room('a', 'Client A')]
    const workspaces = [ws('invoice-table')]
    const route = { name: 'workspace', workspaceId: 'invoice-table' } as const
    const entry = (terminal?: { enabled: boolean; preset?: string }) =>
      buildItems({ rooms, workspaces, approvals: [], shared: [], agents: {}, act, route, terminal }).items.find((i) => i.id === 'terminal')?.label
    expect(entry({ enabled: true, preset: 'Codex' })).toBe('Big terminal tab: Codex')
    expect(entry({ enabled: true })).toBe('Big terminal tab')
    // Off, or settings that haven't loaded yet: main would refuse the tab.
    expect(entry({ enabled: false, preset: 'Codex' })).toBeUndefined()
    expect(entry()).toBeUndefined()
  })

  it('suggests Create PR only for a workspace with changes', () => {
    const rooms = [room('a', 'Client A')]
    const labels = (workspaces: Workspace[], route: Parameters<typeof buildItems>[0]['route']) =>
      buildItems({ rooms, workspaces, approvals: [], shared: [], agents: {}, act, route }).items.map((i) => i.label).filter((l) => l.startsWith('Create PR for'))
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
    const input = { rooms, workspaces: [], approvals: [], shared: [], agents: { a: [rowan], b: [{ ...rowan, name: 'Sol' }], o: [{ ...rowan, name: 'Oz' }] }, act: { ...act, openLead: (id: string) => { opened.push(id) } } }
    const home = buildItems({ ...input, route: { name: 'home' } })
    const suggested = home.items.filter((i) => i.section === 'Suggested')
    expect(suggested.map((i) => i.label)).toEqual(['New chat in Client A', "Open Rowan's chat"])
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

describe('command palette, shared files', () => {
  const rooms = [room('a', 'Client A'), room('b', 'Client B')]
  const noor: AgentDef = { ...rowan, id: 'noor', name: 'Noor', role: 'Engine', lead: false }
  const agents = { a: [rowan, noor], b: [rowan] }
  const file = (id: string, over: Partial<SharedFile> = {}): SharedFile => ({
    id, roomId: 'a', workspaceId: 'w1', agentId: 'noor', source: `.kernel/shared/${id}.html`, title: `File ${id}`, kind: 'html',
    versions: [{ n: 1, at: 1, file: 'v1', mime: 'text/html', bytes: 10, sha256: id }], createdAt: 1, updatedAt: 1, ...over
  })
  const workspaces = [ws('w1', { roomId: 'a' }), ws('w2', { roomId: 'a', agentId: 'noor' }), ws('lead', { roomId: 'a', name: 'lead', agentId: 'rowan' }), ws('wb', { roomId: 'b', agentId: 'rowan' })]
  const base = { rooms, workspaces, approvals: [], agents, act }
  const shared = (list: SharedFile[], route: Parameters<typeof buildItems>[0]['route'] = { name: 'workspace', workspaceId: 'w1' }, extra: Partial<Parameters<typeof buildItems>[0]> = {}) => buildItems({ ...base, shared: list, route, ...extra })
  const ids = (list: { id: string }[]) => list.map((x) => x.id)

  it('lists the five newest files in the room in view before you type, newest first', () => {
    const list = ['1', '2', '3', '4', '5', '6', '7'].map((n) => file(n, { updatedAt: Number(n) }))
    const other = file('b1', { roomId: 'b', workspaceId: 'wb', updatedAt: 99 })
    const built = shared([...list, other])
    expect(ids(built.items.filter((i) => i.section === 'Shared'))).toEqual(['shared-7', 'shared-6', 'shared-5', 'shared-4', 'shared-3'])
    expect(visibleItems(built.items, built.more, '').map((g) => g.section)).toEqual(['Suggested', 'Shared', 'Go to', 'Rooms'])
    // Another room's files, and the two older ones, are only found by typing.
    expect(ids(built.more.filter((i) => i.section === 'Shared')).sort()).toEqual(['shared-1', 'shared-2', 'shared-b1'])
    // A room in view with nothing shared has no group.
    const bare = shared([file('1')], { name: 'room', roomId: 'b' } as never)
    expect(bare.items.some((i) => i.section === 'Shared')).toBe(false)
  })

  it('says what a file is and who shared it', () => {
    const f = file('1', { title: 'Invoice layout options', versions: [{ n: 1, at: 1, file: 'v1', mime: 'text/html', bytes: 1, sha256: 'a' }, { n: 2, at: 2, file: 'v2', mime: 'text/html', bytes: 1, sha256: 'b' }], updatedAt: Date.now() - 2 * 3_600_000 })
    const it = shared([f]).items.find((i) => i.section === 'Shared')!
    expect(it.label).toBe('Invoice layout options')
    expect(it.meta).toBe('HTML · v2 · Noor · 2h')
  })

  it('finds a file by title, type, source path or the agent that shared it, best match first', () => {
    const list = [
      file('layout', { title: 'Invoice layout options', updatedAt: 5 }),
      file('fonts', { title: 'Embedded fonts check', kind: 'image', source: '.kernel/shared/fonts-check.png', agentId: 'kai', updatedAt: 4, versions: [{ n: 1, at: 1, file: 'v1', mime: 'image/png', bytes: 1, sha256: 'c' }] }),
      file('notes', { title: 'PDF renderer notes', kind: 'markdown', source: 'docs/renderer.md', updatedAt: 3 }),
      file('theirs', { title: 'Totals page', roomId: 'b', workspaceId: 'wb', agentId: 'rowan', updatedAt: 9 })
    ]
    const found = (q: string) => { const b = shared(list, { name: 'workspace', workspaceId: 'w1' }, { agents: { ...agents, a: [rowan, noor, { ...noor, id: 'kai', name: 'Kai' }] } }); return visibleItems(b.items, b.more, q).flatMap((g) => g.list).filter((i) => i.section === 'Shared').map((i) => i.id) }
    // Title, with the best match first.
    expect(found('layout')[0]).toBe('shared-layout')
    expect(found('renderer')[0]).toBe('shared-notes')
    // Agent name, type and source path. The search is fuzzy, so a looser file may follow; the right one is first.
    expect(found('kai')[0]).toBe('shared-fonts')
    expect(found('markdown')[0]).toBe('shared-notes')
    expect(found('fonts-check.png')[0]).toBe('shared-fonts')
    // Every room's files, not only the one in view.
    expect(found('totals')).toEqual(['shared-theirs'])
    expect(found('rowan')[0]).toBe('shared-theirs')
    // Two files with one title are both listed.
    const twins = shared([file('x', { title: 'Same' }), file('y', { title: 'Same', roomId: 'b', workspaceId: 'wb' })])
    expect(visibleItems(twins.items, twins.more, 'same')[0].list.filter((i) => i.section === 'Shared')).toHaveLength(2)
  })

  it('opens in the sharing workspace, else the one on screen, else the room\'s Lead workspace', () => {
    const opened: string[] = []
    const act2 = { ...act, openShared: (w: string, s: string) => { opened.push(`${w}:${s}`) } }
    const open = (f: SharedFile, route: Parameters<typeof buildItems>[0]['route'], list = workspaces) => {
      const b = buildItems({ ...base, workspaces: list, shared: [f], route, act: act2 })
      visibleItems(b.items, b.more, 'file')[0]?.list.find((i) => i.section === 'Shared')?.run()
    }
    // Still open: its own workspace, wherever you are.
    open(file('s'), { name: 'workspace', workspaceId: 'w2' })
    // Archived: the workspace on screen.
    const archived = workspaces.map((w) => (w.id === 'w1' ? { ...w, status: 'archived' as const } : w))
    open(file('s'), { name: 'workspace', workspaceId: 'w2' }, archived)
    // Not on a workspace: the Lead's.
    open(file('s'), { name: 'home' }, archived)
    expect(opened).toEqual(['w1:s', 'w2:s', 'lead:s'])
    // No workspace to open it in: nothing to run, so it is not listed.
    const none = buildItems({ ...base, workspaces: [], shared: [file('s')], route: { name: 'home' } })
    expect([...none.items, ...none.more].some((i) => i.section === 'Shared')).toBe(false)
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
