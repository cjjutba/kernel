import { useEffect, useMemo, useState } from 'react'
import type { AgentStatus, Overlap, Task } from '@shared/types'
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
import { HIRE_FRESH_MS, HIRE_KEEP_MS, deskSpot, moments, talkLegs } from './moments/moments'
import type { Spot } from './motion/walks'
import './floor.css'
import { RightPanelToggle, SidebarToggle } from '../../components/PanelToggles'

const NO_TASKS: Task[] = []
const NO_OVERLAPS: Overlap[] = []
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
  const overlaps = useStore((s) => s.overlaps[roomId] ?? NO_OVERLAPS)
  const forced = useStore((s) => s.ui.stage)
  const settings = useStore((s) => s.settings)
  const logs = useStore((s) => s.ui.rightPanel)
  const reduced = useReducedMotion()
  const [clicked, setClicked] = useState<string | null>(null)
  useEffect(() => { void loadRoom(roomId) }, [roomId])
  // The engine checks the room's workspaces after each turn and pushes changes; this reads what is already there.
  useEffect(() => { void call('rooms.overlaps', { roomId }).then((list) => actions.rooms.setOverlaps(roomId, list)).catch(() => undefined) }, [roomId])

  const live = useMemo(() => agents.filter((a) => !a.retired), [agents])
  const desks = room?.desks
  const seq = useMemo(
    () => sequence({ room: { id: roomId, desks }, agents: live, status, approvals: roomApprovals, activity, workspaces, tasks, forced }),
    [roomId, desks, live, status, roomApprovals, activity, workspaces, tasks, forced]
  )
  // Time only matters for a new hire: the hello and the walk from the door end on their own, so tick when each window closes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const joined = activity.find((e) => e.kind === 'agent.joined')?.ts
    if (joined === undefined) return
    const waits = [joined + HIRE_FRESH_MS, joined + HIRE_KEEP_MS].map((t) => t - Date.now()).filter((ms) => ms > 0)
    if (!waits.length) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...waits) + 50)
    return () => clearTimeout(timer)
  }, [activity, now])
  const mo = useMemo(
    () => moments({ agents: live, status, approvals: roomApprovals, activity, overlaps, stage: seq.stage, forced, room: { desks }, now }),
    [live, status, roomApprovals, activity, overlaps, seq.stage, forced, desks, now]
  )
  // The Lead walks the briefing sequence. Anyone who talked to someone walks to their desk while the talk is on, and a new hire
  // walks in from the door. Walking turned off, or reduced motion, makes every move a jump.
  const walks = useMemo<Walk[]>(() => {
    const out: Walk[] = []
    const spotOf = (id: string) => deskSpot(live, { desks }, id)
    const seated = seating(live, { desks }).seated
    seated.forEach((a, i) => {
      const desk = DESK_SPOTS[i]
      if (!desk) return
      const base = i === 0 && a.lead ? seq.legs : []
      const home: Spot = base.length ? base[base.length - 1].to : 'seat'
      let legs = [...base, ...talkLegs(mo.talks, a.id, spotOf, home)]
      let from: Spot | undefined
      if (mo.hire?.agentId === a.id) {
        // A fixture holds the arrival at the door; a real one walks to the desk.
        legs = [{ key: `join:${mo.hire.eventId}`, to: forced === 'hired' ? 'door' : 'seat' }]
        if (mo.hire.fresh && forced !== 'hired') from = 'door'
      }
      if (legs.length) out.push({ id: a.id, desk, legs, from })
    })
    return out
  }, [live, desks, seq.legs, mo, forced])
  const instant = reduced || !!settings?.appearance.reduceMotion || settings?.experimental.walking === false
  const { poses, jumping } = useWalks(walks, instant)
  const shown = useMemo(() => {
    const out = { ...status }
    for (const [id, p] of Object.entries(poses)) if (p.at !== 'seat') out[id] = 'walking'
    return out
  }, [status, poses])

  if (!room) return <div className="panel" />

  const approvals = roomApprovals.filter((a) => a.status === 'pending')
  const loud = live.some((a) => LOUD.includes(shown[a.id] ?? 'idle'))
  const sel = defaultSelected(live, shown, clicked ?? (loud ? null : seq.focus ?? mo.focus))
  const arriving = !!mo.hire && (poses[mo.hire.agentId]?.at ?? 'seat') !== 'seat'
  const words = arriving ? { [mo.hire!.agentId]: 'new' } : undefined
  const note = sel && arriving && mo.hire!.agentId === sel.id ? 'Joining the room' : sel && mo.chatting === sel.id ? 'Chatting with you' : undefined
  const working = live.filter((a) => shown[a.id] === 'working' || shown[a.id] === 'planning').length
  const needs = needsCount(live, shown, approvals)
  const togglePause = () => call('rooms.setPaused', { roomId, paused: !room.paused })
    .then((r) => setState((s) => ({ rooms: s.rooms.map((x) => (x.id === r.id ? r : x)) })))
    .catch((e: Error) => actions.ui.toast({ title: room.paused ? 'Could not resume the room' : 'Could not pause the room', sub: e.message }))

  return (
    <div className="panel">
      <header className="header" style={{ borderBottom: 0 }}>
        <SidebarToggle />
        <span className="ink2">{room.name}</span><Icon name="right" size={12} /><h1>Floor</h1>
        <span className="grow" /><span className="mono muted" style={{ fontSize: 12 }}>{room.repo ?? room.path} · {room.defaultBranch}</span>
        <RightPanelToggle name="logs" />
      </header>
      <div className="floor-bar">
        <button className="pill" aria-current="page">Floor</button>
        <button className="pill" onClick={() => go({ name: 'board', roomId })}>Board</button>
        <button className="pill" onClick={() => go({ name: 'team', roomId })}>Team</button>
        <span className="grow" />
        <span className="muted floor-count" style={{ fontSize: 12 }}>{working} working</span>
        {needs > 0 && <span className="floor-count" style={{ fontSize: 12, fontWeight: 500 }}>{needs} needs you</span>}
        <button className="btn floor-pause" aria-pressed={room.paused} onClick={() => void togglePause()}>
          <Icon name={room.paused ? 'play' : 'pause'} size={11} />{room.paused ? 'Resume room' : 'Pause room'}
        </button>
      </div>
      <div className="floor-body">
        <main className="floor-main">
          {sel && live.length > 0 && <AgentCard agent={sel} roomId={roomId} agents={live} status={shown[sel.id] ?? 'idle'} note={note} />}
          <div className="floor-room">
            <Stage room={room} agents={live} status={shown} words={words} poses={poses} say={mo.say ?? seq.say} instant={instant || jumping}
              selectedId={sel?.id} onSelect={setClicked} onTogglePause={() => void togglePause()} />
          </div>
          <Brief roomId={roomId} agents={live} />
        </main>
        {logs && <Logs roomId={roomId} agents={live} status={shown} approvals={approvals} review={seq.review} />}
      </div>
    </div>
  )
}
