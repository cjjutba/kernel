import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Chat, Room, Thread, Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { Icon } from '../../icons'
import { IconButton, useBusy } from '../../ui'
import { actions, getState, go, useStore, type Route } from '../../store'
import { allOverlaps, inboxItems, needsYou } from '../../screens/inbox/model'
import { chatWorkspaces, isLeadWorkspace, leadOf, useLeadWaiting } from '../../lead'
import { archiveChatFromSidebar } from '../../screens/workspace/archiveChat'
import { currentThread } from '../../nav'
import { RoomIcon } from '../RoomIcon'
import { roomInView } from '../../screens/search/model'
import { archiveByHand } from '../../screens/workspace/byHand'
import { AccountButton } from './AccountMenu'
import { chatTrusts, chatWaits } from './chatWaits'
import { PlanButton } from './PlanMenu'
import { RoomMenu } from './RoomMenu'
import { ResizeHandle } from '../ResizeHandle'
import { RoomsMenu } from './RoomsMenu'
import { SIDEBAR_HIDE_BELOW, SIDEBAR_KEY, SIDEBAR_MIN, sidebarDefault, sidebarLimit, useSidebarWidth } from './useSidebarWidth'
import { liveWorkspaces, mergeChatList, openRow, sidebarRows, slotKey, slotsFor, type Slot } from './slots'
import { useLocalMerge } from '../../screens/workspace/pr/useLocalMerge'
import { chatGlyph, leadGlyph, workspaceGlyph, type WorkspaceGlyph } from './workspaceGlyph'
import './sidebar.css'

/** Routes hold only strings, so equal fields mean the same page. An unset field and a missing one are the same. */
const same = (a: Route, b: Route) => {
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>
  for (const k in x) if (x[k] !== y[k]) return false
  for (const k in y) if (!(k in x) && y[k] !== undefined) return false
  return true
}

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

function NavItem({ route, icon, label, right, sub, nested, slot, onOpen }: { route: Route; icon: string | ReactNode; label: ReactNode; right?: ReactNode; sub?: boolean; nested?: boolean; slot?: RowKey; /** In place of going to `route`. */ onOpen?: () => void }) {
  // Issues opens on an issue too, so any issue is the Issues row's page.
  const current = useStore((s) => same(s.ui.route, route) || (route.name === 'issues' && s.ui.route.name === 'issues'))
  return (
    <button className={`nav-item${sub ? ' nav-sub' : ''}${nested ? ' nav-nested' : ''}`} aria-current={current ? 'page' : undefined} aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={onOpen ?? (() => go(route))}>
      {typeof icon === 'string' ? <Icon name={icon} /> : icon}
      <span className="grow ellipsis">{label}</span>
      {slot?.hint ? <KeyHint n={slot.n} /> : right}
    </button>
  )
}

/** A row's state icon, with its state as the tooltip and the accessible name. */
function Glyph({ g }: { g: WorkspaceGlyph }) {
  return (
    <span className="nav-glyph" data-tone={g.tone} role="img" aria-label={g.label} data-tip={g.label}>
      {g.icon === 'spin' ? <span className="spin" /> : <Icon name={g.icon} />}
    </span>
  )
}

/**
 * The room's Lead, shown only while it has no open chat to list. It opens New chat with Rowan, where the first message starts a chat in its
 * own workspace (KERNEL-405). Its icon shows the Lead's floor status.
 */
function LeadItem({ roomId, slot }: { roomId: string; slot?: RowKey }) {
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const status = useStore((s) => (lead ? s.status[roomId]?.[lead.id] : undefined) ?? 'idle')
  const current = useStore((s) => { const r = s.ui.route; return (r.name === 'leadNew' && r.roomId === roomId) || (r.name === 'workspace' && s.workspaces.some((w) => w.id === r.workspaceId && isLeadWorkspace(w, roomId, lead?.id))) })
  const waiting = useLeadWaiting(roomId)
  if (!lead) return null
  const g = leadGlyph(status, waiting)
  return (
    <div>
      <button className="nav-item nav-sub" aria-current={current ? 'page' : undefined} aria-label={`${lead.name}, Lead chat, ${g.label}`} aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={() => openRow(roomId, { kind: 'lead' })}>
        <Glyph g={g} />
        <span className="grow ellipsis">{lead.name}</span>
        {slot?.hint ? <KeyHint n={slot.n} /> : <span className="muted" style={{ fontSize: 12 }}>Lead</span>}
      </button>
    </div>
  )
}

