import { useState } from 'react'
import type { Room } from '@shared/types'
import { actions, go, useStore } from '../../store'
import { Button, Icon, Pill } from '../../ui'
import { call } from '../../api'
import { openNewRoom } from './draft'
import { ago, initial, roomLetter, roomState, sourceOf, stateLabel } from './roomInfo'
import './rooms.css'
import { SidebarToggle } from '../../components/PanelToggles'

type Tab = 'all' | 'active' | 'archived'

function RoomRow({ room }: { room: Room }) {
  const agents = useStore((s) => s.agents[room.id] ?? [])
  const status = useStore((s) => s.status[room.id])
  const approvals = useStore((s) => s.approvals)
  const lastActive = useStore((s) => s.activity.find((e) => e.roomId === room.id)?.ts)
  const state = roomState(room, approvals, status)
  const open = () => go({ name: 'floor', roomId: room.id })
  const show = () => void call('rooms.update', { roomId: room.id, patch: { hidden: false } }).then((r) => actions.rooms.upsert(r))
  return (
    <div className="rm-row" onClick={open}>
      <span className="rm-name">
        <span className="rm-letter" aria-hidden="true">{roomLetter(room.name)}</span>
        <span className="col" style={{ minWidth: 0 }}>
          <button type="button" className="rm-link" onClick={(e) => { e.stopPropagation(); open() }}>{room.name}</button>
          <span className="rm-desc ellipsis">{room.desc}</span>
        </span>
        {room.hidden && <button type="button" className="rm-show" aria-label={`Show ${room.name} in the sidebar`} onClick={(e) => { e.stopPropagation(); show() }}>Show in sidebar</button>}
      </span>
      <span className="rm-source">
        <Icon name={room.kind === 'folder' || (!room.repo && room.kind !== 'scratch') ? 'folder' : room.kind === 'scratch' ? 'burst' : 'branch'} size={15} />
        <span className="mono ellipsis">{sourceOf(room)}</span>
      </span>
      <span className="row" style={{ gap: 8 }}>
        <span className="rm-team" aria-hidden="true">{agents.slice(0, 5).map((a) => <span key={a.id}>{initial(a)}</span>)}</span>
        <span className="rm-count">{agents.length} {agents.length === 1 ? 'agent' : 'agents'}</span>
      </span>
      <span>
        <span className="rm-status" data-state={state}>{stateLabel[state]}</span>
      </span>
      <span className="rm-updated">{ago(lastActive ?? room.createdAt)}</span>
    </div>
  )
}

/** Rooms.png: every room with its source, team and live status. */
export function Rooms() {
  const rooms = useStore((s) => s.rooms)
  const [tab, setTab] = useState<Tab>('all')
  const active = rooms.filter((r) => !r.archived)
  const shown = tab === 'all' ? rooms : tab === 'active' ? active : rooms.filter((r) => r.archived)
  const tabs: [Tab, string, number][] = [['all', 'All rooms', rooms.length], ['active', 'Active', active.length], ['archived', 'Archived', rooms.length - active.length]]
  return (
    <div className="panel">
      <header className="header" style={{ paddingRight: 12 }}>
        <SidebarToggle />
        <Icon name="rooms" />
        <h1>All rooms</h1>
        <span className="grow" />
        <Button variant="primary" icon="plus" onClick={() => openNewRoom()}>New room</Button>
      </header>
      <div className="rm-tabs" role="group" aria-label="Filter rooms">
        {tabs.map(([id, label, n]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="rm-n">{n}</span></Pill>)}
      </div>
      <div className="rm-table">
        <div className="rm-head"><span>Name</span><span>Source</span><span>Agents</span><span>Status</span><span style={{ textAlign: 'right' }}>Updated</span></div>
        {shown.map((r) => <RoomRow key={r.id} room={r} />)}
        {!shown.length && <p className="muted" style={{ padding: 24, margin: 0 }}>{tab === 'archived' ? 'No archived rooms.' : 'No rooms yet. Make one with New room.'}</p>}
      </div>
    </div>
  )
}
