import type { AccountProfile, AgentDef, Approval, Chat, Provider, Room, Route, SettingsPage, SharedFile, Thread, Workspace } from '@shared/types'

import { workspaceRowLabel } from '../../components/sidebar/workspaceRowLabel'
import { PROVIDER_NAME } from '../../accountRows'
import { isLeadWorkspace } from '../../lead'
import { roomLetter } from '../rooms/roomInfo'
import { ROOM_PAGES } from '../settings/roomPages'
import { hasChanges } from '../workspace/pr/model'
import { kindLabel, latestOf, sinceShort } from '../workspace/shared/shared'

export type Section = 'Suggested' | 'Chats' | 'Shared' | 'Go to' | 'Rooms' | 'Accounts' | 'Results'

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
  /** Muted text on the right, in place of shortcut caps: what a shared file is and who shared it, or how many tabs a chat holds. */
  meta?: string
  /** The heading of the group this item opens, when it isn't the section's name: "Chats in Client A". */
  group?: string
  run: () => void
}

/** Settings pages the palette can jump to, with the names the Settings sidebar uses. */
export const settingsPages: [SettingsPage, string][] = [
  ['general', 'General'], ['appearance', 'Appearance'], ['notifications', 'Notifications'], ['account', 'Account and usage'], ['shortcuts', 'Keyboard shortcuts'],
  ['models', 'Models'], ['permissions', 'Permissions'],
  ['git', 'Git and worktrees'], ['scripts', 'Scripts'], ['prs', 'Pull requests'],
  ['hooks', 'Hooks'], ['integrations', 'Integrations'], ['bigterm', 'Big terminal'], ['privacy', 'Privacy'], ['about', 'About']
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
  /** Every shared file, from the store. */
  shared: SharedFile[]
  /** By room id. */
  agents: Record<string, AgentDef[]>
  /** The open Lead chats of the room in view, in sidebar order, each with its open tabs (KERNEL-339). */
  chats?: { thread: Thread; tabs: Chat[]; ws?: Workspace }[]
  /** The big terminal's switch and the preset a new tab runs. Unset reads as off, like settings that haven't loaded (KERNEL-251). */
  terminal?: { enabled: boolean; preset?: string }
  accounts?: AccountProfile[]
  act: {
    go: (route: Route) => void
    newWorkspace: (roomId?: string) => void
    newRoom: () => void
    whatsNew: () => void
    approve: (a: Approval) => void
    /** A tab in the workspace you are in. In the Lead's workspace it joins the chat on screen. */
    newChat: (workspaceId: string, kind?: 'terminal') => void
    /** A chat of the room, on the tab last shown in it, in its own workspace (KERNEL-405). */
    openChat: (roomId: string, thread: Thread, tabs: Chat[], ws?: Workspace) => void
    /** The room's newest chat with Rowan, or New chat with Rowan when none is open (`lead.open`, KERNEL-405). */
    openLead: (roomId: string) => void
    /** Where a room opens: its Lead chat, or Team when it has no Lead (D-104). */
    openRoom: (roomId: string) => void
    /** Opens a shared file's tab in a workspace and shows that workspace. */
    openShared: (workspaceId: string, sharedId: string) => void
    /** Opens the room's newest chat with Rowan, then the file's tab in it. */
    openSharedInLead: (roomId: string, sharedId: string) => void
    /** A toast with only a title. */
    toast: (title: string) => void
    switchAccount?: (provider: Provider, accountId: string) => void
  }
}

/** The room the user is looking at, falling back to the first visible one. */
export function roomInView(route: Route, rooms: Room[], workspaces: Workspace[]): Room | undefined {
  const id = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : undefined
  return rooms.find((r) => r.id === id) ?? rooms.find((r) => !r.hidden && !r.archived)
}

/** How many shared files the palette lists before you type. */
const SHARED_DEFAULT = 5