/**
 * One of the Lead's open chats, however many tabs it holds (KERNEL-338). Its icon is the one a tab would show, for the whole chat: something that
 * needs you in any tab wins, then its own workspace's setup, trust, failed setup or missing folder (KERNEL-405), then a running turn in any tab, else
 * the chat icon. They read the same approvals and `running` flags as the tabs. It opens the chat's own workspace on the tab last shown in it. A chat
 * that handed off workspaces folds like a room: hovering or tabbing to it swaps its icon for a chevron. While it is folded, the icon also shows what a
 * hidden workspace needs from you, so nothing waits out of sight. Hover shows Archive, like a workspace row's (KERNEL-405).
 */
function ChatItem({ roomId, thread, ws, tabs, owned, folded, slot }: { roomId: string; thread: Thread; ws?: Workspace; tabs: Chat[]; owned: Workspace[]; folded: boolean; slot?: RowKey }) {
  const approvals = useStore((s) => s.approvals)
  // A folded chat counts its workspaces: an unfolded one shows its own icon in its own row.
  const waiting = useMemo(() => chatWaits({ tabs, owned: folded ? owned : [], approvals }).map((w) => w.approval), [approvals, tabs, folded, owned])
  const running = useStore((s) => tabs.some((c) => s.running[c.id]))
  // The chat's own workspace is on screen (KERNEL-405).
  const current = useStore((s) => {
    const r = s.ui.route
    return r.name === 'workspace' && (ws ? r.workspaceId === ws.id : r.workspaceId === tabs[0]?.workspaceId && currentThread(s, r.workspaceId) === thread.id)
  })
  // A folded chat stands in for the workspaces it hides, so one held for script trust shows here too.
  const g = chatGlyph({ ws, waiting, running, trust: folded && chatTrusts(owned).length > 0 })
  const [busy, run] = useBusy()
  const archive = () => void run('archive', () => archiveChatFromSidebar(thread))
  return (
    <div className={`hv chat-row${busy ? ' busy' : ''}`} data-key={slot?.hint || undefined}>
      <button
        className="nav-item nav-sub" aria-current={current ? 'page' : undefined} aria-label={g.label ? `${thread.title}, ${g.label}` : thread.title}
        aria-keyshortcuts={slot && `Meta+${slot.n}`} onClick={() => openRow(roomId, { kind: 'chat', thread, tabs, owned, folded })}
      >
        <span className="nav-glyph" data-tone={g.tone} data-owned={owned.length ? '' : undefined} aria-hidden="true">{g.icon === 'spin' ? <span className="spin" /> : <Icon name={g.icon} />}</span>
        <span className="grow ellipsis">{thread.title}</span>
        {slot?.hint && <KeyHint n={slot.n} />}
      </button>
      {ws && (
        <div className="more ws-archive">
          {/* Just the icon, with no spinner or word, like a workspace row's (DESIGN.md, Busy buttons). useBusy still ignores a second click. */}
          <IconButton icon="archive" size={14} label={`Archive ${thread.title}`} style={{ width: 24, height: 24 }} disabled={!!busy} onClick={archive} />
        </div>
      )}
      {owned.length > 0 && (
        <button className="chat-chev" aria-expanded={!folded} aria-label={`${folded ? 'Expand' : 'Collapse'} ${thread.title}`} onClick={() => actions.ui.foldChat(thread.id, !folded, tabs.map((c) => c.id))}>
          <Icon name="right" size={14} />
        </button>
      )}
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
    actions.ui.toast({ title: `Archived ${ws.name}.`, sub: 'Find it in History.' })
  } catch (e) { actions.ui.toast({ title: `Could not archive ${ws.name}`, sub: cleanError(e) }) }
}

