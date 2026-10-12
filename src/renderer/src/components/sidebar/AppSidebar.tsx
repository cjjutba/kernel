import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Chat, Room, Thread, Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { Icon, type IconName } from '../../icons'
import { IconButton, useBusy } from '../../ui'
import { actions, getState, go, useStore, type Route } from '../../store'
import { allOverlaps, inboxItems, needsYou } from '../../screens/inbox/model'
import { chatWorkspaces, isLeadWorkspace, leadOf, useLeadWaiting } from '../../lead'
import { archiveChatFromSidebar, archivingChat } from '../../screens/workspace/archiveChat'
import { reducedMotion, useArriving, useStage } from '../../screens/workspace/archiveMotion'
import { currentThread } from '../../nav'
import { RoomIcon } from '../RoomIcon'
import { roomInView } from '../../screens/search/model'
import { archiveByHand } from '../../screens/workspace/byHand'
import { AccountButton } from './AccountMenu'
import { chatTrusts, chatWaits } from './chatWaits'
import { ChatCard, LeadCard, WorkspaceCard, useHoverCard } from './HoverCard'
import { PlanButton } from './PlanMenu'
import { RoomMenu } from './RoomMenu'
import { RoomsMenu } from './RoomsMenu'
import { liveWorkspaces, mergeChatList, openRow, rowHolder, sidebarRows, slotKey, slotsFor, type Slot } from './slots'
import { useLocalMerge } from '../../screens/workspace/pr/useLocalMerge'
import { useShown, type Fate, type Shown } from './leaving'
import { chatUnread, roomUnread, workspaceRowUnread } from './unread'
import { chatGlyph, leadGlyph, workspaceGlyph, type WorkspaceGlyph } from './workspaceGlyph'
import { workspaceRowLabel } from './workspaceRowLabel'

/** Routes hold only strings, so equal fields mean the same page. An unset field and a missing one are the same. */
const same = (a: Route, b: Route) => {
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>
  for (const k in x) if (x[k] !== y[k]) return false
  for (const k in y) if (!(k in x) && y[k] !== undefined) return false
  return true
}

/** A row whose workspace was archived and has left the list, and is still drawn: `from` is the route the archive moved off, and `held` means it waits as it was. */
type Gone = { from?: Route; held?: boolean }

/** How long ⌘ is held alone before the rows show their numbers. Shorter and ⌘K or ⌘C would flash them. */
const HINT_DELAY = 400

/** True once ⌘ has been held alone for HINT_DELAY. Another key, letting go of ⌘ or the window losing focus ends it. */
function useCmdHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    let timer: number | undefined
    const off = () => { window.clearTimeout(timer); timer = undefined; setHeld(false) }
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' || e.ctrlKey || e.altKey || e.shiftKey) return off()
      if (e.repeat || timer !== undefined) return
      timer = window.setTimeout(() => setHeld(true), HINT_DELAY)
    }
    const up = (e: KeyboardEvent) => { if (e.key === 'Meta') off() }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', off)
    return () => { off(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', off) }
  }, [])
  return held
}

/** A numbered row's ⌘N, shown at its right end while ⌘ is held. The row's aria-keyshortcuts says the same to a screen reader. */
const KeyHint = ({ n }: { n: number }) => <span className="mono nav-key" aria-hidden="true">⌘{n}</span>

/** A row's place in the room's ⌘1 to ⌘9 order, and whether ⌘ is held so it should show. Rows of other rooms get none. */
type RowKey = { n: number; hint: boolean }

/** The icon a row shows while it runs: the one it has at rest, since the spinner goes to the row's right end. `rest` is the glyph without the activity, `fallback` stands in when the rest state is a spinner too. */
const restIcon = (g: WorkspaceGlyph, rest: WorkspaceGlyph, fallback: IconName): WorkspaceGlyph & { icon: IconName } => {
  const at = g.icon === 'spin' ? rest : g
  return { ...g, icon: at.icon === 'spin' ? fallback : at.icon, tone: at.tone }
}

/** The spinner at a row's right end, 10px from the counts. It leaves with them when Archive takes the end on hover (`archivable`). */
const RunningMark = ({ archivable }: { archivable?: boolean }) => <span className={`spin${archivable ? ' ws-right' : ''}`} aria-hidden="true" />

