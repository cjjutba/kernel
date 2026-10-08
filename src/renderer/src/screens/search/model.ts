import type { AgentDef, Approval, Room, Route, SettingsPage, Workspace } from '@shared/types'

import { roomLetter } from '../rooms/roomInfo'
import { hasChanges } from '../workspace/pr/model'

export type Section = 'Suggested' | 'Go to' | 'Rooms' | 'Results'

export interface PaletteItem {
  id: string
  section: Exclude<Section, 'Results'>
  label: string
  /** The small mark on the left: a glyph from the canvas, or a room's letter. */
  glyph: string
  /** Shortcut caps shown on the right, one string per key. */
  keys?: string[]
  /** Lowercase extra words the fuzzy search also matches, so "preferences" finds Settings. */
  also?: string
  run: () => void
}

/** Settings pages the palette can jump to, with the names the Settings sidebar uses. */
export const settingsPages: [SettingsPage, string][] = [
  ['general', 'General'], ['appearance', 'Appearance'], ['notifications', 'Notifications'], ['account', 'Account and usage'], ['shortcuts', 'Keyboard shortcuts'],
  ['models', 'Models'], ['agents', 'Agents'], ['permissions', 'Permissions'], ['skills', 'Skills'],
  ['git', 'Git and worktrees'], ['scripts', 'Scripts'], ['prs', 'Pull requests'], ['files', 'Files'],
  ['hooks', 'Hooks'], ['integrations', 'Integrations'], ['experimental', 'Experimental'], ['about', 'About']
]