/**
 * A workspace row: its state icon (needs you, working, then the PR), its name, and its diff totals. Hover swaps the totals
 * for Archive.
 */
function WorkspaceItem({ ws, slot, nested }: { ws: Workspace; slot?: RowKey; nested?: boolean }) {
  const approvals = useStore((s) => s.approvals)
  const waiting = useMemo(() => approvals.filter((a) => a.workspaceId === ws.id && a.status === 'pending'), [approvals, ws.id])
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const [busy, run] = useBusy()
  const local = useLocalMerge(ws)
  const g = workspaceGlyph(ws, { waiting, running, local })
  const archive = () => void run('archive', () => archiveFromSidebar(ws))
  return (
    <div className={`hv ws-row${busy ? ' busy' : ''}`} data-key={slot?.hint || undefined}>
      <NavItem
        sub nested={nested} route={{ name: 'workspace', workspaceId: ws.id }} icon={<Glyph g={g} />} label={ws.name} slot={slot}
        onOpen={() => openRow(ws.roomId, { kind: 'workspace', ws, nested: !!nested })}
        right={ws.stat && (ws.stat.added || ws.stat.removed)
          ? <span className="mono ws-right ws-stat">{ws.stat.added ? <span className="add">+{ws.stat.added}</span> : null}{ws.stat.removed ? <span className="del">-{ws.stat.removed}</span> : null}</span>
          : ws.prNumber ? <span className="mono muted ws-right" style={{ fontSize: 11 }}>#{ws.prNumber}</span> : null}
      />
      <div className="more ws-archive">
        {/* Just the icon, with no spinner or word (DESIGN.md, Busy buttons). useBusy still ignores a second click. */}
        <IconButton icon="archive" size={14} label={`Archive ${ws.name}`} style={{ width: 24, height: 24 }} disabled={!!busy} onClick={archive} />
      </div>
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
 * A room in the sidebar. Expanded, it lists the Lead's open chats with the workspaces each started under it (unless the chat is folded), then the workspaces
 * no open chat owns (D-139; D-104 hid Floor and Board). Pressing the row folds or unfolds it, as in Conductor, and hovering it
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
  // Only the room in view is numbered. Its keys come from the same slots the shortcut reads.
  const order = useMemo(() => (numbered ? slotsFor(room, agents, workspaces, chats, threads).map(slotKey) : NO_KEYS), [numbered, room, agents, workspaces, chats, threads])
  const slotOf = (row: Slot): RowKey | undefined => { const i = order.indexOf(slotKey(row)); return i < 0 ? undefined : { n: i + 1, hint: hints } }
  const menuOpen = useStore((s) => s.ui.menu === `room:${room.id}`)
  const anchor = useRef<HTMLDivElement>(null)
  const homes = chatWorkspaces(workspaces, threads, room.id).map((w) => w.id)
  // A folded room in view still loads the Lead's chats, since ⌘1 to ⌘9 count them.
  useChatLists(expanded ? [...homes, ...liveWorkspaces(workspaces, room.id).map((w) => w.id)] : numbered ? homes : [])
  return (
    <div className="nav-list">
      <div ref={anchor} className="hv room-row" style={{ position: 'relative' }}>
        <button className="nav-item" style={{ color: current ? 'var(--ink)' : undefined, paddingRight: 60 }} aria-expanded={expanded} onClick={onToggle}>
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
      {expanded && rows.map((row) => {
        const key = slotKey(row)
        if (row.kind === 'lead') return <LeadItem key={key} roomId={room.id} slot={slotOf(row)} />
        if (row.kind === 'chat') return <ChatItem key={key} roomId={room.id} thread={row.thread} ws={row.ws} tabs={row.tabs} owned={row.owned} folded={row.folded} slot={slotOf(row)} />
        return <WorkspaceItem key={key} ws={row.ws} nested={row.nested} slot={slotOf(row)} />
      })}
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

export function Sidebar() {
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
  const plan = useStore((s) => s.account?.plan)
  const roomsAnchor = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState(readExpanded)
  const nav = useRef<HTMLElement>(null)
  const { width, onCommit } = useSidebarWidth()
  const openRoom = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : rooms[0]?.id
  const toggle = (id: string, expanded: boolean) => {
    const next = { ...chosen, [id]: !expanded }
    setChosen(next)
    try { localStorage.setItem(EXPANDED, JSON.stringify(next)) } catch { /* not remembered */ }
  }

  return (
    <nav ref={nav} aria-label="Sidebar" className="sidebar" style={{ width }}>
      {/* The strip lines up with the screen header (y 9 to 53), where the traffic lights sit. The toggle is at x 87, the spot the header's Show sidebar takes when hidden (KERNEL-431). */}
      <div className="drag" style={{ height: 53, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '9px 0 0 77px' }}>
        <IconButton className="nodrag" icon="sidebar" size={15} label="Hide sidebar" data-tip-kbd="⌘B" onClick={() => actions.ui.setSidebar(false)} />
      </div>
      <div className="row" style={{ height: 36, paddingLeft: 4 }}>
        <AccountButton />
        <span className="grow" />
        <button className="icon-btn" aria-label="New chat" data-tip-kbd="⌘N" style={{ border: '1px solid var(--line-2)', background: 'var(--surface)' }} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: openRoom })}><Icon name="compose" /></button>
      </div>
      <div className="nav-list" style={{ marginTop: 10 }}>
        <button className="nav-item" onClick={() => actions.ui.openModal({ name: 'search' })}><Icon name="search" /><span className="grow">Search</span><span className="muted" style={{ fontSize: 11.5 }}>⌘K</span></button>
        <NavItem route={{ name: 'home' }} icon="home" label="Home" />
        <NavItem route={{ name: 'inbox' }} icon="inbox" label="Inbox" right={inbox ? <span className="nav-count">{inbox}</span> : null} />
        <NavItem route={{ name: 'issues' }} icon="issues" label="Issues" />
        <NavItem route={{ name: 'history' }} icon="history" label="History" />
      </div>
      <div className="sb-rule" role="separator" />
      <div ref={roomsAnchor} className="section-label hv" style={{ position: 'relative', marginTop: 8 }}>
        <span>Your rooms</span>
        <button className="icon-btn more" style={{ width: 24, height: 24, opacity: roomsMenu ? 1 : undefined }} aria-label="Rooms menu" aria-haspopup="menu" aria-expanded={roomsMenu} onClick={() => actions.ui.toggleMenu('rooms')}><Icon name="more" size={14} /></button>
        {roomsMenu && <RoomsMenu anchorRef={roomsAnchor} />}
      </div>
      {/* A room's menu is placed once, so scrolling the list closes it rather than leave it behind. */}
      <div className="nav-list" style={{ overflowY: 'auto', minHeight: 0 }} onScroll={() => { if (getState().ui.menu?.startsWith('room:')) actions.ui.closeMenu() }}>
        {rooms.map((r) => {
          const expanded = chosen[r.id] ?? r.id === openRoom
          return <RoomItem key={r.id} room={r} current={r.id === openRoom} expanded={expanded} numbered={r.id === numberedRoom} hints={hints} onToggle={() => toggle(r.id, expanded)} />
        })}
      </div>
      <div style={{ flex: 1 }} />
      {/* The plan on the left, What's new and Settings on the right, as in Conductor. */}
      <div className="sb-foot">
        {plan && <PlanButton plan={plan} />}
        <span className="grow" />
        <IconButton icon="sparkle" label="What's new" onClick={() => actions.ui.openModal({ name: 'whatsNew' })} />
        <IconButton icon="sliders" label="Settings" data-tip-kbd="⌘," onClick={() => actions.ui.openSettings()} />
      </div>
      <ResizeHandle
        targetRef={nav} edge="right" label="Resize sidebar" width={width} min={SIDEBAR_MIN} limit={sidebarLimit} defaultWidth={sidebarDefault}
        storageKey={SIDEBAR_KEY} hideBelow={SIDEBAR_HIDE_BELOW} onHide={() => actions.ui.setSidebar(false)} onCommit={onCommit}
      />
    </nav>
  )
}