function NavItem({ route, icon, label, right, sub, nested, slot, unread, onOpen, leaving }: { route: Route; icon: string | ReactNode; label: ReactNode; right?: ReactNode; sub?: boolean; nested?: boolean; slot?: RowKey; /** The row's name when it has something new: its title goes bold and its label ends in Unread (KERNEL-508). */ unread?: string; /** In place of going to `route`. */ onOpen?: () => void; /** The row's workspace was archived. It folds away, keeping the fill it had on the screen the archive left (`from`), or `held` waits for its chat to fold. */ leaving?: Gone }) {
  // Issues opens on an issue too, so any issue is the Issues row's page.
  const current = useStore((s) => { const r = leaving ? leaving.from ?? s.ui.route : s.ui.route; return same(r, route) || (route.name === 'issues' && r.name === 'issues') })
  const arrive = useArriving(current && !leaving)
  return (
    <button className={`nav-item${sub ? ' nav-sub' : ''}${nested ? ' nav-nested' : ''}`} aria-current={current && !leaving ? 'page' : undefined} data-was-current={current && leaving ? '' : undefined} data-arrive={arrive ? '' : undefined} aria-label={unread === undefined ? undefined : `${unread}, Unread`} data-unread={unread === undefined ? undefined : ''} aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={onOpen ?? (() => go(route))}>
      {typeof icon === 'string' ? <Icon name={icon} /> : icon}
      <span className="grow ellipsis">{label}</span>
      {slot?.hint ? <KeyHint n={slot.n} /> : right}
    </button>
  )
}

/** A row's state icon. Its state is the accessible name. */
function Glyph({ g }: { g: WorkspaceGlyph }) {
  return (
    <span className="nav-glyph" data-tone={g.tone} role="img" aria-label={g.label}>
      {g.icon === 'spin' ? <span className="spin" /> : <Icon name={g.icon} />}
    </span>
  )
}

/**
 * The room's Lead, shown only while it has no open chat to list. It opens New chat with Rowan, where the first message starts a chat in its
 * own workspace (KERNEL-405). Its icon shows what waits on you, and a working Lead adds the spinner at its right end.
 */
function LeadItem({ roomId, slot }: { roomId: string; slot?: RowKey }) {
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const status = useStore((s) => (lead ? s.status[roomId]?.[lead.id] : undefined) ?? 'idle')
  const current = useStore((s) => { const r = s.ui.route; return (r.name === 'leadNew' && r.roomId === roomId) || (r.name === 'workspace' && s.workspaces.some((w) => w.id === r.workspaceId && isLeadWorkspace(w, roomId, lead?.id))) })
  const waiting = useLeadWaiting(roomId)
  const arrive = useArriving(current)
  const card = useHoverCard<HTMLButtonElement>()
  if (!lead) return null
  const g = leadGlyph(status, waiting)
  const shown = restIcon(g, leadGlyph('idle', waiting), 'chat')
  return (
    <>
      <button className="nav-item nav-sub" {...card.bind} aria-current={current ? 'page' : undefined} data-arrive={arrive ? '' : undefined} aria-label={`${lead.name}, Lead chat, ${g.label}`} aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={() => openRow(roomId, { kind: 'lead' })}>
        <Glyph g={shown} />
        <span className="grow ellipsis">{lead.name}</span>
        {slot?.hint ? <KeyHint n={slot.n} /> : <><span className="muted" style={{ fontSize: 12 }}>Lead</span>{g.icon === 'spin' && <RunningMark />}</>}
      </button>
      {card.at && <LeadCard roomId={roomId} at={card.at} id={card.id} hold={card.hold} />}
    </>
  )
}

/**
 * One of the Lead's open chats, however many tabs it holds (KERNEL-338). Its icon is the one a tab would show, for the whole chat: something that
 * needs you in any tab wins, then its own workspace's setup, trust, failed setup or missing folder (KERNEL-405), then a running turn in any tab, else
 * the chat icon. They read the same approvals and `running` flags as the tabs. It opens the chat's own workspace on the tab last shown in it. A chat
 * that handed off workspaces folds like a room: hovering or tabbing to it swaps its icon for a chevron. While it is folded, the icon also shows what a
 * hidden workspace needs from you, so nothing waits out of sight. Hover shows Archive, like a workspace row's (KERNEL-405). A running turn never changes
 * the icon: it adds the spinner at the row's right end, unless the chat itself waits on you, where the wait is all the row shows (KERNEL-601).
 */
