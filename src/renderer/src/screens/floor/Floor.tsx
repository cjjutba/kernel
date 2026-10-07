import { useEffect, useState } from 'react'
import { call } from '../../api'
import { Icon } from '../../ui'
import { actions, go, loadRoom, setState, useStore } from '../../store'
import { defaultSelected, needsCount } from '../../floor/layout'
import { AgentCard } from './AgentCard'
import { Brief } from './Brief'
import { Logs } from './Logs'
import { Stage } from './Stage'
import './floor.css'

/** The floor: the team seated in the office, the selected agent, the room logs and the brief box (Main.png and the Floor* states). */
export function Floor({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? [])
  const status = useStore((s) => s.status[roomId] ?? {})
  const approvals = useStore((s) => s.approvals.filter((a) => a.roomId === roomId && a.status === 'pending'))
  const [clicked, setClicked] = useState<string | null>(null)
  useEffect(() => { void loadRoom(roomId) }, [roomId])
  if (!room) return <div className="panel" />

  const live = agents.filter((a) => !a.retired)
  const sel = defaultSelected(live, status, clicked)
  const working = live.filter((a) => status[a.id] === 'working' || status[a.id] === 'planning').length
  const needs = needsCount(live, status, approvals)
  const togglePause = () => call('rooms.setPaused', { roomId, paused: !room.paused })
    .then((r) => setState((s) => ({ rooms: s.rooms.map((x) => (x.id === r.id ? r : x)) })))
    .catch((e: Error) => actions.ui.toast({ title: room.paused ? 'Could not resume the room' : 'Could not pause the room', sub: e.message }))

  return (
    <div className="panel">
      <header className="header" style={{ borderBottom: 0 }}>
        <span className="ink2">{room.name}</span><Icon name="right" size={12} /><h1>Floor</h1>
        <span className="grow" /><span className="mono muted" style={{ fontSize: 12 }}>{room.repo ?? room.path} · {room.defaultBranch}</span>
      </header>
      <div className="floor-bar">
        <button className="pill" aria-current="page">Floor</button>
        <button className="pill" onClick={() => go({ name: 'board', roomId })}>Board</button>
        <button className="pill" onClick={() => go({ name: 'team', roomId })}>Team</button>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>{working} working</span>
        {needs > 0 && <span style={{ fontSize: 12, fontWeight: 500 }}>{needs} needs you</span>}
        <button className="btn floor-pause" aria-pressed={room.paused} onClick={() => void togglePause()}>
          <Icon name={room.paused ? 'play' : 'pause'} size={11} />{room.paused ? 'Resume room' : 'Pause room'}
        </button>
      </div>
      <div className="floor-body">
        <main className="floor-main">
          {sel && live.length > 0 && <AgentCard agent={sel} roomId={roomId} agents={live} />}
          <Stage room={room} agents={live} status={status} selectedId={sel?.id} onSelect={setClicked} onTogglePause={() => void togglePause()} />
          <Brief roomId={roomId} agents={live} />
        </main>
        <Logs roomId={roomId} agents={live} status={status} approvals={approvals} />
      </div>
    </div>
  )
}
