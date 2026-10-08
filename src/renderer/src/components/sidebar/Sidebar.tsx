import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Room, Workspace } from '@shared/types'
import { call } from '../../api'
import { Icon } from '../../icons'
import { IconButton } from '../../ui'
import { actions, getState, go, useStore, type Route } from '../../store'
import { inboxItems, needsYou } from '../../screens/inbox/model'
import { isLeadWorkspace, leadOf, openLead } from '../../lead'
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

/** The room's Lead, under Board. It opens the Lead's chat, and works before the first brief too: `lead.open` makes the workspace. */
function LeadItem({ roomId }: { roomId: string }) {
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const current = useStore((s) => { const r = s.ui.route; return r.name === 'workspace' && s.workspaces.some((w) => w.id === r.workspaceId && isLeadWorkspace(w, roomId, lead?.id)) })
  if (!lead) return null
  return (
    <button className="nav-item nav-sub" aria-current={current ? 'page' : undefined} aria-label={`${lead.name}, Lead chat`} onClick={() => void openLead(roomId)}>
      <Icon name="chat" />
      <span className="grow ellipsis">{lead.name}</span>
      <span className="muted" style={{ fontSize: 12 }}>Lead</span>
    </button>
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

/** A workspace row: its state icon (needs you, working, then the PR), its name, and its diff totals. Hover swaps the totals for Archive. */
function WorkspaceItem({ ws }: { ws: Workspace }) {
  const needsYou = useStore((s) => s.approvals.some((a) => a.workspaceId === ws.id && a.status === 'pending'))
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const [busy, setBusy] = useState(false)
  const g = workspaceGlyph(ws, { needsYou, running })
  const glyph = (
    <span className="nav-glyph" data-tone={g.tone} role="img" aria-label={g.label} title={g.label}>
      {g.icon === 'spin' ? <span className="spin" /> : <Icon name={g.icon} />}
    </span>
  )
  const archive = () => { setBusy(true); void archiveFromSidebar(ws).finally(() => setBusy(false)) }
  return (
    <div className={`hv ws-row${busy ? ' busy' : ''}`}>
      <NavItem
        sub route={{ name: 'workspace', workspaceId: ws.id }} icon={glyph} label={ws.name}
        right={ws.stat && (ws.stat.added || ws.stat.removed)
          ? <span className="mono ws-right ws-stat">{ws.stat.added ? <span className="add">+{ws.stat.added}</span> : null}{ws.stat.removed ? <span className="del">-{ws.stat.removed}</span> : null}</span>
          : ws.prNumber ? <span className="mono muted ws-right" style={{ fontSize: 11 }}>#{ws.prNumber}</span> : null}
      />
      <div className="more ws-archive">
        <IconButton icon="archive" size={14} label={`Archive ${ws.name}`} style={{ width: 24, height: 24 }} disabled={busy} onClick={archive} />
      </div>
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

/** A room in the sidebar. Open rooms list Floor, Board, the Lead and their live workspaces. */
function RoomItem({ room, open }: { room: Room; open: boolean }) {
  const live = useStore((s) => s.workspaces.filter((w) => w.roomId === room.id && w.status !== 'archived' && w.name !== 'lead'))
  const menuOpen = useStore((s) => s.ui.menu === `room:${room.id}`)
  const anchor = useRef<HTMLDivElement>(null)
  useChatLists(open ? live.map((w) => w.id) : [])
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
          <LeadItem roomId={room.id} />
          {live.map((w) => <WorkspaceItem key={w.id} ws={w} />)}
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