function ChatItem({ roomId, thread, ws, tabs, owned, folded, slot, leaving, onSettled }: { roomId: string; thread: Thread; ws?: Workspace; tabs: Chat[]; owned: Workspace[]; folded: boolean; slot?: RowKey; leaving?: Gone; onSettled?: () => void }) {
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
  // A folded chat stands in for the workspaces it hides, so one held for script trust shows here too.
  const trust = folded && chatTrusts(owned).length > 0
  const g = chatGlyph({ ws, waiting, running, trust })
  // The icon is the one the chat has at rest. A wait on one of its own tabs stops the turn, so it shows no spinner; one on a hidden workspace doesn't.
  const busy = g.icon === 'spin' || (running && !waits.some((w) => w.key.startsWith('chat:')))
  const shown = restIcon(g, chatGlyph({ ws, waiting, running: false, trust }), 'chat')
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
        aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={() => openRow(roomId, { kind: 'chat', thread, tabs, owned, folded })}
      >
        <span className="nav-glyph" data-tone={shown.tone} data-owned={owned.length ? '' : undefined} aria-hidden="true"><Icon name={shown.icon} /></span>
        <span className="grow ellipsis">{thread.title}</span>
        {slot?.hint ? <KeyHint n={slot.n} /> : busy && <RunningMark archivable={!!ws} />}
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
      {card.at && <ChatCard roomId={roomId} thread={thread} tabs={tabs} owned={owned} at={card.at} id={card.id} hold={card.hold} onArchive={ws ? () => { card.close(); archive() } : undefined} />}
    </div>
  )
}

/**
 * The row's archive button archives in one click, like Conductor, when nothing would be lost. Uncommitted changes, commits
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
 * A workspace row: its state icon (needs you, then the PR, or the branch), its name, its diff totals from 300px of sidebar, and a spinner while it runs. Hover swaps
 * that right end for Archive. Resting on it opens its card.
 */
