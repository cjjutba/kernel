import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Room, Workspace } from '@shared/types'
import { call } from '../../api'
import { Icon } from '../../icons'
import { IconButton, useBusy } from '../../ui'
import { actions, getState, go, useStore, type Route } from '../../store'
import { allOverlaps, inboxItems, needsYou } from '../../screens/inbox/model'
import { isLeadWorkspace, leadOf, openLead, useLeadWaiting } from '../../lead'
import { roomLetter } from '../../screens/rooms/roomInfo'
import { AccountButton } from './AccountMenu'
import { LeadCard, WorkspaceCard, useHoverCard } from './HoverCard'
import { PlanButton } from './PlanMenu'
import { RoomMenu } from './RoomMenu'
import { ResizeHandle, readWidth } from '../ResizeHandle'
import { RoomsMenu } from './RoomsMenu'
import { leadGlyph, workspaceGlyph, type WorkspaceGlyph } from './workspaceGlyph'
import './sidebar.css'

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

function NavItem({ route, icon, label, right, sub, describedBy }: { route: Route; icon: string | ReactNode; label: ReactNode; right?: ReactNode; sub?: boolean; describedBy?: string }) {
  const current = useStore((s) => same(s.ui.route, route))
  return (
    <button className={`nav-item${sub ? ' nav-sub' : ''}`} aria-current={current ? 'page' : undefined} aria-describedby={describedBy} onClick={() => go(route)}>
      {typeof icon === 'string' ? <Icon name={icon} /> : icon}
      <span className="grow ellipsis">{label}</span>
      {right}
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
 * The room's Lead, under Board. It opens the Lead's chat, and works before the first brief too: `lead.open` makes the workspace.
 * Its icon shows the Lead's floor status, and hovering it shows the Lead's card.
 */
function LeadItem({ roomId }: { roomId: string }) {
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const status = useStore((s) => (lead ? s.status[roomId]?.[lead.id] : undefined) ?? 'idle')
  const current = useStore((s) => { const r = s.ui.route; return r.name === 'workspace' && s.workspaces.some((w) => w.id === r.workspaceId && isLeadWorkspace(w, roomId, lead?.id)) })
  const waiting = useLeadWaiting(roomId)
  const card = useHoverCard()
  if (!lead) return null
  const g = leadGlyph(status, waiting)
  return (
    <div {...card.bind}>
      <button className="nav-item nav-sub" aria-current={current ? 'page' : undefined} aria-label={`${lead.name}, Lead chat, ${g.label}`} aria-describedby={card.at ? card.id : undefined} onClick={() => void openLead(roomId)}>
        <Glyph g={g} />
        <span className="grow ellipsis">{lead.name}</span>
        <span className="muted" style={{ fontSize: 12 }}>Lead</span>
      </button>
      {card.at && <LeadCard roomId={roomId} at={card.at} id={card.id} />}
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
    await call('workspaces.archive', { workspaceId: ws.id })
    actions.ui.toast({ title: `Archived ${ws.name}.`, sub: 'Find it in History.' })
  } catch (e) { actions.ui.toast({ title: `Could not archive ${ws.name}`, sub: (e as Error).message }) }
}

/**
 * A workspace row: its state icon (needs you, working, then the PR), its name, and its diff totals. Hover swaps the totals
 * for Archive and, after a moment, shows the workspace's card.
 */
function WorkspaceItem({ ws }: { ws: Workspace }) {
  const approvals = useStore((s) => s.approvals)
  const waiting = useMemo(() => approvals.filter((a) => a.workspaceId === ws.id && a.status === 'pending'), [approvals, ws.id])
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const [busy, run] = useBusy()
  const card = useHoverCard()
  const g = workspaceGlyph(ws, { waiting, running })
  const archive = () => void run('archive', () => archiveFromSidebar(ws))
  return (
    <div {...card.bind} className={`hv ws-row${busy ? ' busy' : ''}`}>
      <NavItem
        sub route={{ name: 'workspace', workspaceId: ws.id }} icon={<Glyph g={g} />} label={ws.name} describedBy={card.at ? card.id : undefined}
        right={ws.stat && (ws.stat.added || ws.stat.removed)
          ? <span className="mono ws-right ws-stat">{ws.stat.added ? <span className="add">+{ws.stat.added}</span> : null}{ws.stat.removed ? <span className="del">-{ws.stat.removed}</span> : null}</span>
          : ws.prNumber ? <span className="mono muted ws-right" style={{ fontSize: 11 }}>#{ws.prNumber}</span> : null}
      />
      <div className="more ws-archive" data-card-off>
        {/* Just the icon, with no spinner or word (DESIGN.md, Busy buttons). useBusy still ignores a second click. */}
        <IconButton icon="archive" size={14} label={`Archive ${ws.name}`} style={{ width: 24, height: 24 }} disabled={!!busy} onClick={archive} />
      </div>
      {card.at && <WorkspaceCard ws={ws} at={card.at} id={card.id} />}
    </div>
  )
}

/**
 * Chat lists for the workspace rows, which load only when a workspace opens. With them a row shows it is working before
 * you open it; chat pushes keep them current after that.
 */
function useChatLists(workspaceIds: string[]) {
  const key = workspaceIds.join()
  useEffect(() => {
    for (const id of workspaceIds) {
      if (getState().chats[id]) continue
      void call('chats.list', { workspaceId: id }).then((list) => { if (!getState().chats[id]) actions.chats.set(id, list) }).catch(() => undefined)
    }
  }, [key])
}

/**
 * A room in the sidebar. Expanded, it lists Team, the Lead and its live workspaces (D-104 hid Floor and Board). Pressing the row folds or unfolds it,
 * as in Conductor, and hovering it swaps the room's letter for a chevron and shows the menu button.
 */
function RoomItem({ room, current, expanded, onToggle }: { room: Room; current: boolean; expanded: boolean; onToggle: () => void }) {
  const live = useStore((s) => s.workspaces.filter((w) => w.roomId === room.id && w.status !== 'archived' && w.name !== 'lead'))
  const menuOpen = useStore((s) => s.ui.menu === `room:${room.id}`)
  const anchor = useRef<HTMLDivElement>(null)
  useChatLists(expanded ? live.map((w) => w.id) : [])
  return (
    <div className="nav-list">
      <div ref={anchor} className="hv room-row" style={{ position: 'relative' }}>
        <button className="nav-item" style={{ color: current ? 'var(--ink)' : undefined, paddingRight: 60 }} aria-expanded={expanded} onClick={onToggle}>
          <span className="room-mark">
            <span className="room-letter" data-current={current || undefined}>{roomLetter(room.name)}</span>
            <span className="room-chev" data-open={expanded}><Icon name="right" size={14} /></span>
          </span>
          <span className="grow ellipsis">{room.name}</span>
        </button>
        {/* New workspace stays visible, as in Conductor. The menu button shows on hover or keyboard focus, or while its menu is open. */}
        <div className="row" style={{ position: 'absolute', right: 4, top: 3, gap: 2 }}>
          <button className="icon-btn more" style={{ width: 24, height: 24, opacity: menuOpen ? 1 : undefined }} aria-label={`${room.name} options`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu(`room:${room.id}`)}><Icon name="more" size={14} /></button>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`New workspace in ${room.name}`} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id })}><Icon name="plus" size={14} /></button>
        </div>
        {menuOpen && <RoomMenu room={room} anchorRef={anchor} />}
      </div>
      {expanded && (
        <>
          <NavItem sub route={{ name: 'team', roomId: room.id }} icon="team" label="Team" />
          <LeadItem roomId={room.id} />
          {live.map((w) => <WorkspaceItem key={w.id} ws={w} />)}
        </>
      )}
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

const SIDEBAR_DEFAULT = 236
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480
const SIDEBAR_KEY = 'kernel.sidebarWidth'
/** Letting go below this hides the sidebar, the way Conductor does. The saved width stays. */
const HIDE_BELOW = 160
/** The panel keeps at least this much of the window, however wide the sidebar was saved. */
const PANEL_MIN = 520

/** The widest the sidebar can be in this window. It never drops below the minimum, since narrow windows fold the sidebar anyway (D-080). */
const widthLimit = () => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - PANEL_MIN))
const readSaved = () => readWidth(SIDEBAR_KEY, SIDEBAR_MIN, SIDEBAR_MAX) ?? SIDEBAR_DEFAULT

