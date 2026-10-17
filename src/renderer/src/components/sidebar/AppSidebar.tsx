import { useKeptScroll } from '../../ui/keptScroll'
import { TERMINAL_SEATS_IN_APP } from '../../seats'
import { memo, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { Chat, Project, Thread, Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { Icon, type IconName } from '../../icons'
import { IconButton, Spinner, useBusy } from '../../ui'
import { actions, getState, go, useStore, type Route, type State } from '../../store'
import { readSavedJson, writeSavedJson } from '../../remember'
import { allOverlaps, inboxItems, needsYou } from '../../screens/inbox/model'
import { chatWorkspaces, isLeadWorkspace, leadOf, openNewChat, useLeadWaiting } from '../../lead'
import { archiveChatFromSidebar, archivingChat } from '../../screens/workspace/archiveChat'
import { reducedMotion, useArriving, useStage } from '../../screens/workspace/archiveMotion'
import { currentThread } from '../../nav'
import { ProjectIcon } from '../ProjectIcon'
import { projectInView } from '../../screens/search/model'
import { archiveByHand } from '../../screens/workspace/byHand'
import { HistoryButtons } from '../PanelToggles'
import { AccountButton } from './AccountMenu'
import { isPlanApproval } from '../../screens/workspace/cards/steps'
import { chatWaits } from './chatWaits'
import { ChatCard, LeadCard, WorkspaceCard, useHoverCard } from './HoverCard'
import { ProjectMenu } from './ProjectMenu'
import { ProjectsMenu } from './ProjectsMenu'
import { liveWorkspaces, mergeChatList, openRow, rowHolder, sidebarRows, slotKey, slotsFor, workspaceSlotsFor, type Slot } from './slots'
import { useLocalMerge } from '../../screens/workspace/pr/useLocalMerge'
import { useShown, type Fate, type Shown } from './leaving'
import { chatUnread, projectUnread, workspaceRowUnread } from './unread'
import { chatGlyph, leadGlyph, workspaceGlyph, type WorkspaceGlyph } from './workspaceGlyph'
import { workspaceRowLabel } from './workspaceRowLabel'
import { useWorkTab } from '../../screens/work/tab'

/** Routes hold only strings, so equal fields mean the same page. An unset field and a missing one are the same. */
const same = (a: Route, b: Route) => {
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>
  for (const k in x) if (x[k] !== y[k]) return false
  for (const k in y) if (!(k in x) && y[k] !== undefined) return false
  return true
}

/** A row whose workspace was archived and has left the list, and is still drawn: `from` is the route the archive moved off, and `held` means it waits as it was. */
type Gone = { from?: Route; held?: boolean }

/** How long ⌘ or ⌃ is held alone before the rows show their numbers. Shorter and ⌘K or ⌘C would flash them. */
const HINT_DELAY = 400

/** True once `mod` has been held alone for HINT_DELAY. Another key, letting go of it or the window losing focus ends it. */
function useModHeld(mod: 'Meta' | 'Control'): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    let timer: number | undefined
    const off = () => { window.clearTimeout(timer); timer = undefined; setHeld(false) }
    const down = (e: KeyboardEvent) => {
      const others = mod === 'Meta' ? e.ctrlKey : e.metaKey
      if (e.key !== mod || others || e.altKey || e.shiftKey) return off()
      if (e.repeat || timer !== undefined) return
      timer = window.setTimeout(() => setHeld(true), HINT_DELAY)
    }
    const up = (e: KeyboardEvent) => { if (e.key === mod) off() }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', off)
    return () => { off(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', off) }
  }, [mod])
  return held
}

/** A numbered row's ⌘N (a chat's) or ⌃N (a workspace's), shown at its right end while the key is held. The row's aria-keyshortcuts says the same to a screen reader. */
const KeyHint = ({ n, ctrl }: { n: number; ctrl?: boolean }) => <span className="mono nav-key" aria-hidden="true">{ctrl ? '⌃' : '⌘'}{n}</span>

/** A row's place in the project's ⌘1 to ⌘9 order, and whether ⌘ is held so it should show. Rows of other projects get none. */
type RowKey = { n: number; hint: boolean; /** The row's number is a ⌃ one: a workspace of the current chat. */ ctrl?: boolean }

/** The icon a row has at rest, which the loader takes the place of while it runs (`busy` on `Glyph`). `rest` is the glyph without the activity, `fallback` stands in when the rest state is a spinner too. */
const restIcon = (g: WorkspaceGlyph, rest: WorkspaceGlyph, fallback: IconName): WorkspaceGlyph & { icon: IconName } => {
  const at = g.icon === 'spin' ? rest : g
  return { ...g, icon: at.icon === 'spin' ? fallback : at.icon, tone: at.tone }
}

function NavItem({ route, icon, label, right, sub, nested, slot, unread, onOpen, leaving }: { route: Route; icon: IconName | ReactElement; label: ReactNode; right?: ReactNode; sub?: boolean; nested?: boolean; slot?: RowKey; /** The row's name when it has something new: its title goes bold and its label ends in Unread (KERNEL-508). */ unread?: string; /** In place of going to `route`. */ onOpen?: () => void; /** The row's workspace was archived. It folds away, keeping the fill it had on the screen the archive left (`from`), or `held` waits for its chat to fold. */ leaving?: Gone }) {
  // Work is the page of both tabs, and each opens on more than its bare route (an issue, a filter), so the route's name is what counts.
  const current = useStore((s) => { const r = leaving ? leaving.from ?? s.ui.route : s.ui.route; return same(r, route) || ((route.name === 'issues' || route.name === 'prs') && (r.name === 'issues' || r.name === 'prs')) })
  const arrive = useArriving(current && !leaving)
  return (
    <button className={`nav-item${sub ? ' nav-sub' : ''}${nested ? ' nav-nested' : ''}`} aria-current={current && !leaving ? 'page' : undefined} data-was-current={current && leaving ? '' : undefined} data-arrive={arrive ? '' : undefined} aria-label={unread === undefined ? undefined : `${unread}, Unread`} data-unread={unread === undefined ? undefined : ''} aria-keyshortcuts={slot && `${slot.ctrl ? 'Control' : 'Meta'}+${slot.n}`} onClick={onOpen ?? (() => go(route))}>
      {typeof icon === 'string' ? <Icon name={icon} /> : icon}
      <span className="grow ellipsis">{label}</span>
      {slot?.hint ? <KeyHint n={slot.n} ctrl={slot.ctrl} /> : right}
    </button>
  )
}

/** A row's state icon. Its state is the accessible name. While the row runs (`busy`), the loader takes the icon's box, so nothing moves when the run starts or stops. */
function Glyph({ g, busy }: { g: WorkspaceGlyph & { icon: IconName }; busy?: boolean }) {
  return (
    <span className="nav-glyph" data-tone={g.tone} role="img" aria-label={g.label}>
      {busy ? <Spinner label={null} /> : <Icon name={g.icon} />}
    </span>
  )
}

/**
 * The project's Lead, shown only while it has no open chat to list. It opens New chat, where the first message starts a chat in its
 * own workspace (KERNEL-405). Its icon shows what waits on you, and a working Lead swaps it for the loader.
 */
function LeadItem({ projectId, slot }: { projectId: string; slot?: RowKey }) {
  const lead = useStore((s) => leadOf(s.agents, projectId))
  const status = useStore((s) => (lead ? s.status[projectId]?.[lead.id] : undefined) ?? 'idle')
  const current = useStore((s) => { const r = s.ui.route; return (r.name === 'leadNew' && r.projectId === projectId) || (r.name === 'workspace' && s.workspaces.some((w) => w.id === r.workspaceId && isLeadWorkspace(w, projectId, lead?.id))) })
  const waiting = useLeadWaiting(projectId)
  const arrive = useArriving(current)
  const card = useHoverCard<HTMLButtonElement>()
  if (!lead) return null
  const g = leadGlyph(status, waiting)
  const shown = restIcon(g, leadGlyph('idle', waiting), 'chat')
  return (
    <>
      <button className="nav-item nav-sub" {...card.bind} aria-current={current ? 'page' : undefined} data-arrive={arrive ? '' : undefined} aria-label={`New chat, ${g.label}`} aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={() => openRow(projectId, { kind: 'lead' })}>
        <Glyph g={shown} busy={g.icon === 'spin'} />
        <span className="grow ellipsis">New chat</span>
        {slot?.hint ? <KeyHint n={slot.n} /> : null}
      </button>
      {card.at && <LeadCard projectId={projectId} at={card.at} id={card.id} hold={card.hold} />}
    </>
  )
}

/**
 * One of the Lead's open chats, however many tabs it holds (KERNEL-338). Its icon is the one a tab would show, for the whole chat: something that
 * needs you in any tab wins, then its own workspace's setup, failed setup or missing folder (KERNEL-405), then a running turn in any tab, else
 * the chat icon. They read the same approvals and `running` flags as the tabs. It opens the chat's own workspace on the tab last shown in it. A chat
 * that handed off workspaces folds like a project: hovering or tabbing to it swaps its icon for a chevron. While it is folded, the icon also shows what a
 * hidden workspace needs from you, so nothing waits out of sight. Hover shows Archive, like a workspace row's (KERNEL-405). A running turn swaps
 * the icon for the loader, unless something waits on you, where the wait keeps the icon (KERNEL-601).
 */
function ChatItemRow({ projectId, thread, ws, tabs, owned, folded, slot, leaving, onSettled }: { projectId: string; thread: Thread; ws?: Workspace; tabs: Chat[]; owned: Workspace[]; folded: boolean; slot?: RowKey; leaving?: Gone; onSettled?: () => void }) {
  const approvals = useStore((s) => s.approvals)
  // A folded chat counts its workspaces: an unfolded one shows its own icon in its own row.
  const waits = useMemo(() => chatWaits({ tabs, owned: folded ? owned : [], approvals }), [approvals, tabs, folded, owned])
  const waiting = useMemo(() => waits.map((w) => w.approval), [waits])
  const running = useStore((s) => tabs.some((c) => s.running[c.id]))
  // The chat's own workspace is on screen (KERNEL-405).
  const current = useStore((s) => {
    const r = leaving ? leaving.from ?? s.ui.route : s.ui.route
    return r.name === 'workspace' && (ws ? r.workspaceId === ws.id : r.workspaceId === tabs[0]?.workspaceId && currentThread(s, r.workspaceId) === thread.id)
  })
  const arrive = useArriving(current && !leaving)
  // Plan mode tints the icon `plan` blue, like the composer: a tab that plans, or a plan waiting for approval. A waiting icon stays amber and the shape still says the state.
  const local = useLocalMerge(ws)
  const pending = useStore((s) => (ws ? s.prPending[ws.id] : undefined))
  const g = chatGlyph({ ws, waiting, running, local, pending })
  // The loader takes the icon only when nothing waits on you: a wait, on a tab or on a hidden workspace, keeps its icon until it is answered.
  const busy = g.icon === 'spin'
  const shown = restIcon(g, chatGlyph({ ws, waiting, running: false, local }), 'chat')
  // The blue tint belongs to the chat and plan icons: a PR icon keeps its green, red or purple in plan mode (KERNEL-993).
  const planning = (tabs.some((c) => c.plan) || waiting.some(isPlanApproval)) && (shown.icon === 'chat' || shown.icon === 'plan')
  // A new reply in any tab, or in a hidden workspace while folded, bolds the title. The icon keeps its own state (KERNEL-508).
  const unread = useStore((s) => chatUnread({ tabs, owned, chats: s.chats, folded, current }))
  const [archiving, run] = useBusy()
  const archive = () => void run('archive', () => archiveChatFromSidebar(thread))
  const name = g.label ? `${thread.title}, ${g.label}` : thread.title
  const card = useHoverCard()
  return (
    <div {...card.bind} className={`hv chat-row${archiving ? ' busy' : ''}${leaving && !leaving.held ? ' row-fold' : ''}`} data-key={slot?.hint || undefined} inert={leaving ? true : undefined} onAnimationEnd={(e) => { if (e.target === e.currentTarget && e.animationName === 'archive-fold') onSettled?.() }}>
      <button
        className="nav-item nav-sub" aria-current={current && !leaving ? 'page' : undefined} data-was-current={current && leaving ? '' : undefined} data-arrive={arrive ? '' : undefined} aria-label={unread ? `${name}, Unread` : name} data-unread={unread ? '' : undefined}
        aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={() => openRow(projectId, { kind: 'chat', thread, tabs, owned, folded })}
      >
        <span className="nav-glyph" data-tone={shown.tone} data-owned={owned.length ? '' : undefined} data-plan={planning ? '' : undefined} aria-hidden="true">{busy ? <Spinner label={null} /> : <Icon name={shown.icon} />}</span>
        <span className="grow ellipsis">{thread.title}</span>
        {slot?.hint ? <KeyHint n={slot.n} /> : ws?.prNumber ? <span className="mono muted ws-right ws-pr">#{ws.prNumber}</span> : null}
      </button>
      {ws && (
        <div className="more ws-archive">
          {/* Just the icon, with no spinner or word, like a workspace row's (DESIGN.md, Busy buttons). useBusy still ignores a second click. */}
          <IconButton icon="archive" size={14} label={`Archive ${thread.title}`} data-card-off="" style={{ width: 24, height: 24 }} disabled={!!archiving} onClick={archive} />
        </div>
      )}
      {owned.length > 0 && (
        <button className="chat-chev" aria-expanded={!folded} aria-label={`${folded ? 'Expand' : 'Collapse'} ${thread.title}`} onClick={() => actions.ui.foldChat(thread.id, !folded, tabs.map((c) => c.id))}>
          <Icon name="right" size={14} />
        </button>
      )}
      {card.at && <ChatCard projectId={projectId} thread={thread} ws={ws} tabs={tabs} owned={owned} at={card.at} id={card.id} hold={card.hold} onArchive={ws ? () => { card.close(); archive() } : undefined} />}
    </div>
  )
}

const sameSlot = (a?: RowKey, b?: RowKey) => a === b || (!!a && !!b && a.n === b.n && a.hint === b.hint && a.ctrl === b.ctrl)
const sameList = <T,>(a: T[], b: T[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]))
const sameGone = (a?: Gone, b?: Gone) => a === b || (!!a && !!b && a.from === b.from && a.held === b.held)

/**
 * The sidebar builds its rows again on every workspace or chat change, with new arrays and closures. A row redraws only when what it shows changed, so an
 * event for one chat leaves the others alone. `onSettled` is left out: it only reports the row's own key back, which never changes for the same row.
 */
const ChatItem = memo(ChatItemRow, (a, b) =>
  a.projectId === b.projectId && a.thread === b.thread && a.ws === b.ws && a.folded === b.folded && sameList(a.tabs, b.tabs) && sameList(a.owned, b.owned) && sameSlot(a.slot, b.slot) && sameGone(a.leaving, b.leaving))

/**
 * The row's archive button archives in one click when nothing would be lost. Uncommitted changes, commits
 * not on GitHub yet, or a status Kernel can't read open ConfirmArchive instead, which says what happens to them.
 * A current-branch workspace removes no files, so it never needs the dialog.
 */
async function archiveFromSidebar(ws: Workspace) {
  if (ws.mode === 'worktree') {
    const git = await call('workspaces.gitStatus', { workspaceId: ws.id }).catch(() => null)
    if (!git || git.ahead || git.dirty.files) return actions.ui.openModal({ name: 'confirm', kind: 'archive', workspaceId: ws.id })
  }
  try {
    await archiveByHand({ workspaceId: ws.id })
  } catch (e) { actions.ui.toast({ title: `Could not archive ${workspaceRowLabel(ws)}`, sub: cleanError(e) }) }
}

/**
 * A workspace row: its state icon (needs you, then the PR, or the branch), its name, its diff totals from 300px of sidebar, and the loader in the icon's place while it runs. Hover swaps
 * that right end for Archive. Resting on it opens its card.
 */
function WorkspaceItemRow({ ws, parent, slot, nested, leaving, onSettled }: { ws: Workspace; /** The title of the chat that started it, for the card. */ parent?: string; slot?: RowKey; nested?: boolean; leaving?: Gone; onSettled?: () => void }) {
  const approvals = useStore((s) => s.approvals)
  const waiting = useMemo(() => approvals.filter((a) => a.workspaceId === ws.id && a.status === 'pending'), [approvals, ws.id])
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const [archiving, run] = useBusy()
  const local = useLocalMerge(ws)
  const pending = useStore((s) => s.prPending[ws.id])
  const g = workspaceGlyph(ws, { waiting, running, local, pending })
  // Running puts the loader in the icon's place, and the icon the workspace has at rest returns when it stops.
  const shown = restIcon(g, workspaceGlyph(ws, { waiting, running: false, local }), 'branch')
  // A teammate whose hand-off runs in a terminal says so on its row (KERNEL-1028).
  const inTerminal = useStore((s) => TERMINAL_SEATS_IN_APP && (s.chats[ws.id] ?? []).some((c) => c.kind === 'terminal' && !c.closed && c.terminal?.handoff))
  const current = useStore((s) => same(leaving ? leaving.from ?? s.ui.route : s.ui.route, { name: 'workspace', workspaceId: ws.id }))
  const unread = useStore((s) => workspaceRowUnread(s.chats[ws.id], current))
  const archive = () => void run('archive', () => archiveFromSidebar(ws))
  const label = workspaceRowLabel(ws)
  const diff = !!ws.stat && !!(ws.stat.added || ws.stat.removed)
  const card = useHoverCard()
  return (
    <div {...card.bind} className={`hv ws-row${archiving ? ' busy' : ''}${leaving && !leaving.held ? ' row-fold' : ''}`} data-key={slot?.hint || undefined} inert={leaving ? true : undefined} onAnimationEnd={(e) => { if (e.target === e.currentTarget && e.animationName === 'archive-fold') onSettled?.() }}>
      <NavItem
        sub nested={nested} leaving={leaving} route={{ name: 'workspace', workspaceId: ws.id }} icon={<Glyph g={shown} busy={g.icon === 'spin'} />} label={label} slot={slot} unread={unread ? (g.label ? `${label}, ${g.label}` : label) : undefined}
        onOpen={() => openRow(ws.projectId, { kind: 'workspace', ws, nested: !!nested })}
        right={<>
          {inTerminal && <span className="ws-right ws-term" data-tip="Runs in a terminal" role="img" aria-label="Runs in a terminal"><Icon name="term" size={12} /></span>}
          {diff && ws.stat && <span className="mono ws-right ws-stat">{ws.stat.added ? <span className="add">+{ws.stat.added}</span> : null}{ws.stat.removed ? <span className="del">-{ws.stat.removed}</span> : null}</span>}
          {ws.prNumber ? <span className="mono muted ws-right ws-pr">#{ws.prNumber}</span> : null}
        </>}
      />
      <div className="more ws-archive">
        {/* Just the icon, with no spinner or word (DESIGN.md, Busy buttons). useBusy still ignores a second click. */}
        <IconButton icon="archive" size={14} label={`Archive ${label}`} data-card-off="" style={{ width: 24, height: 24 }} disabled={!!archiving} onClick={archive} />
      </div>
      {card.at && <WorkspaceCard ws={ws} parent={parent} at={card.at} id={card.id} hold={card.hold} onArchive={() => { card.close(); archive() }} />}
    </div>
  )
}

const WorkspaceItem = memo(WorkspaceItemRow, (a, b) =>
  a.ws === b.ws && a.parent === b.parent && a.nested === b.nested && sameSlot(a.slot, b.slot) && sameGone(a.leaving, b.leaving))

/** The workspaces whose chat list `useChatLists` has asked for. The store can't say: a `chat` push makes a one-chat list before any fetch. */
const fetched = new Set<string>()

/**
 * Chat lists for the Lead's workspace and the workspace rows, which load only when a workspace opens. With them a chat row
 * lists at launch and a workspace row shows it is working before you open it; chat pushes keep them current after that.
 * A list is fetched once per workspace whatever the store holds, then merged with any chats pushed meanwhile.
 */
function useChatLists(workspaceIds: string[]) {
  const key = workspaceIds.join()
  useEffect(() => {
    for (const id of workspaceIds) {
      if (fetched.has(id)) continue
      fetched.add(id)
      void call('chats.list', { workspaceId: id })
        .then((list) => actions.chats.set(id, mergeChatList(list, getState().chats[id])))
        .catch(() => { fetched.delete(id) })
    }
  }, [key])
}

/**
 * The rows of a project as the blocks they are drawn in (KERNEL-601): each open chat with the workspaces it started, the Lead's row alone, and the workspaces no open
 * chat owns together. A row folding away stays in its block until it settles.
 */
function blocksOf(shown: Shown[]): Shown[][] {
  const out: Shown[][] = []
  for (const item of shown) {
    const last = out[out.length - 1]
    const joins = item.row.kind === 'workspace' && last && (item.row.nested ? last[0].row.kind === 'chat' : last[0].row.kind === 'workspace')
    if (joins) last.push(item)
    else out.push([item])
  }
  return out
}

/**
 * A project in the sidebar. Expanded, it lists the Lead's open chats with the workspaces each started under it (unless the chat is folded), then the workspaces
 * no open chat owns (D-139). Pressing the row folds or unfolds it, and hovering it
 * swaps the project's letter for a chevron and shows the menu button.
 */
const NO_KEYS: string[] = []

function ProjectItem({ project, current, expanded, numbered, hints, ctrlHints, onToggle }: { project: Project; current: boolean; expanded: boolean; numbered: boolean; hints: boolean; ctrlHints: boolean; onToggle: () => void }) {
  // Only this project's slice of each: an event in another project, or for a chat that isn't a row here, leaves it alone.
  const agents = useStore((s) => ({ [project.id]: s.agents[project.id] }))
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.projectId === project.id))
  const chats = useStore((s) => { const out: State['chats'] = {}; for (const w of s.workspaces) if (w.projectId === project.id && s.chats[w.id]) out[w.id] = s.chats[w.id]; return out })
  const threads = useStore((s) => s.threads)
  const foldedChats = useStore((s) => s.ui.foldedChats)
  const rows = useMemo(() => sidebarRows(project, agents, workspaces, chats, threads, foldedChats), [project, agents, workspaces, chats, threads, foldedChats])
  // An archived row stays in the list while it folds away (DESIGN.md, Motion). The row on screen keeps its fill, which it had on the screen the archive left.
  const leftFrom = useStage()?.from
  const fate = (row: Slot): Fate => {
    const ws = row.kind === 'chat' || row.kind === 'workspace' ? row.ws : undefined
    if (!ws || workspaces.find((w) => w.id === ws.id)?.status !== 'archived') return undefined
    // A workspace its chat is archiving waits for the chat's row, unless it is the one on screen, which goes with the screen.
    const waits = row.kind === 'workspace' && !!ws.threadId && archivingChat(ws.threadId) && rows.some((r) => r.kind === 'chat' && r.thread.id === ws.threadId)
    return waits && !(leftFrom?.name === 'workspace' && leftFrom.workspaceId === ws.id) ? 'hold' : 'fold'
  }
  const [shown, settle] = useShown(rows, expanded && !reducedMotion(), fate)
  // Only the project in view is numbered. Its keys come from the same slots the shortcut reads.
  const order = useMemo(() => (numbered ? slotsFor(project, agents, workspaces, chats, threads).map(slotKey) : NO_KEYS), [numbered, project, agents, workspaces, chats, threads])
  // The workspaces of the chat in view get ⌃ numbers, from the same list ⌃1 to ⌃9 read (KERNEL-814).
  const route = useStore((s) => s.ui.route)
  const mine = useMemo(() => workspaceSlotsFor(route, project, agents, workspaces, chats, threads).map((w) => w.id), [route, project, agents, workspaces, chats, threads])
  const slotOf = (row: Slot): RowKey | undefined => {
    if (row.kind === 'workspace') { const j = mine.indexOf(row.ws.id); return j < 0 ? undefined : { n: j + 1, hint: ctrlHints, ctrl: true } }
    const i = order.indexOf(slotKey(row))
    return i < 0 ? undefined : { n: i + 1, hint: hints }
  }
  const menuOpen = useStore((s) => s.ui.menu === `project:${project.id}`)
  const anchor = useRef<HTMLDivElement>(null)
  const homes = chatWorkspaces(workspaces, threads, project.id).map((w) => w.id)
  // A collapsed project loads its chats too: ⌘1 to ⌘9 count the Lead's, and the project is bold when any of them is unread (KERNEL-508).
  useChatLists([...homes, ...liveWorkspaces(workspaces, project.id).map((w) => w.id)])
  const unread = projectUnread({ rows, chats, expanded })
  return (
    <div className="nav-list" data-keep-id={project.id}>
      <div ref={anchor} className="hv project-row" style={{ position: 'relative' }}>
        <button className="nav-item" style={{ color: current ? 'var(--ink)' : undefined }} aria-expanded={expanded} aria-label={unread ? `${project.name}, Unread` : undefined} data-unread={unread ? '' : undefined} onClick={onToggle}>
          <span className="project-mark">
            <ProjectIcon project={project} className="project-letter" current={current} />
            <span className="project-chev" data-open={expanded}><Icon name="right" size={14} /></span>
          </span>
          <span className="grow ellipsis">{project.name}</span>
        </button>
        {/* New chat stays visible. The menu button shows on hover or keyboard focus, or while its menu is open. */}
        <div className="row project-actions">
          <button className="icon-btn more" style={{ width: 24, height: 24, opacity: menuOpen ? 1 : undefined }} aria-label={`${project.name} options`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu(`project:${project.id}`)}><Icon name="more" size={14} /></button>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`New chat in ${project.name}`} onClick={() => openNewChat(project.id)}><Icon name="plus" size={14} /></button>
        </div>
        {menuOpen && <ProjectMenu project={project} anchorRef={anchor} />}
      </div>
      {expanded && blocksOf(shown).map((block) => (
        // A block that folds as one box, or the Lead's that opens, reports it here, since its rows carry no animation of their own then.
        <div
          key={block[0].row.kind === 'workspace' ? 'unowned' : block[0].key} className={`nav-group${block.some((i) => i.opening) ? ' row-open' : ''}`} data-guide={block[0].row.kind === 'chat' && block.length > 1 ? '' : undefined}
          onAnimationEnd={(e) => { if (e.target === e.currentTarget && (e.animationName === 'archive-fold' || e.animationName === 'archive-open')) block.forEach((i) => { if (i.leaving || i.opening) settle(i.key) }) }}
        >
          {block.map(({ key, row, leaving, held }) => {
            const gone = leaving || held ? { from: leftFrom, held } : undefined
            if (row.kind === 'lead') return <LeadItem key={key} projectId={project.id} slot={slotOf(row)} />
            if (row.kind === 'chat') return <ChatItem key={key} projectId={project.id} thread={row.thread} ws={row.ws} tabs={row.tabs} owned={row.owned} folded={row.folded} slot={slotOf(row)} leaving={gone} onSettled={() => settle(key)} />
            return <WorkspaceItem key={key} ws={row.ws} parent={row.nested && block[0].row.kind === 'chat' ? block[0].row.thread.title : undefined} nested={row.nested} slot={slotOf(row)} leaving={gone} onSettled={() => settle(key)} />
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * Projects expanded (true) or collapsed (false) by hand, by id. A project left alone is expanded while it is the current one.
 * localStorage keeps them across launches, and may be missing or blocked.
 */
// Rooms were renamed projects (KERNEL-880). The saved key keeps its old name, so each project stays expanded or collapsed.
const EXPANDED = 'kernel.roomsExpanded'
function readExpanded(): Record<string, boolean> {
  return readSavedJson(EXPANDED, (v) => (v && typeof v === 'object' ? v as Record<string, boolean> : {}))
}

/**
 * What the Inbox badge counts. It reads these four slices and nothing else, so terminal chunks, script lines
 * and chat items leave it alone. The count is worked out again only when one of them is a new object.
 */
let inboxFrom: unknown[] = []
let inboxCountNow = 0
function inboxCount(s: State): number {
  const from = [s.notifications, s.approvals, s.projects, s.overlaps]
  if (from.every((x, i) => x === inboxFrom[i])) return inboxCountNow
  inboxFrom = from
  inboxCountNow = inboxItems(s.notifications, s.approvals, s.projects, allOverlaps(s.overlaps)).filter(needsYou).length
  return inboxCountNow
}

/**
 * What the sidebar frame holds in the app: the traffic-light strip with Hide sidebar, the account row, the nav items, the projects and the footer.
 * The frame (Sidebar.tsx) owns the `<nav>`, the width and the resize edge, so these are its direct flex children.
 */
export function AppSidebar() {
  const projects = useStore((s) => s.projects.filter((r) => !r.hidden && !r.archived))
  const inbox = useStore(inboxCount)
  const [workTab] = useWorkTab()
  const route = useStore((s) => s.ui.route)
  const numberedProject = useStore((s) => projectInView(s.ui.route, s.projects, s.workspaces)?.id)
  const hints = useModHeld('Meta')
  const ctrlHints = useModHeld('Control')
  const projectsMenu = useStore((s) => s.ui.menu === 'projects')
  const projectsAnchor = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState(readExpanded)
  const openWorkspaceProject = useStore((s) => (route.name === 'workspace' ? s.workspaces.find((w) => w.id === route.workspaceId)?.projectId : undefined))
  const openProject = 'projectId' in route ? route.projectId : route.name === 'workspace' ? openWorkspaceProject : projects[0]?.id
  const toggle = (id: string, expanded: boolean) => {
    const next = { ...chosen, [id]: !expanded }
    setChosen(next)
    writeSavedJson(EXPANDED, next)
  }

  // Arriving on a workspace or chat from anywhere but the list (Open in the PRs list, the Inbox, search, the palette, a notification) brings its row into view.
  const list = useRef<HTMLDivElement>(null)
  const keep = useKeptScroll(list, { key: 'sidebar', ready: projects.length > 0 })
  const here = route.name === 'workspace' ? `workspace:${route.workspaceId}` : route.name === 'leadNew' ? `lead:${route.projectId}` : ''
  // Set by a click in the list until that click is handled: its row is already there, so it never moves the list, even when the row is cut off by an edge.
  const clicking = useRef(false)
  // Its project or chat was just opened, so the row isn't drawn yet. The next render that has it scrolls to it.
  const opening = useRef(false)
  const mounted = useRef(false)
  /** 'nearest' leaves a row that is fully in view where it is, and otherwise moves the list just far enough, never centering the row. */
  const showCurrent = () => {
    const row = list.current?.querySelector('[aria-current="page"]')
    if (row) keep.stop()
    row?.scrollIntoView({ block: 'nearest' })
    return !!row
  }
  useEffect(() => {
    opening.current = false
    if (!here || clicking.current) return
    // Only a move opens anything. A launch, or Settings giving the sidebar back, keeps the projects you closed (D-077).
    const s = getState()
    const held = mounted.current ? rowHolder(s.ui.route, projects, s.agents, s.workspaces, s.chats, s.threads, s.ui.foldedChats) : undefined
    const closed = !!held && !(chosen[held.projectId] ?? held.projectId === openProject)
    // Only the row's own project and chat open: every other choice of D-077 stays.
    if (held && closed) toggle(held.projectId, false)
    if (held?.unfold) actions.ui.foldChat(held.unfold.thread.id, false, held.unfold.tabs.map((c) => c.id))
    if (closed || held?.unfold) opening.current = true
    else showCurrent()
  }, [here])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (opening.current && showCurrent()) opening.current = false })

  return (
    <>
      {/* The strip lines up with the screen header (y 9 to 53), where the traffic lights sit. The toggle sits over the slot at x 87, mounted once by App so it is the same element when the sidebar hides (KERNEL-431). */}
      <div className="drag sb-titlebar">
        <span className="sidebar-toggle-slot" aria-hidden="true" />
        <span className="grow" />
        <HistoryButtons />
      </div>
      {/* Only the projects list gives up space when it outgrows the window, so the rows above it keep their height and y (flexShrink 0). */}
      <div className="row sb-switch-row">
        <AccountButton />
      </div>
      {/* Search looks like the Search settings field but is a button: it opens the ⌘K palette, the one place you search. */}
      <button type="button" className="sb-search" aria-keyshortcuts="Meta+K" onClick={() => actions.ui.openModal({ name: 'search' })}>
        <Icon name="search" size={14} /><span className="grow">Search</span><span className="muted nav-hint">⌘K</span>
      </button>
      <div className="nav-list sb-top-list">
        <button className="nav-item" onClick={() => openNewChat(openProject)}><Icon name="pen" /><span className="grow">New chat</span><span className="muted nav-hint">⌘N</span></button>
        <NavItem route={{ name: 'inbox' }} icon="inbox" label="Inbox" right={inbox ? <span className="nav-count">{inbox}</span> : null} />
        <NavItem route={{ name: workTab }} icon="issues" label="Work" />
      </div>
      <div className="sb-rule" role="separator" />
      <div ref={projectsAnchor} className="section-label hv sb-projects-label">
        <span>My projects</span>
        <button className="icon-btn more" style={{ width: 24, height: 24, opacity: projectsMenu ? 1 : undefined }} aria-label="Projects menu" aria-haspopup="menu" aria-expanded={projectsMenu} onClick={() => actions.ui.toggleMenu('projects')}><Icon name="more" size={14} /></button>
        {projectsMenu && <ProjectsMenu anchorRef={projectsAnchor} />}
      </div>
      {/* A project's menu is placed once, so scrolling the list closes it rather than leave it behind. */}
      <div
        ref={list} className="nav-list sb-scroll" onScroll={() => { if (getState().ui.menu?.startsWith('project:')) actions.ui.closeMenu() }}
        onClickCapture={() => { clicking.current = true; window.setTimeout(() => { clicking.current = false }) }}
      >
        {projects.map((r) => {
          const expanded = chosen[r.id] ?? r.id === openProject
          return <ProjectItem key={r.id} project={r} current={r.id === openProject} expanded={expanded} numbered={r.id === numberedProject} hints={hints} ctrlHints={ctrlHints} onToggle={() => toggle(r.id, expanded)} />
        })}
      </div>
      <div style={{ flex: 1 }} />
    </>
  )
}
