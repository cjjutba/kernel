import type { AccountProfile, AgentDef, Approval, Chat, Provider, Project, Route, SettingsPage, SharedFile, Thread, Workspace } from '@shared/types'

import type { IconName } from '../../icons'
import { workspaceRowLabel } from '../../components/sidebar/workspaceRowLabel'
import { PROVIDER_NAME } from '../../accountRows'
import { isLeadWorkspace } from '../../lead'
import { projectAgents } from '../../nav'
import { archivedList, endedAt, historyName, whenLabel } from '../history/model'
import { NAV_PAGES, PROJECT_PAGES } from '../settings/nav'
import { hasChanges } from '../workspace/pr/model'
import { kindFile, kindLabel, latestOf, sinceShort } from '../workspace/shared/shared'

export type Section = 'Recents' | 'Actions' | 'Chats' | 'Shared' | 'Pages' | 'Projects' | 'Accounts' | 'Archived' | 'Results'

export type Scope = 'all' | 'chats' | 'shared' | 'pages' | 'projects'
export const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'chats', label: 'Chats' },
  { id: 'shared', label: 'Shared' },
  { id: 'pages', label: 'Pages' },
  { id: 'projects', label: 'Projects' }
]
export const scopeLabel = (scope: Scope) => SCOPES.find((s) => s.id === scope)?.label ?? 'All'
/** The next scope to the right or left, wrapping around. */
export const stepScope = (scope: Scope, by: 1 | -1): Scope => SCOPES[(SCOPES.findIndex((s) => s.id === scope) + by + SCOPES.length) % SCOPES.length].id

/** At most this many items open Recents. */
const RECENTS = 5

export interface PaletteItem {
  id: string
  section: Exclude<Section, 'Results' | 'Recents'>
  label: string
  /** The tab that lists this item. Actions, accounts and archived work are found under All. */
  scope?: Exclude<Scope, 'all'>
  /** The 16px mark on the left. A shared file draws `file` and a project draws `project` instead. */
  icon: IconName
  file?: string
  project?: Project
  /** When a chat last had a message or a shared file last changed. The newest few open Recents. */
  at?: number
  /** Shortcut caps, one string per key, drawn as one chip. */
  keys?: string[]
  /** Lowercase extra words the fuzzy search also matches, so "preferences" finds Settings. */
  also?: string
  /** One muted fact on the right: when a chat last moved, or what a shared file is. */
  meta?: string
  /** A muted fact right after the label, such as when archived work was archived. */
  note?: string
  /** What Enter does, said at the right end of the highlighted row only: "↵ Restore" on archived work. */
  hint?: string
  /** The heading of the group this item opens, when it isn't the section's name: "Chats in Client A". */
  group?: string
  run: () => void
}

