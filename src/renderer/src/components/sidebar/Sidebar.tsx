import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Room, Workspace } from '@shared/types'
import { call } from '../../api'
import { Icon } from '../../icons'
import { IconButton } from '../../ui'
import { actions, getState, go, useStore, type Route } from '../../store'
import { inboxItems, needsYou } from '../../screens/inbox/model'
import { roomLetter } from '../../screens/rooms/roomInfo'
import { resetDraft } from '../../screens/rooms/draft'
import { AccountButton } from './AccountMenu'
import { RoomMenu } from './RoomMenu'
import { RoomsMenu } from './RoomsMenu'
import { workspaceGlyph } from './workspaceGlyph'
import './sidebar.css'

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

function NavItem({ route, icon, label, right, sub }: { route: Route; icon: string | ReactNode; label: ReactNode; right?: ReactNode; sub?: boolean }) {
  const current = useStore((s) => same(s.ui.route, route))
  return (
    <button className={`nav-item${sub ? ' nav-sub' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => go(route)}>
      {typeof icon === 'string' ? <Icon name={icon} /> : icon}
      <span className="grow ellipsis">{label}</span>
      {right}
    </button>
  )
}

/** A workspace row: its state icon (needs you, working, then the PR), its name, and its diff totals. */
function WorkspaceItem({ ws }: { ws: Workspace }) {
  const needsYou = useStore((s) => s.approvals.some((a) => a.workspaceId === ws.id && a.status === 'pending'))
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const g = workspaceGlyph(ws, { needsYou, running })
  const glyph = (
    <span className="nav-glyph" data-tone={g.tone} role="img" aria-label={g.label} title={g.label}>
      {g.icon === 'spin' ? <span className="spin" /> : <Icon name={g.icon} />}
    </span>
  )
  return (
    <NavItem
      sub route={{ name: 'workspace', workspaceId: ws.id }} icon={glyph} label={ws.name}
      right={ws.stat && (ws.stat.added || ws.stat.removed)
        ? <span className="mono" style={{ fontSize: 11, display: 'inline-flex', gap: 6 }}>{ws.stat.added ? <span className="add">+{ws.stat.added}</span> : null}{ws.stat.removed ? <span className="del">-{ws.stat.removed}</span> : null}</span>
        : ws.prNumber ? <span className="mono muted" style={{ fontSize: 11 }}>#{ws.prNumber}</span> : null}
    />
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
 * A room in the sidebar. Expanded, it lists Floor, Board and its live workspaces. Pressing the row folds or unfolds it,
 * as in Conductor, and hovering it swaps the room's letter for a chevron and shows the menu button.
 */
function RoomItem({ room, current, expanded, onToggle }: { room: Room; current: boolean; expanded: boolean; onToggle: () => void }) {
  const live = useStore((s) => s.workspaces.filter((w) => w.roomId === room.id && w.status !== 'archived' && w.name !== 'lead'))
  const menuOpen = useStore((s) => s.ui.menu === `room:${room.id}`)
  const anchor = useRef<HTMLDivElement>(null)
  useChatLists(expanded ? live.map((w) => w.id) : [])
  return (
    <div>
      <div ref={anchor} className="hv room-row" style={{ position: 'relative' }}>
        <button className="nav-item" style={{ color: current ? 'var(--ink)' : undefined, paddingRight: 60 }} aria-expanded={expanded} onClick={onToggle}>
          <span className="room-mark">
            <span className="room-letter" data-current={current || undefined}>{roomLetter(room.name)}</span>
            <span className="room-chev" data-open={expanded}><Icon name="right" size={14} /></span>
          </span>
          <span className="grow ellipsis">{room.name}</span>
        </button>
        {/* New workspace stays visible, as in Conductor. The menu button shows on hover or focus, or while its menu is open. */}
        <div className="row" style={{ position: 'absolute', right: 4, top: 3, gap: 2 }}>
          <button className="icon-btn more" style={{ width: 24, height: 24, opacity: menuOpen ? 1 : undefined }} aria-label={`${room.name} options`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu(`room:${room.id}`)}><Icon name="more" size={14} /></button>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`New workspace in ${room.name}`} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id })}><Icon name="plus" size={14} /></button>
        </div>
        {menuOpen && <RoomMenu room={room} anchorRef={anchor} />}
      </div>
      {expanded && (
        <>
          <NavItem sub route={{ name: 'floor', roomId: room.id }} icon="floor" label="Floor" />
          <NavItem sub route={{ name: 'board', roomId: room.id }} icon="board" label="Board" />
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

export function Sidebar() {
  const rooms = useStore((s) => s.rooms.filter((r) => !r.hidden && !r.archived))
  const workspaces = useStore((s) => s.workspaces)
  const inbox = useStore((s) => inboxItems(s.notifications, s.approvals, s.rooms).filter(needsYou).length)
  const route = useStore((s) => s.ui.route)
  const roomsMenu = useStore((s) => s.ui.menu === 'rooms')
  const plan = useStore((s) => s.account?.plan)
  const roomsAnchor = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState(readExpanded)
  const openRoom = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : rooms[0]?.id
  const toggle = (id: string, expanded: boolean) => {
    const next = { ...chosen, [id]: !expanded }
    setChosen(next)
    try { localStorage.setItem(EXPANDED, JSON.stringify(next)) } catch { /* not remembered */ }
  }

  return (
    <nav aria-label="Sidebar" className="sidebar">
      {/* The traffic lights end near x 70. The toggle sits just right of them, where the header's Show sidebar sits when hidden. */}
      <div className="drag" style={{ height: 42, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 70 }}>
        <IconButton className="nodrag" icon="sidebar" size={15} label="Hide sidebar" onClick={() => actions.ui.setSidebar(false)} />
      </div>
      <div className="row" style={{ height: 36, paddingLeft: 4 }}>
        <AccountButton />
        <span className="grow" />
        <button className="icon-btn" aria-label="New workspace" style={{ border: '1px solid var(--line-2)', background: 'var(--surface)' }} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: openRoom })}><Icon name="compose" /></button>
      </div>
      <div className="col" style={{ gap: 1, marginTop: 10 }}>
        <button className="nav-item" onClick={() => actions.ui.openModal({ name: 'search' })}><Icon name="search" /><span className="grow">Search</span><span className="muted" style={{ fontSize: 11.5 }}>⌘K</span></button>
        <NavItem route={{ name: 'home' }} icon="home" label="Home" />
        <NavItem route={{ name: 'inbox' }} icon="inbox" label="Inbox" right={inbox ? <span className="muted" style={{ fontSize: 12 }}>{inbox}</span> : null} />
        <NavItem route={{ name: 'rooms' }} icon="rooms" label="All rooms" />
        <NavItem route={{ name: 'history' }} icon="history" label="History" />
      </div>
      <div ref={roomsAnchor} className="section-label hv" style={{ position: 'relative' }}>
        <span>Your rooms</span>
        <button className="icon-btn more" style={{ width: 24, height: 24, opacity: roomsMenu ? 1 : undefined }} aria-label="Rooms menu" aria-haspopup="menu" aria-expanded={roomsMenu} onClick={() => actions.ui.toggleMenu('rooms')}><Icon name="more" size={14} /></button>
        {roomsMenu && <RoomsMenu anchorRef={roomsAnchor} />}
      </div>
      {/* A room's menu is placed once, so scrolling the list closes it rather than leave it behind. */}
      <div className="col" style={{ gap: 1, overflowY: 'auto', minHeight: 0 }} onScroll={() => { if (getState().ui.menu?.startsWith('room:')) actions.ui.closeMenu() }}>
        {rooms.map((r) => {
          const expanded = chosen[r.id] ?? r.id === openRoom
          return <RoomItem key={r.id} room={r} current={r.id === openRoom} expanded={expanded} onToggle={() => toggle(r.id, expanded)} />
        })}
      </div>
      <div className="section-label" style={{ marginTop: 20 }}><span>Try</span></div>
      <div className="col" style={{ gap: 1 }}>
        <button className="nav-item" onClick={() => { resetDraft({ source: 'repo' }); actions.ui.openModal({ name: 'connectRepo' }) }}><Icon name="branch" /><span className="grow">Connect a repo</span></button>
        <button className="nav-item" onClick={() => { resetDraft({ source: 'folder', baseBranch: '' }); actions.ui.openModal({ name: 'openFolder' }) }}><Icon name="folder" /><span className="grow">Open a folder</span></button>
        <button className="nav-item" onClick={() => actions.ui.openModal({ name: 'checkHooks' })}><Icon name="plug" /><span className="grow">Check hooks</span></button>
      </div>
      <div style={{ flex: 1 }} />
      {plan && (
        <div className="row" style={{ height: 40, flexShrink: 0, padding: '0 2px' }}>
          <span style={{ height: 24, padding: '0 9px', borderRadius: 999, border: '1px solid var(--line-2)', fontSize: 12, color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center' }}>{plan}</span>
        </div>
      )}
    </nav>
  )
}
