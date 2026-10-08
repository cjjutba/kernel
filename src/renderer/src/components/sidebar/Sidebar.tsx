import { useRef, type ReactNode } from 'react'
import type { Room } from '@shared/types'
import { Icon } from '../../icons'
import { actions, go, useStore, type Route } from '../../store'
import { inboxItems, needsYou } from '../../screens/inbox/model'
import { roomLetter } from '../../screens/rooms/roomInfo'
import { resetDraft } from '../../screens/rooms/draft'
import { AccountButton } from './AccountMenu'
import { RoomMenu } from './RoomMenu'
import { RoomsMenu } from './RoomsMenu'

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

function NavItem({ route, icon, label, right, sub }: { route: Route; icon: string; label: ReactNode; right?: ReactNode; sub?: boolean }) {
  const current = useStore((s) => same(s.ui.route, route))
  return (
    <button className={`nav-item${sub ? ' nav-sub' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => go(route)}>
      <Icon name={icon} />
      <span className="grow ellipsis">{label}</span>
      {right}
    </button>
  )
}

/** A room in the sidebar. Open rooms list Floor, Board and their live workspaces. */
function RoomItem({ room, open }: { room: Room; open: boolean }) {
  const live = useStore((s) => s.workspaces.filter((w) => w.roomId === room.id && w.status !== 'archived' && w.name !== 'lead'))
  const menuOpen = useStore((s) => s.ui.menu === `room:${room.id}`)
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <div>
      <div ref={anchor} className="hv" style={{ position: 'relative' }}>
        <button className="nav-item" style={{ color: open ? 'var(--ink)' : undefined, paddingRight: 60 }} onClick={() => go({ name: 'floor', roomId: room.id })}>
          <span style={{ width: 18, height: 18, borderRadius: 5, border: '1px solid var(--line-3)', background: open ? 'var(--surface-3)' : 'var(--surface)', fontSize: 10, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{roomLetter(room.name)}</span>
          <span className="grow ellipsis">{room.name}</span>
        </button>
        <div className="more row" style={{ position: 'absolute', right: 4, top: 3, gap: 2, opacity: menuOpen ? 1 : undefined }}>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`${room.name} options`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu(`room:${room.id}`)}><Icon name="more" size={14} /></button>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`New workspace in ${room.name}`} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id })}><Icon name="plus" size={14} /></button>
        </div>
        {menuOpen && <RoomMenu room={room} anchorRef={anchor} />}
      </div>
      {open && (
        <>
          <NavItem sub route={{ name: 'floor', roomId: room.id }} icon="floor" label="Floor" />
          <NavItem sub route={{ name: 'board', roomId: room.id }} icon="board" label="Board" />
          {live.map((w) => (
            <NavItem
              key={w.id} sub route={{ name: 'workspace', workspaceId: w.id }} icon={w.prNumber ? 'pr' : 'branch'} label={w.name}
              right={w.stat && (w.stat.added || w.stat.removed)
                ? <span className="mono" style={{ fontSize: 11, display: 'inline-flex', gap: 6 }}><span className="add">+{w.stat.added}</span><span className="del">-{w.stat.removed}</span></span>
                : w.prNumber ? <span className="mono muted" style={{ fontSize: 11 }}>#{w.prNumber}</span> : null}
            />
          ))}
        </>
      )}
    </div>
  )
}

export function Sidebar() {
  const rooms = useStore((s) => s.rooms.filter((r) => !r.hidden && !r.archived))
  const workspaces = useStore((s) => s.workspaces)
  const inbox = useStore((s) => inboxItems(s.notifications, s.approvals, s.rooms).filter(needsYou).length)
  const route = useStore((s) => s.ui.route)
  const roomsMenu = useStore((s) => s.ui.menu === 'rooms')
  const plan = useStore((s) => s.account?.plan)
  const roomsAnchor = useRef<HTMLDivElement>(null)
  const openRoom = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : rooms[0]?.id

  return (
    <nav aria-label="Sidebar" className="sidebar">
      <div className="drag" style={{ height: 42, flexShrink: 0 }} />
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
      <div className="col" style={{ gap: 1, overflowY: 'auto', minHeight: 0 }}>
        {rooms.map((r) => <RoomItem key={r.id} room={r} open={r.id === openRoom} />)}
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