/** Settings pages the palette can jump to: the Settings sidebar's list, with its names (KERNEL-680). */
export const settingsPages: [SettingsPage, string][] = NAV_PAGES.map((p) => [p.page, p.label])
/** The settings on those pages, which land on their row like a Settings search result (KERNEL-727). */
const settingsRows = NAV_PAGES.flatMap((p) => p.keywords.map((k) => ({ page: p.page, pageLabel: p.label, ...k })))

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
  projects: Project[]
  workspaces: Workspace[]
  approvals: Approval[]
  /** Every shared file, from the store. */
  shared: SharedFile[]
  /** By project id. */
  agents: Record<string, AgentDef[]>
  /** The open Lead chats of the project in view, in sidebar order, each with its open tabs (KERNEL-339). */
  chats?: { thread: Thread; tabs: Chat[]; ws?: Workspace }[]
  /** The big terminal's switch and the preset a new tab runs. Unset reads as off, like settings that haven't loaded (KERNEL-251). */
  terminal?: { enabled: boolean; preset?: string }
  /** By thread id, to name an archived Lead chat by its chat. */
  threads?: Record<string, Thread>
  /** Both providers' accounts. Each signed-in one that isn't in use gets a "Switch" entry, found by typing (KERNEL-561). */
  accounts?: AccountProfile[]
  act: {
    go: (route: Route) => void
    openNewChat: (projectId?: string) => void
    newProject: () => void
    whatsNew: () => void
    approve: (a: Approval) => void
    /** A tab in the workspace you are in. In the Lead's workspace it joins the chat on screen. */
    newChat: (workspaceId: string, kind?: 'terminal') => void
    /** A chat of the project, on the tab last shown in it, in its own workspace (KERNEL-405). */
    openChat: (projectId: string, thread: Thread, tabs: Chat[], ws?: Workspace) => void
    /** The project's newest Lead chat, or New chat when none is open (`lead.open`, KERNEL-405). */
    openLead: (projectId: string) => void
    /** Where a project opens: its Lead chat, or Team when it has no Lead (D-104). */
    openProject: (projectId: string) => void
    /** Opens a shared file's tab in a workspace and shows that workspace. */
    openShared: (workspaceId: string, sharedId: string) => void
    /** Opens the project's newest Lead chat, then the file's tab in it. */
    openSharedInLead: (projectId: string, sharedId: string) => void
    /** An archived workspace comes back and opens, as Restore does in History. */
    restore?: (w: Workspace, name: string) => void
    /** A toast with only a title. */
    toast: (title: string) => void
    /** The account runs the provider's next turns, as Switch to does in Settings. */
    switchAccount?: (provider: Provider, accountId: string) => void
  }
}

/** The project the user is looking at, falling back to the first visible one. */
export function projectInView(route: Route, projects: Project[], workspaces: Workspace[]): Project | undefined {
  const id = 'projectId' in route ? route.projectId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.projectId : undefined
  return projects.find((r) => r.id === id) ?? projects.find((r) => !r.hidden && !r.archived)
}

/** A workspace row of the sidebar. A Lead chat's own workspace is its chat, listed under Chats (KERNEL-405). */
const live = (w: Workspace) => w.status !== 'archived' && !w.lead

/** "Run pnpm drizzle-kit push" becomes "pnpm drizzle-kit push", for "Approve Sean: pnpm drizzle-kit push". */
const approvalLabel = (a: Approval, who?: string) => `Approve ${who ? `${who}: ` : ''}${a.title.replace(/^Run (?:(?:pnpm|npm|yarn|npx) )?/, '')}`