export function Sidebar() {
  const rooms = useStore((s) => s.rooms.filter((r) => !r.hidden && !r.archived))
  const workspaces = useStore((s) => s.workspaces)
  const inbox = useStore((s) => inboxItems(s.notifications, s.approvals, s.rooms, allOverlaps(s.overlaps)).filter(needsYou).length)
  const route = useStore((s) => s.ui.route)
  const roomsMenu = useStore((s) => s.ui.menu === 'rooms')
  const plan = useStore((s) => s.account?.plan)
  const roomsAnchor = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState(readExpanded)
  // The saved width is read once. The window's room for it is state only so a resize that changes the limit re-renders; one that doesn't bails out.
  const nav = useRef<HTMLElement>(null)
  const [saved, setSaved] = useState(readSaved)
  const [limit, setLimit] = useState(widthLimit)
  useEffect(() => {
    const onResize = () => setLimit(widthLimit())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const width = Math.min(saved, limit)
  const openRoom = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : rooms[0]?.id
  const toggle = (id: string, expanded: boolean) => {
    const next = { ...chosen, [id]: !expanded }
    setChosen(next)
    try { localStorage.setItem(EXPANDED, JSON.stringify(next)) } catch { /* not remembered */ }
  }

  return (
    <nav ref={nav} aria-label="Sidebar" className="sidebar" style={{ width }}>
      {/* The traffic lights end near x 70. The toggle sits just right of them, where the header's Show sidebar sits when hidden. */}
      <div className="drag" style={{ height: 42, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 70 }}>
        <IconButton className="nodrag" icon="sidebar" size={15} label="Hide sidebar" data-tip-kbd="⌘B" onClick={() => actions.ui.setSidebar(false)} />
      </div>
      <div className="row" style={{ height: 36, paddingLeft: 4 }}>
        <AccountButton />
        <span className="grow" />
        <button className="icon-btn" aria-label="New workspace" data-tip-kbd="⌘⇧N" style={{ border: '1px solid var(--line-2)', background: 'var(--surface)' }} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: openRoom })}><Icon name="compose" /></button>
      </div>
      <div className="nav-list" style={{ marginTop: 10 }}>
        <button className="nav-item" onClick={() => actions.ui.openModal({ name: 'search' })}><Icon name="search" /><span className="grow">Search</span><span className="muted" style={{ fontSize: 11.5 }}>⌘K</span></button>
        <NavItem route={{ name: 'home' }} icon="home" label="Home" />
        <NavItem route={{ name: 'inbox' }} icon="inbox" label="Inbox" right={inbox ? <span className="muted" style={{ fontSize: 12 }}>{inbox}</span> : null} />
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
          return <RoomItem key={r.id} room={r} current={r.id === openRoom} expanded={expanded} onToggle={() => toggle(r.id, expanded)} />
        })}
      </div>
      <div style={{ flex: 1 }} />
      {/* The plan on the left, What's new and Settings on the right, as in Conductor. */}
      <div className="sb-foot">
        {plan && <PlanButton plan={plan} />}
        <span className="grow" />
        <IconButton icon="sparkle" label="What's new" onClick={() => actions.ui.openModal({ name: 'whatsNew' })} />
        <IconButton icon="sliders" label="Settings" data-tip-kbd="⌘," onClick={() => go({ name: 'settings', page: 'general' })} />
      </div>
      <ResizeHandle
        targetRef={nav} edge="right" label="Resize sidebar" width={width} min={SIDEBAR_MIN} limit={widthLimit} defaultWidth={SIDEBAR_DEFAULT}
        storageKey={SIDEBAR_KEY} hideBelow={HIDE_BELOW} onHide={() => actions.ui.setSidebar(false)} onCommit={(w) => setSaved(w ?? SIDEBAR_DEFAULT)}
      />
    </nav>
  )
}