/** A workspace row of the sidebar. A chat with Rowan's own workspace is its chat, listed under Chats (KERNEL-405). */
const live = (w: Workspace) => w.status !== 'archived' && !w.lead

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
    item('new-ws', 'Suggested', '+', room ? `New chat in ${room.name}` : 'New chat', () => act.newWorkspace(room?.id), { keys: ['⌘', 'N'] }),
    ...(forPr ? [item('create-pr', 'Suggested', '↗', `Create PR for ${workspaceRowLabel(forPr)}`, () => act.go({ name: 'workspace', workspaceId: forPr.id }), { keys: ['⌘', '⇧', 'P'], also: `pull request ${forPr.name} ${forPr.branch}` })] : []),
    ...(pending ? [item('approve', 'Suggested', '✓', approvalLabel(pending, nameOf(pending.roomId, pending.agentId)), () => act.approve(pending), { keys: ['⌘', '↵'], also: 'allow permission' })] : []),
    ...(room && leadAgent ? [item('lead-chat', 'Suggested', '›', `Open ${lead}'s chat`, () => act.openLead(room.id), { keys: ['⌘', '⇧', 'L'], also: 'lead chat workspace brief ask' })] : []),
    ...(current ? [
      item('new-tab', 'Suggested', '+', 'New tab', () => act.newChat(current.id), { keys: ['⌘', 'T'] }),
      // Main refuses a terminal tab while the big terminal is off, so the palette leaves the entry out until the settings say it is on. A new tab runs the settings' preset.
      ...(i.terminal?.enabled ? [item('terminal', 'Suggested', '>', i.terminal?.preset ? `Big terminal tab: ${i.terminal.preset}` : 'Big terminal tab', () => act.newChat(current.id, 'terminal'), { keys: ['⌘', '⇧', 'T'], also: 'shell terminal' })] : [])
    ] : [])
  ]

  // The room's open chats, each with its tab count. Typing searches them with everything else.
  const chatItems: PaletteItem[] = room
    ? (i.chats ?? []).map(({ thread, tabs, ws }) => item(`chat-${thread.id}`, 'Chats', '◇', thread.title, () => act.openChat(room.id, thread, tabs, ws), { meta: `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`, group: `Chats in ${room.name}`, also: 'chat tabs' }))
    : []

  const shown = current ?? workspaces.filter((w) => live(w) && (!room || w.roomId === room.id)).sort((a, b) => b.createdAt - a.createdAt)[0]
  const goto = (id: string, label: string, route: Route, extra: Partial<PaletteItem> = {}) => item(id, 'Go to', '◇', label, () => act.go(route), extra)
  const goDefault: PaletteItem[] = [
    goto('go-inbox', 'Inbox', { name: 'inbox' }, { keys: ['G', 'I'] }),
    goto('go-issues', 'Issues', room ? { name: 'issues', roomId: room.id } : { name: 'issues' }, { also: 'linear github tickets' }),
    ...(shown ? [goto('go-ws', `${workspaceRowLabel(shown)} workspace`, { name: 'workspace', workspaceId: shown.id }, { also: `${shown.name} ${shown.branch}` })] : []),
    goto('go-settings', 'Settings', { name: 'settings', page: 'general' }, { keys: ['⌘', ','], also: 'preferences' }),
    ...(room ? [goto('go-team', 'Team', { name: 'team', roomId: room.id }, { also: 'agents' })] : []),
    goto('go-history', 'History', { name: 'history' }, { also: 'archived restore' }),
    item('go-new', 'Go to', '◇', "What's new", act.whatsNew, { also: 'update release notes' })
  ]

  const roomItems: PaletteItem[] = [
    ...visible.map((r) => item(`room-${r.id}`, 'Rooms', roomLetter(r.name), r.name, () => act.openRoom(r.id))),
    item('room-new', 'Rooms', '+', 'New room', act.newRoom, { also: 'add connect repo' })
  ]

  // Where a shared file opens is worked out when it is picked, so a file is always listed: the sharing workspace if it is still open, else the
  // workspace on screen, else the room's Lead (made on first use), else the room's first open workspace (KERNEL-307).
  const openSharedFile = (f: SharedFile) => {
    const open = (w?: Workspace) => (w && w.status !== 'archived' ? w : undefined)
    const target = open(workspaces.find((w) => w.id === f.workspaceId)) ?? open(current)
    if (target) return act.openShared(target.id, f.id)
    const leadId = i.agents[f.roomId]?.find((a) => a.lead)?.id
    if (leadId) {
      const leadWs = workspaces.filter((w) => isLeadWorkspace(w, f.roomId, leadId)).at(-1)
      return leadWs ? act.openShared(leadWs.id, f.id) : act.openSharedInLead(f.roomId, f.id)
    }
    const any = workspaces.find((w) => w.roomId === f.roomId && w.status !== 'archived')
    if (any) return act.openShared(any.id, f.id)
    act.toast(`Open a workspace in ${rooms.find((r) => r.id === f.roomId)?.name ?? 'this room'} to view this file`)
  }
  const sharedItems = i.shared
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((f) => {
      if (!f.versions.length) return []
      const latest = latestOf(f)
      const by = nameOf(f.roomId, f.agentId) ?? f.agentId
      const kind = kindLabel(f.kind, latest.mime)
      const it = item(`shared-${f.id}`, 'Shared', '◇', f.title, () => openSharedFile(f), { also: `${kind} ${f.kind} ${f.source} ${by}`, meta: `${kind} · v${latest.n} · ${by} · ${sinceShort(f.updatedAt)}` })
      return [{ roomId: f.roomId, it }]
    })
  // With nothing typed: the five newest in the room in view. Typing searches the rest as well.
  const sharedNow = sharedItems.filter((x) => x.roomId === room?.id).slice(0, SHARED_DEFAULT).map((x) => x.it)
  const sharedRest = sharedItems.map((x) => x.it).filter((x) => !sharedNow.includes(x))

  const accountItems: PaletteItem[] = (i.accounts ?? [])
    .filter((a) => a.signedIn && !a.active)
    .map((a) => item(`acct-${a.provider}-${a.id}`, 'Accounts', '⇄', `Switch ${PROVIDER_NAME[a.provider]} to ${a.label}`, () => act.switchAccount?.(a.provider, a.id), { meta: a.auth === 'apiKey' ? 'API key' : a.plan, also: 'account login sign in' }))

  // Typing searches these too, so the default list stays short.
  const more: PaletteItem[] = [
    ...accountItems,
    ...sharedRest,
    goto('go-home', 'Home', { name: 'home' }),
    goto('go-rooms', 'All rooms', { name: 'rooms' }),
    ...visible.flatMap((r) => {
      const roomLead = i.agents[r.id]?.find((a) => a.lead)
      return [
        goto(`go-team-${r.id}`, `${r.name} team`, { name: 'team', roomId: r.id }, { also: 'agents' }),
        // The room in view has "Open Rowan's chat" above, which "lead chat" finds first. These say whose chat, not "lead chat",
        // so a shorter room name can't outrank it.
        ...(roomLead && r.id !== room?.id ? [item(`go-lead-${r.id}`, 'Go to', '◇', `${roomLead.name}'s chat in ${r.name}`, () => act.openLead(r.id), { also: 'lead workspace' })] : [])
      ]
    }),
    ...workspaces.filter(live).map((w) => goto(`go-ws-${w.id}`, `${workspaceRowLabel(w)} workspace`, { name: 'workspace', workspaceId: w.id }, { also: `${w.name} ${w.branch}` })),
    ...settingsPages.map(([p, label]) => goto(`go-set-${p}`, `Settings: ${label}`, { name: 'settings', page: p }, { also: 'preferences' })),
    // Each room's own pages, named after the room: "Settings: Client A, Scripts".
    ...visible.filter((r) => !r.hidden).flatMap((r) => ROOM_PAGES.map((p) => goto(`go-set-${r.id}-${p.section}`, `Settings: ${r.name}, ${p.label}`, { name: 'settings', page: 'room', roomId: r.id, section: p.section }, { also: 'preferences room' })))
  ]

  return { items: [...suggested, ...chatItems, ...sharedNow, ...goDefault, ...roomItems], more }
}

/** What the list shows for a query. No query: the three sections. A query: one ranked list over everything. */
export function visibleItems(items: PaletteItem[], more: PaletteItem[], query: string): { section: Section; title: string; list: PaletteItem[] }[] {
  if (!query.trim()) {
    return (['Suggested', 'Chats', 'Shared', 'Go to', 'Rooms'] as const)
      .map((section) => { const list = items.filter((x) => x.section === section); return { section, title: list[0]?.group ?? section, list } })
      .filter((g) => g.list.length)
  }
  const seen = new Set<string>()
  // Two chats or files can share a name, so those are told apart by id.
  const all = [...items, ...more].filter((x) => { const key = x.section === 'Shared' || x.section === 'Chats' ? x.id : x.label; return seen.has(key) ? false : (seen.add(key), true) })
  const ranked = rank(all, query)
  const only = ranked.length > 0 && ranked.every((x) => x.section === 'Accounts')
  const list = only ? all.filter((x) => ranked.includes(x)) : ranked
  return list.length ? [{ section: only ? 'Accounts' : 'Results', title: only ? 'Accounts' : 'Results', list }] : []
}