/** Everything the palette can run. Actions depend on where you are; Pages and Projects are the same everywhere. */
export function buildItems(i: PaletteInput): { items: PaletteItem[]; more: PaletteItem[] } {
  const { route, projects, workspaces, approvals, act } = i
  const project = projectInView(route, projects, workspaces)
  const visible = projects.filter((r) => !r.archived)
  const current = route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId) : undefined
  // Same rule as the PR header: a workspace with no changes has nothing to open a PR for.
  const canPr = (w: Workspace) => w.prState === 'none' && hasChanges(w)
  const forPr = current && canPr(current) ? current : workspaces.filter((w) => live(w) && canPr(w) && (!project || w.projectId === project.id)).sort((a, b) => b.createdAt - a.createdAt)[0]
  const pending = approvals.find((a) => a.status === 'pending' && a.kind === 'tool')
  const nameOf = (projectId?: string, agentId?: string) => (projectId ? i.agents[projectId]?.find((a) => a.id === agentId)?.name : undefined)
  const leadAgent = project ? i.agents[project.id]?.find((a) => a.lead) : undefined
  const lead = leadAgent?.name || 'the Lead'
  // In the Lead's own chat there is nothing to open and no other workspace to go to, as in GroupedPalette (KERNEL-364).
  const inLead = !!(current && project && leadAgent && isLeadWorkspace(current, project.id, leadAgent.id))
  const item = (id: string, section: PaletteItem['section'], icon: IconName, label: string, run: () => void, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, section, icon, label, run, ...extra })

  const actionItems: PaletteItem[] = [
    item('new-ws', 'Actions', 'chat', project ? `New chat in ${project.name}` : 'New chat', () => act.openNewChat(project?.id), { keys: ['⌘', 'N'] }),
    ...(forPr ? [item('create-pr', 'Actions', 'ext', `Create PR for ${workspaceRowLabel(forPr)}`, () => act.go({ name: 'workspace', workspaceId: forPr.id }), { keys: ['⌘', '⇧', 'P'], also: `pull request ${forPr.name} ${forPr.branch}` })] : []),
    ...(pending ? [item('approve', 'Actions', 'checkCircle', approvalLabel(pending, nameOf(pending.projectId, pending.agentId)), () => act.approve(pending), { keys: ['⌘', '↵'], also: 'allow permission' })] : []),
    ...(project && leadAgent && !inLead ? [item('lead-chat', 'Actions', 'chat', `Open ${lead}'s chat`, () => act.openLead(project.id), { keys: ['⌘', '⇧', 'L'], also: 'lead chat workspace brief ask' })] : []),
    ...(current ? [
      item('new-tab', 'Actions', 'plus', 'New tab', () => act.newChat(current.id), { keys: ['⌘', 'T'] }),
      // Main refuses a terminal tab while the big terminal is off, so the palette leaves the entry out until the settings say it is on. A new tab runs the settings' preset.
      ...(i.terminal?.enabled ? [item('terminal', 'Actions', 'computer', i.terminal?.preset ? `Big terminal tab: ${i.terminal.preset}` : 'Big terminal tab', () => act.newChat(current.id, 'terminal'), { keys: ['⌘', '⇧', 'T'], also: 'shell terminal' })] : [])
    ] : [])
  ]

  // The project's open chats, each with its tab count. Typing searches them with everything else.
  const chatItems: PaletteItem[] = project
    ? (i.chats ?? []).map(({ thread, tabs, ws }) => item(`chat-${thread.id}`, 'Chats', 'chat', thread.title, () => act.openChat(project.id, thread, tabs, ws), { scope: 'chats', at: thread.lastSentAt ?? thread.createdAt, meta: sinceShort(thread.lastSentAt ?? thread.createdAt), also: 'chat tabs' }))
    : []

  const shown = inLead ? undefined : current ?? workspaces.filter((w) => live(w) && (!project || w.projectId === project.id)).sort((a, b) => b.createdAt - a.createdAt)[0]
  const goto = (id: string, label: string, route: Route, extra: Partial<PaletteItem> = {}, icon: IconName = 'doc') => item(id, 'Pages', icon, label, () => act.go(route), { scope: 'pages', ...extra })
  const goDefault: PaletteItem[] = [
    goto('go-inbox', 'Inbox', { name: 'inbox' }, { keys: ['G', 'I'] }, 'inbox'),
    goto('go-work', 'Work', { name: 'issues', ...(project ? { projectId: project.id } : {}) }, { also: 'issues linear github tickets pull requests prs merge merged checks review' }, 'issues'),
    ...(shown ? [goto('go-ws', `${workspaceRowLabel(shown)} workspace`, { name: 'workspace', workspaceId: shown.id }, { also: `${shown.name} ${shown.branch}` }, 'layers')] : []),
    goto('go-settings', 'Settings', { name: 'settings', page: 'general' }, { keys: ['⌘', ','], also: 'preferences' }, 'sliders'),
    ...(project ? [goto('go-agents', 'Agents', projectAgents(project.id), { also: 'team subagents' }, 'team')] : []),
    goto('go-history', 'History', { name: 'history' }, { also: 'archived restore old finished' }, 'history'),
    item('go-new', 'Pages', 'star', "What's new", act.whatsNew, { scope: 'pages', also: 'update release notes' })
  ]

  const projectItems: PaletteItem[] = [
    ...visible.map((r) => item(`project-${r.id}`, 'Projects', 'projects', r.name, () => act.openProject(r.id), { scope: 'projects', project: r })),
    item('project-new', 'Projects', 'plus', 'New project', act.newProject, { scope: 'projects', also: 'add connect repo' })
  ]

  // Where a shared file opens is worked out when it is picked, so a file is always listed: the sharing workspace if it is still open, else the
  // workspace on screen, else the project's Lead (made on first use), else the project's first open workspace (KERNEL-307).
  const openSharedFile = (f: SharedFile) => {
    const open = (w?: Workspace) => (w && w.status !== 'archived' ? w : undefined)
    const target = open(workspaces.find((w) => w.id === f.workspaceId)) ?? open(current)
    if (target) return act.openShared(target.id, f.id)
    const leadId = i.agents[f.projectId]?.find((a) => a.lead)?.id
    if (leadId) {
      const leadWs = workspaces.filter((w) => isLeadWorkspace(w, f.projectId, leadId)).at(-1)
      return leadWs ? act.openShared(leadWs.id, f.id) : act.openSharedInLead(f.projectId, f.id)
    }
    const any = workspaces.find((w) => w.projectId === f.projectId && w.status !== 'archived')
    if (any) return act.openShared(any.id, f.id)
    act.toast(`Open a workspace in ${projects.find((r) => r.id === f.projectId)?.name ?? 'this project'} to view this file`)
  }
  const sharedItems = i.shared
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((f) => {
      if (!f.versions.length) return []
      const latest = latestOf(f)
      const by = nameOf(f.projectId, f.agentId) ?? f.agentId
      const kind = kindLabel(f.kind, latest.mime)
      const it = item(`shared-${f.id}`, 'Shared', 'doc', f.title, () => openSharedFile(f), { scope: 'shared', file: kindFile[f.kind], meta: kind, also: `${kind} ${f.kind} ${f.source} ${by}` })
      return [{ projectId: f.projectId, it }]
    })
  // Every file is listed under Shared, newest first. Only the project in view's open Recents.
  const sharedAll = sharedItems.map(({ projectId, it }) => (projectId === project?.id ? { ...it, at: i.shared.find((f) => `shared-${f.id}` === it.id)?.updatedAt } : it))

  // "Switch Claude Code to Personal". A search that finds only these keeps Claude Code before Codex, not the shorter label first.
  const accountItems: PaletteItem[] = (i.accounts ?? [])
    .filter((a) => a.signedIn && !a.active)
    .map((a) => item(`acct-${a.provider}-${a.id}`, 'Accounts', 'user', `Switch ${PROVIDER_NAME[a.provider]} to ${a.label}`, () => act.switchAccount?.(a.provider, a.id), { meta: a.auth === 'apiKey' ? 'API key' : a.plan, also: 'account login sign in' }))

  // Typing searches these too, so the default list stays short.
  const more: PaletteItem[] = [
    ...accountItems,
    // Typing "archived" lists them all. Picking one restores it and opens it, the way Restore does in History.
    ...archivedList(workspaces).map((w) => {
      const name = historyName(w, i.threads ?? {})
      return item(`archived-${w.id}`, 'Archived', 'archive', name, () => act.restore?.(w, name), { note: `Archived ${whenLabel(endedAt(w))}`, hint: '↵ Restore', also: `archived history restore ${w.branch} ${projects.find((r) => r.id === w.projectId)?.name ?? ''}` })
    }),
    goto('go-projects', 'All projects', { name: 'projects' }, {}, 'projects'),
    ...visible.flatMap((r) => {
      const projectLead = i.agents[r.id]?.find((a) => a.lead)
      return [
        goto(`go-agents-${r.id}`, `${r.name} agents`, projectAgents(r.id), { also: 'team subagents' }, 'team'),
        // The project in view has "Open the Lead's chat" above, which "lead chat" finds first. These say whose chat, not "lead chat",
        // so a shorter project name can't outrank it.
        ...(projectLead && r.id !== project?.id ? [item(`go-lead-${r.id}`, 'Pages', 'chat', `${projectLead.name}'s chat in ${r.name}`, () => act.openLead(r.id), { scope: 'pages', also: 'lead workspace' })] : [])
      ]
    }),
    ...workspaces.filter(live).map((w) => goto(`go-ws-${w.id}`, `${workspaceRowLabel(w)} workspace`, { name: 'workspace', workspaceId: w.id }, { also: `${w.name} ${w.branch}` }, 'layers')),
    ...settingsPages.map(([p, label]) => goto(`go-set-${p}`, `Settings: ${label}`, { name: 'settings', page: p }, { also: 'preferences' }, 'sliders')),
    // Each project's own pages, named after the project: "Settings: Client A, Scripts".
    ...settingsRows.map((k) => goto(`go-set-${k.page}-${k.rowId}`, `Settings: ${k.pageLabel}, ${k.label}`, { name: 'settings', page: k.page, row: k.rowId }, { also: 'preferences' }, 'sliders')),
    ...visible.filter((r) => !r.hidden).flatMap((r) => PROJECT_PAGES.flatMap((p) => [
      goto(`go-set-${r.id}-${p.section}`, `Settings: ${r.name}, ${p.label}`, { name: 'settings', page: 'project', projectId: r.id, section: p.section }, { also: 'preferences project' }, 'sliders'),
      ...p.keywords.map((k) => goto(`go-set-${r.id}-${p.section}-${k.rowId}`, `Settings: ${r.name}, ${p.label}, ${k.label}`, { name: 'settings', page: 'project', projectId: r.id, section: p.section, row: k.rowId }, { also: 'preferences project' }, 'sliders'))
    ]))
  ]

  return { items: [...actionItems, ...chatItems, ...sharedAll, ...goDefault, ...projectItems], more }
}