function WorkspaceItem({ ws, parent, slot, nested, leaving, onSettled }: { ws: Workspace; /** The title of the chat that started it, for the card. */ parent?: string; slot?: RowKey; nested?: boolean; leaving?: Gone; onSettled?: () => void }) {
  const approvals = useStore((s) => s.approvals)
  const waiting = useMemo(() => approvals.filter((a) => a.workspaceId === ws.id && a.status === 'pending'), [approvals, ws.id])
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const [archiving, run] = useBusy()
  const local = useLocalMerge(ws)
  const pending = useStore((s) => s.prPending[ws.id])
  const g = workspaceGlyph(ws, { waiting, running, local, pending })
  // Running adds the spinner at the row's right end and leaves the icon the workspace has at rest.
  const shown = restIcon(g, workspaceGlyph(ws, { waiting, running: false, local }), 'branch')
  const current = useStore((s) => same(leaving ? leaving.from ?? s.ui.route : s.ui.route, { name: 'workspace', workspaceId: ws.id }))
  const unread = useStore((s) => workspaceRowUnread(s.chats[ws.id], current))
  const archive = () => void run('archive', () => archiveFromSidebar(ws))
  const label = workspaceRowLabel(ws)
  const diff = !!ws.stat && !!(ws.stat.added || ws.stat.removed)
  const card = useHoverCard()
  return (
    <div {...card.bind} className={`hv ws-row${archiving ? ' busy' : ''}${leaving && !leaving.held ? ' row-fold' : ''}`} data-key={slot?.hint || undefined} inert={leaving ? true : undefined} onAnimationEnd={(e) => { if (e.target === e.currentTarget && e.animationName === 'archive-fold') onSettled?.() }}>
      <NavItem
        sub nested={nested} leaving={leaving} route={{ name: 'workspace', workspaceId: ws.id }} icon={<Glyph g={shown} />} label={label} slot={slot} unread={unread ? (g.label ? `${label}, ${g.label}` : label) : undefined}
        onOpen={() => openRow(ws.roomId, { kind: 'workspace', ws, nested: !!nested })}
        right={<>
          {diff && ws.stat && <span className="mono ws-right ws-stat">{ws.stat.added ? <span className="add">+{ws.stat.added}</span> : null}{ws.stat.removed ? <span className="del">-{ws.stat.removed}</span> : null}</span>}
          {ws.prNumber ? <span className="mono muted ws-right ws-pr" style={{ fontSize: 11 }}>#{ws.prNumber}</span> : null}
          {g.icon === 'spin' && <RunningMark archivable />}
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
 * The rows of a room as the blocks they are drawn in (KERNEL-601): each open chat with the workspaces it started, the Lead's row alone, and the workspaces no open
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
 * A room in the sidebar. Expanded, it lists the Lead's open chats with the workspaces each started under it (unless the chat is folded), then the workspaces
 * no open chat owns (D-139). Pressing the row folds or unfolds it, as in Conductor, and hovering it
 * swaps the room's letter for a chevron and shows the menu button.
 */
const NO_KEYS: string[] = []

function RoomItem({ room, current, expanded, numbered, hints, onToggle }: { room: Room; current: boolean; expanded: boolean; numbered: boolean; hints: boolean; onToggle: () => void }) {
  const agents = useStore((s) => s.agents)
  const workspaces = useStore((s) => s.workspaces)
  const chats = useStore((s) => s.chats)
  const threads = useStore((s) => s.threads)
  const foldedChats = useStore((s) => s.ui.foldedChats)
  const rows = useMemo(() => sidebarRows(room, agents, workspaces, chats, threads, foldedChats), [room, agents, workspaces, chats, threads, foldedChats])
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
  // Only the room in view is numbered. Its keys come from the same slots the shortcut reads.
  const order = useMemo(() => (numbered ? slotsFor(room, agents, workspaces, chats, threads).map(slotKey) : NO_KEYS), [numbered, room, agents, workspaces, chats, threads])
  const slotOf = (row: Slot): RowKey | undefined => { const i = order.indexOf(slotKey(row)); return i < 0 ? undefined : { n: i + 1, hint: hints } }
  const menuOpen = useStore((s) => s.ui.menu === `room:${room.id}`)
  const anchor = useRef<HTMLDivElement>(null)
  const homes = chatWorkspaces(workspaces, threads, room.id).map((w) => w.id)
  // A collapsed room loads its chats too: ⌘1 to ⌘9 count the Lead's, and the room is bold when any of them is unread (KERNEL-508).
  useChatLists([...homes, ...liveWorkspaces(workspaces, room.id).map((w) => w.id)])
  const unread = roomUnread({ rows, chats, expanded })
  return (
    <div className="nav-list">
      <div ref={anchor} className="hv room-row" style={{ position: 'relative' }}>
        <button className="nav-item" style={{ color: current ? 'var(--ink)' : undefined, paddingRight: 60 }} aria-expanded={expanded} aria-label={unread ? `${room.name}, Unread` : undefined} data-unread={unread ? '' : undefined} onClick={onToggle}>
          <span className="room-mark">
            <RoomIcon room={room} className="room-letter" current={current} />
            <span className="room-chev" data-open={expanded}><Icon name="right" size={14} /></span>
          </span>
          <span className="grow ellipsis">{room.name}</span>
        </button>
        {/* New chat stays visible, as in Conductor. The menu button shows on hover or keyboard focus, or while its menu is open. */}
        <div className="row" style={{ position: 'absolute', right: 4, top: 3, gap: 2 }}>
          <button className="icon-btn more" style={{ width: 24, height: 24, opacity: menuOpen ? 1 : undefined }} aria-label={`${room.name} options`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu(`room:${room.id}`)}><Icon name="more" size={14} /></button>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`New chat in ${room.name}`} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id })}><Icon name="plus" size={14} /></button>
        </div>
        {menuOpen && <RoomMenu room={room} anchorRef={anchor} />}
      </div>
      {expanded && blocksOf(shown).map((block) => (
        // A block that folds as one box, or the Lead's that opens, reports it here, since its rows carry no animation of their own then.
        <div
          key={block[0].row.kind === 'workspace' ? 'unowned' : block[0].key} className={`nav-group${block.some((i) => i.opening) ? ' row-open' : ''}`} data-guide={block[0].row.kind === 'chat' && block.length > 1 ? '' : undefined}
          onAnimationEnd={(e) => { if (e.target === e.currentTarget && (e.animationName === 'archive-fold' || e.animationName === 'archive-open')) block.forEach((i) => { if (i.leaving || i.opening) settle(i.key) }) }}
        >
          {block.map(({ key, row, leaving, held }) => {
            const gone = leaving || held ? { from: leftFrom, held } : undefined
            if (row.kind === 'lead') return <LeadItem key={key} roomId={room.id} slot={slotOf(row)} />
            if (row.kind === 'chat') return <ChatItem key={key} roomId={room.id} thread={row.thread} ws={row.ws} tabs={row.tabs} owned={row.owned} folded={row.folded} slot={slotOf(row)} leaving={gone} onSettled={() => settle(key)} />
            return <WorkspaceItem key={key} ws={row.ws} parent={row.nested && block[0].row.kind === 'chat' ? block[0].row.thread.title : undefined} nested={row.nested} slot={slotOf(row)} leaving={gone} onSettled={() => settle(key)} />
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * Rooms expanded (true) or collapsed (false) by hand, by id. A room left alone is expanded while it is the current one.
 * localStorage keeps them across launches, and may be missing or blocked.
 */
const EXPANDED = 'kernel.roomsExpanded'
function readExpanded(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(EXPANDED) ?? '{}') as Record<string, boolean> } catch { return {} }
}

/**
 * What the sidebar frame holds in the app: the traffic-light strip with Hide sidebar, the account row, the nav items, the rooms and the footer.
 * The frame (Sidebar.tsx) owns the `<nav>`, the width and the resize edge, so these are its direct flex children.
 */
export function AppSidebar() {
  const rooms = useStore((s) => s.rooms.filter((r) => !r.hidden && !r.archived))
  const workspaces = useStore((s) => s.workspaces)
  // The count reads these four slices, plus the workspaces held for script trust, and nothing else, so terminal chunks and script lines leave it alone.
  const notifications = useStore((s) => s.notifications)
  const approvals = useStore((s) => s.approvals)
  const allRooms = useStore((s) => s.rooms)
  const overlaps = useStore((s) => s.overlaps)
  const inbox = useMemo(() => inboxItems(notifications, approvals, allRooms, allOverlaps(overlaps), workspaces).filter(needsYou).length, [notifications, approvals, allRooms, overlaps, workspaces])
  const route = useStore((s) => s.ui.route)
  const numberedRoom = useStore((s) => roomInView(s.ui.route, s.rooms, s.workspaces)?.id)
  const hints = useCmdHeld()
  const roomsMenu = useStore((s) => s.ui.menu === 'rooms')
  const roomsAnchor = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState(readExpanded)
  const openRoom = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : rooms[0]?.id
  const toggle = (id: string, expanded: boolean) => {
    const next = { ...chosen, [id]: !expanded }
    setChosen(next)
    try { localStorage.setItem(EXPANDED, JSON.stringify(next)) } catch { /* not remembered */ }
  }

  // Arriving on a workspace or chat from anywhere but the list (Open in the PRs list, the Inbox, search, the palette, a notification) brings its row into view.
  const list = useRef<HTMLDivElement>(null)
  const here = route.name === 'workspace' ? `workspace:${route.workspaceId}` : route.name === 'leadNew' ? `lead:${route.roomId}` : ''
  // Set by a click in the list until that click is handled: its row is already there, so it never moves the list, even when the row is cut off by an edge.
  const clicking = useRef(false)
  // Its room or chat was just opened, so the row isn't drawn yet. The next render that has it scrolls to it.
  const opening = useRef(false)
  const mounted = useRef(false)
  /** 'nearest' leaves a row that is fully in view where it is, and otherwise moves the list just far enough, never centering the row. */
  const showCurrent = () => {
    const row = list.current?.querySelector('[aria-current="page"]')
    row?.scrollIntoView({ block: 'nearest' })
    return !!row
  }
  useEffect(() => {
    opening.current = false
    if (!here || clicking.current) return
    // Only a move opens anything. A launch, or Settings giving the sidebar back, keeps the rooms you closed (D-077).
    const s = getState()
    const held = mounted.current ? rowHolder(s.ui.route, rooms, s.agents, s.workspaces, s.chats, s.threads, s.ui.foldedChats) : undefined
    const closed = !!held && !(chosen[held.roomId] ?? held.roomId === openRoom)
    // Only the row's own room and chat open: every other choice of D-077 stays.
    if (held && closed) toggle(held.roomId, false)
    if (held?.unfold) actions.ui.foldChat(held.unfold.thread.id, false, held.unfold.tabs.map((c) => c.id))
    if (closed || held?.unfold) opening.current = true
    else showCurrent()
  }, [here])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (opening.current && showCurrent()) opening.current = false })

  return (
    <>
      {/* The strip lines up with the screen header (y 9 to 53), where the traffic lights sit. The toggle is at x 87, the spot the header's Show sidebar takes when hidden (KERNEL-431). */}
      <div className="drag" style={{ height: 53, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '9px 0 0 77px' }}>
        <IconButton className="nodrag" icon="sidebar" size={15} label="Hide sidebar" data-tip-kbd="⌘B" onClick={() => actions.ui.setSidebar(false)} />
      </div>
      {/* Only the rooms list gives up space when it outgrows the window, so the rows above it keep their height and y (flexShrink 0). */}
      <div className="row" style={{ height: 36, paddingLeft: 4, flexShrink: 0 }}>
        <AccountButton />
        <span className="grow" />
        <button className="icon-btn" aria-label="New chat" data-tip-kbd="⌘N" style={{ border: '1px solid var(--line-2)', background: 'var(--surface)' }} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: openRoom })}><Icon name="compose" /></button>
      </div>
      <div className="nav-list" style={{ marginTop: 10, flexShrink: 0 }}>
        <button className="nav-item" onClick={() => actions.ui.openModal({ name: 'search' })}><Icon name="search" /><span className="grow">Search</span><span className="muted" style={{ fontSize: 11.5 }}>⌘K</span></button>
        <NavItem route={{ name: 'home' }} icon="home" label="Home" />
        <NavItem route={{ name: 'inbox' }} icon="inbox" label="Inbox" right={inbox ? <span className="nav-count">{inbox}</span> : null} />
        <NavItem route={{ name: 'issues' }} icon="issues" label="Issues" />
        <NavItem route={{ name: 'history' }} icon="history" label="History" />
      </div>
      <div className="sb-rule" role="separator" />
      <div ref={roomsAnchor} className="section-label hv" style={{ position: 'relative', marginTop: 8, flexShrink: 0 }}>
        <span>Your rooms</span>
        <button className="icon-btn more" style={{ width: 24, height: 24, opacity: roomsMenu ? 1 : undefined }} aria-label="Rooms menu" aria-haspopup="menu" aria-expanded={roomsMenu} onClick={() => actions.ui.toggleMenu('rooms')}><Icon name="more" size={14} /></button>
        {roomsMenu && <RoomsMenu anchorRef={roomsAnchor} />}
      </div>
      {/* A room's menu is placed once, so scrolling the list closes it rather than leave it behind. */}
      <div
        ref={list} className="nav-list sb-scroll" onScroll={() => { if (getState().ui.menu?.startsWith('room:')) actions.ui.closeMenu() }}
        onClickCapture={() => { clicking.current = true; window.setTimeout(() => { clicking.current = false }) }}
      >
        {rooms.map((r) => {
          const expanded = chosen[r.id] ?? r.id === openRoom
          return <RoomItem key={r.id} room={r} current={r.id === openRoom} expanded={expanded} numbered={r.id === numberedRoom} hints={hints} onToggle={() => toggle(r.id, expanded)} />
        })}
      </div>
      <div style={{ flex: 1 }} />
      {/* Settings and What's new on the left, the Usage pill on the right, so Tab follows the same order. Ask Rowan and the update pill are in the footer (KERNEL-588). */}
      <div className="sb-foot">
        <IconButton icon="gear" label="Settings" data-tip-kbd="⌘," onClick={() => actions.ui.openSettings()} />
        <IconButton icon="sparkle" label="What's new" onClick={() => actions.ui.openModal({ name: 'whatsNew' })} />
        <span className="grow" />
        <PlanButton />
      </div>
    </>
  )
}