/**
 * How well `query` matches `text`: 0 for no match, higher is better. Every query character must appear in order.
 * Starts of words and runs of consecutive characters score more, and a shorter text beats a longer one.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = text.toLowerCase()
  const whole = t.indexOf(q)
  if (whole >= 0) return 1000 - whole * 4 - t.length + (whole === 0 || /\W/.test(t[whole - 1]) ? 200 : 0)
  let score = 0, at = 0, run = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const i = t.indexOf(ch, at)
    if (i < 0) return 0
    run = i === at && score > 0 ? run + 1 : 0
    score += 10 + run * 8 + (i === 0 || /\W/.test(t[i - 1]) ? 14 : 0) - Math.min(i - at, 6)
    at = i + 1
  }
  return Math.max(1, score - t.length / 4)
}

/** Items that match, best first. An empty query keeps the order given. */
export function rank<T extends { label: string; also?: string }>(items: T[], query: string): T[] {
  if (!query.trim()) return items
  return items
    .map((it) => ({ it, s: Math.max(fuzzyScore(query, it.label), fuzzyScore(query, `${it.label} ${it.also ?? ''}`) * 0.6) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it)
}

export interface PaletteInput {
  route: Route
  rooms: Room[]
  workspaces: Workspace[]
  approvals: Approval[]
  /** By room id. */
  agents: Record<string, AgentDef[]>
  act: {
    go: (route: Route) => void
    newWorkspace: (roomId?: string) => void
    newRoom: () => void
    whatsNew: () => void
    approve: (a: Approval) => void
    newChat: (workspaceId: string, kind?: 'terminal') => void
    /** The room's Lead chat, made on first use (`lead.open`). */
    openLead: (roomId: string) => void
  }
}

/** The room the user is looking at, falling back to the first visible one. */
export function roomInView(route: Route, rooms: Room[], workspaces: Workspace[]): Room | undefined {
  const id = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : undefined
  return rooms.find((r) => r.id === id) ?? rooms.find((r) => !r.hidden && !r.archived)
}

const live = (w: Workspace) => w.status !== 'archived' && w.name !== 'lead'

/** "Run pnpm drizzle-kit push" becomes "pnpm drizzle-kit push", for "Approve Noor: pnpm drizzle-kit push". */
const approvalLabel = (a: Approval, who?: string) => `Approve ${who ? `${who}: ` : ''}${a.title.replace(/^Run (?:(?:pnpm|npm|yarn|npx) )?/, '')}`

/** Everything the palette can run. Suggested depends on where you are; Go to and Rooms are the same everywhere. */
export function buildItems(i: PaletteInput): { items: PaletteItem[]; more: PaletteItem[] } {
  const { route, rooms, workspaces, approvals, act } = i
  const room = roomInView(route, rooms, workspaces)
  const visible = rooms.filter((r) => !r.archived)
  const current = route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId) : undefined
  // Same rule as the PR header: a workspace with no changes has nothing to open a PR for.
  const canPr = (w: Workspace) => w.prState === 'none' && hasChanges(w)
  const forPr = current && canPr(current) ? current : workspaces.filter((w) => live(w) && canPr(w) && (!room || w.roomId === room.id)).sort((a, b) => b.createdAt - a.createdAt)[0]
  const pending = approvals.find((a) => a.status === 'pending' && a.kind === 'tool')
  const nameOf = (roomId?: string, agentId?: string) => (roomId ? i.agents[roomId]?.find((a) => a.id === agentId)?.name : undefined)
  const leadAgent = room ? i.agents[room.id]?.find((a) => a.lead) : undefined
  const lead = leadAgent?.name || 'the Lead'
  const item = (id: string, section: PaletteItem['section'], glyph: string, label: string, run: () => void, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, section, glyph, label, run, ...extra })

  const suggested: PaletteItem[] = [
    item('new-ws', 'Suggested', '+', room ? `New workspace in ${room.name}` : 'New workspace', () => act.newWorkspace(room?.id), { keys: ['⌘', '⇧', 'N'] }),
    ...(forPr ? [item('create-pr', 'Suggested', '↗', `Create PR for ${forPr.name}`, () => act.go({ name: 'workspace', workspaceId: forPr.id }), { keys: ['⌘', '⇧', 'P'], also: 'pull request' })] : []),
    ...(pending ? [item('approve', 'Suggested', '✓', approvalLabel(pending, nameOf(pending.roomId, pending.agentId)), () => act.approve(pending), { keys: ['⌘', '↵'], also: 'allow permission' })] : []),
    ...(room ? [item('brief', 'Suggested', '›', `Brief ${lead}`, () => act.go({ name: 'floor', roomId: room.id }), { also: 'lead ask' })] : []),
    ...(room && leadAgent ? [item('lead-chat', 'Suggested', '›', `Open ${lead}'s chat`, () => act.openLead(room.id), { keys: ['⌘', '⇧', 'L'], also: 'lead chat workspace' })] : []),
    ...(current ? [
      item('new-chat', 'Suggested', '+', 'New chat tab', () => act.newChat(current.id), { keys: ['⌘', 'T'] }),
      item('terminal', 'Suggested', '>', 'Big terminal tab', () => act.newChat(current.id, 'terminal'), { keys: ['⌘', '⇧', 'T'], also: 'shell' })
    ] : [])
  ]

  const shown = current ?? workspaces.filter((w) => live(w) && (!room || w.roomId === room.id)).sort((a, b) => b.createdAt - a.createdAt)[0]
  const goto = (id: string, label: string, route: Route, extra: Partial<PaletteItem> = {}) => item(id, 'Go to', '◇', label, () => act.go(route), extra)
  const goDefault: PaletteItem[] = [
    goto('go-inbox', 'Inbox', { name: 'inbox' }, { keys: ['G', 'I'] }),
    ...(room ? [goto('go-floor', `${room.name} floor`, { name: 'floor', roomId: room.id })] : []),
    ...(shown ? [goto('go-ws', `${shown.name} workspace`, { name: 'workspace', workspaceId: shown.id })] : []),
    goto('go-settings', 'Settings: Git and worktrees', { name: 'settings', page: 'git' }, { keys: ['⌘', ','], also: 'preferences' }),
    ...(room ? [goto('go-team', 'Team', { name: 'team', roomId: room.id }, { also: 'agents' })] : []),
    goto('go-history', 'History', { name: 'history' }, { also: 'archived restore' }),
    item('go-new', 'Go to', '◇', "What's new", act.whatsNew, { also: 'update release notes' })
  ]

  const roomItems: PaletteItem[] = [
    ...visible.map((r) => item(`room-${r.id}`, 'Rooms', roomLetter(r.name), r.name, () => act.go({ name: 'floor', roomId: r.id }))),
    item('room-new', 'Rooms', '+', 'New room', act.newRoom, { also: 'add connect repo' })
  ]

  // Typing searches these too, so the default list stays short.
  const more: PaletteItem[] = [
    goto('go-home', 'Home', { name: 'home' }),
    goto('go-rooms', 'All rooms', { name: 'rooms' }),
    ...visible.flatMap((r) => {
      const roomLead = i.agents[r.id]?.find((a) => a.lead)
      return [
        goto(`go-floor-${r.id}`, `${r.name} floor`, { name: 'floor', roomId: r.id }),
        goto(`go-board-${r.id}`, `${r.name} board`, { name: 'board', roomId: r.id }, { also: 'tasks' }),
        goto(`go-team-${r.id}`, `${r.name} team`, { name: 'team', roomId: r.id }, { also: 'agents' }),
        // The room in view has "Open Rowan's chat" above, which "lead chat" finds first. These say whose chat, not "lead chat",
        // so a shorter room name can't outrank it.
        ...(roomLead && r.id !== room?.id ? [item(`go-lead-${r.id}`, 'Go to', '◇', `${roomLead.name}'s chat in ${r.name}`, () => act.openLead(r.id), { also: 'lead workspace' })] : [])
      ]
    }),
    ...workspaces.filter(live).map((w) => goto(`go-ws-${w.id}`, `${w.name} workspace`, { name: 'workspace', workspaceId: w.id }, { also: w.branch })),
    ...settingsPages.filter(([p]) => p !== 'git').map(([p, label]) => goto(`go-set-${p}`, `Settings: ${label}`, { name: 'settings', page: p }, { also: 'preferences' }))
  ]

  return { items: [...suggested, ...goDefault, ...roomItems], more }
}

/** What the list shows for a query. No query: the three sections. A query: one ranked list over everything. */
export function visibleItems(items: PaletteItem[], more: PaletteItem[], query: string): { section: Section; list: PaletteItem[] }[] {
  if (!query.trim()) return (['Suggested', 'Go to', 'Rooms'] as const).map((section) => ({ section, list: items.filter((x) => x.section === section) })).filter((g) => g.list.length)
  const seen = new Set<string>()
  const all = [...items, ...more].filter((x) => (seen.has(x.label) ? false : (seen.add(x.label), true)))
  const list = rank(all, query)
  return list.length ? [{ section: 'Results', list }] : []
}