export interface Group { section: Section; title: string; list: PaletteItem[] }

/** What the list shows. No query under All: Recents, then Actions. No query under a tab: all of that kind. A query: one ranked list. */
export function visibleItems(items: PaletteItem[], more: PaletteItem[], query: string, scope: Scope = 'all'): Group[] {
  const inScope = (x: PaletteItem) => scope === 'all' || x.scope === scope
  if (!query.trim()) {
    if (scope !== 'all') {
      const list = items.filter(inScope)
      return list.length ? [{ section: items.find(inScope)!.section, title: scopeLabel(scope), list }] : []
    }
    const recents = items.filter((x) => x.at !== undefined).sort((a, b) => b.at! - a.at!).slice(0, RECENTS)
    const actions = items.filter((x) => x.section === 'Actions')
    return ([{ section: 'Recents', title: 'Recents', list: recents }, { section: 'Actions', title: 'Actions', list: actions }] as Group[]).filter((g) => g.list.length)
  }
  const seen = new Set<string>()
  // Two chats or files can share a name, so those are told apart by id.
  const all = [...items, ...more].filter(inScope).filter((x) => { const key = x.section === 'Shared' || x.section === 'Chats' || x.section === 'Archived' ? x.id : x.label; return seen.has(key) ? false : (seen.add(key), true) })
  const ranked = rank(all, query)
  const only = scope === 'all' && ranked.length > 0 && ranked.every((x) => x.section === 'Accounts')
  // Results that are all archived work say so in their heading, as the accounts do (Pen 12.7, SearchArchived).
  const archived = scope === 'all' && ranked.length > 0 && ranked.every((x) => x.section === 'Archived')
  const list = only ? all.filter((x) => ranked.includes(x)) : ranked
  const title = only ? 'Accounts' : archived ? 'Archived' : scope === 'all' ? 'Results' : scopeLabel(scope)
  return list.length ? [{ section: only ? 'Accounts' : archived ? 'Archived' : 'Results', title, list }] : []
}

/** The character ranges of `text` that `query` matched, for drawing them in full ink. A whole-text hit is one range, else each query character. */
export function matchRanges(query: string, text: string): [number, number][] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const t = text.toLowerCase()
  const whole = t.indexOf(q)
  if (whole >= 0) return [[whole, whole + q.length]]
  const out: [number, number][] = []
  let at = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const i = t.indexOf(ch, at)
    if (i < 0) return []
    const last = out[out.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else out.push([i, i + 1])
    at = i + 1
  }
  return out
}
