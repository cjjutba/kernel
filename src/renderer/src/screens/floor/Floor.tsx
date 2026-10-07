import { useEffect, useMemo, useState } from 'react'
import type { AgentStatus, Task } from '@shared/types'
import { call } from '../../api'
import { Icon } from '../../ui'
import { actions, go, loadRoom, setState, useStore } from '../../store'
import { defaultSelected, needsCount, seating } from '../../floor/layout'
import { AgentCard } from './AgentCard'
import { Brief } from './Brief'
import { Logs } from './Logs'
import { Stage } from './Stage'
import { DESK_SPOTS } from './motion/waypoints'
import { useReducedMotion, useWalks, type Walk } from './motion/useWalks'
import { sequence } from './sequence'
import './floor.css'

const NO_TASKS: Task[] = []
const LOUD: AgentStatus[] = ['needs', 'blocked', 'offline']

/** The floor: the team seated in the office, the selected agent, the room logs and the brief box (Main.png and the Floor* states). */
export function Floor({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? [])
  const status = useStore((s) => s.status[roomId] ?? {})
  const roomApprovals = useStore((s) => s.approvals.filter((a) => a.roomId === roomId))
  const activity = useStore((s) => s.activity.filter((e) => e.roomId === roomId))
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId))
  const tasks = useStore((s) => s.tasks[roomId] ?? NO_TASKS)
  const forced = useStore((s) => s.ui.stage)
  const settings = useStore((s) => s.settings)
  const reduced = useReducedMotion()
  const [clicked, setClicked] = useState<string | null>(null)
  useEffect(() => { void loadRoom(roomId) }, [roomId])

  const live = useMemo(() => agents.filter((a) => !a.retired), [agents])
  const desks = room?.desks
  const seq = useMemo(
    () => sequence({ room: { id: roomId, desks }, agents: live, status, approvals: roomApprovals, activity, workspaces, tasks, forced }),
    [roomId, desks, live, status, roomApprovals, activity, workspaces, tasks, forced]
  )
  // Only the Lead walks in the briefing sequence. Walking turned off, or reduced motion, makes every move a jump.
  const walks = useMemo<Walk[]>(() => {
    const lead = seating(live, { desks }).seated[0]
    return lead?.lead ? [{ id: lead.id, desk: DESK_SPOTS[0], legs: seq.legs }] : []
  }, [live, desks, seq.legs])
  const instant = reduced || !!settings?.appearance.reduceMotion || settings?.experimental.walking === false
  const poses = useWalks(walks, instant)
  const shown = useMemo(() => {
    const out = { ...status }
    for (const [id, p] of Object.entries(poses)) if (p.at !== 'seat') out[id] = 'walking'
    return out
  }, [status, poses])

  if (!room) return <div className="panel" />

  const approvals = roomApprovals.filter((a) => a.status === 'pending')
  const loud = live.some((a) => LOUD.includes(shown[a.id] ?? 'idle'))
  const sel = defaultSelected(live, shown, clicked ?? (loud ? null : seq.focus))
  const working = live.filter((a) => shown[a.id] === 'working' || shown[a.id] === 'planning').length
  const needs = needsCount(live, shown, approvals)
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
          {sel && live.length > 0 && <AgentCard agent={sel} roomId={roomId} agents={live} status={shown[sel.id] ?? 'idle'} />}
          <Stage room={room} agents={live} status={shown} poses={poses} say={seq.say} instant={instant}
            selectedId={sel?.id} onSelect={setClicked} onTogglePause={() => void togglePause()} />
          <Brief roomId={roomId} agents={live} />
        </main>
        <Logs roomId={roomId} agents={live} status={shown} approvals={approvals} review={seq.review} />
      </div>
    </div>
  )
}
