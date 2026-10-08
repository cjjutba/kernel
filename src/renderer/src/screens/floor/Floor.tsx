import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { AgentDef, AgentStatus, Overlap, Task } from '@shared/types'
import { call } from '../../api'
import { Icon, useEscape } from '../../ui'
import { actions, go, loadRoom, setState, useStore } from '../../store'
import { SEATS, defaultSelected, deskless, needsCount, seating } from '../../floor/layout'
import { AgentCard } from './AgentCard'
import { Brief } from './Brief'
import { Logs } from './Logs'
import { Stage } from './Stage'
import { DESK_SPOTS, WAYPOINTS } from './motion/waypoints'
import { useReducedMotion, useWalks, type Pose, type Walk } from './motion/useWalks'
import { sequence } from './sequence'
import { HIRE_FRESH_MS, HIRE_KEEP_MS, deskSpot, facingOf, moments, newestJoin, talkLegs } from './moments/moments'
import type { Spot } from './motion/walks'
import './floor.css'
import { RightPanelToggle, SidebarToggle } from '../../components/PanelToggles'

const NO_TASKS: Task[] = []
const NO_OVERLAPS: Overlap[] = []
const BUSY: AgentStatus[] = ['working', 'planning']
const LOUD: AgentStatus[] = ['needs', 'blocked', 'offline']

/** The floor: the team seated in the office, the selected agent, the room logs and the brief box (Main.png and the Floor* states). */
export function Floor({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? [])
  const status = useStore((s) => s.status[roomId] ?? {})
  // Select the store's own lists and filter once per change to them, not on every store change.
  const allApprovals = useStore((s) => s.approvals)
  const allActivity = useStore((s) => s.activity)
  const allWorkspaces = useStore((s) => s.workspaces)
  const roomApprovals = useMemo(() => allApprovals.filter((a) => a.roomId === roomId), [allApprovals, roomId])
  const activity = useMemo(() => allActivity.filter((e) => e.roomId === roomId), [allActivity, roomId])
  const workspaces = useMemo(() => allWorkspaces.filter((w) => w.roomId === roomId), [allWorkspaces, roomId])
  const tasks = useStore((s) => s.tasks[roomId] ?? NO_TASKS)
  const overlaps = useStore((s) => s.overlaps[roomId] ?? NO_OVERLAPS)
  const forced = useStore((s) => s.ui.stage)
  const settings = useStore((s) => s.settings)
  const logs = useStore((s) => s.ui.rightPanel)
  const reduced = useReducedMotion()
  // Nobody is selected until someone is clicked or needs you. `closed` is the agent who needs you whose card was closed.
  const [clicked, setClicked] = useState<string | null>(null)
  const [closed, setClosed] = useState<string | null>(null)
  useEffect(() => { void loadRoom(roomId) }, [roomId])
  // The engine checks the room's workspaces after each turn and pushes changes; this reads what is already there.
  useEffect(() => { void call('rooms.overlaps', { roomId }).then((list) => actions.rooms.setOverlaps(roomId, list)).catch(() => undefined) }, [roomId])

  const live = useMemo(() => agents.filter((a) => !a.retired), [agents])
  // Desks follow the store's own status, not what the floor shows, so a walk doesn't move anyone's desk.
  const layout = useMemo(() => seating(live, { desks: room?.desks }, { workspaces, status, activity }), [live, room?.desks, workspaces, status, activity])
  const { seated } = layout
  // The order the desks resolve to. Handing it on as `desks` keeps the briefing, the moments and the walks on the same seats.
  const deskIds = useMemo(() => seated.map((a) => a.id), [seated])
  const desks = useMemo(() => (room?.desks ? room.desks : deskIds), [room?.desks, deskIds])
  const seq = useMemo(
    () => sequence({ room: { id: roomId, desks }, agents: live, status, approvals: roomApprovals, activity, workspaces, tasks, forced }),
    [roomId, desks, live, status, roomApprovals, activity, workspaces, tasks, forced]
  )
  // Time only matters for a new hire: the hello and the walk from the door end on their own, so tick when each window closes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const joined = newestJoin(activity, live)?.ts
    if (joined === undefined) return
    const waits = [joined + HIRE_FRESH_MS, joined + HIRE_KEEP_MS].map((t) => t - Date.now()).filter((ms) => ms > 0)
    if (!waits.length) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...waits) + 50)
    return () => clearTimeout(timer)
  }, [activity, live, now])
  const mo = useMemo(
    () => moments({ agents: live, status, approvals: roomApprovals, activity, overlaps, stage: seq.stage, forced, room: { desks }, now }),
    [live, status, roomApprovals, activity, overlaps, seq.stage, forced, desks, now]
  )
  // The Lead walks the briefing sequence. Anyone who talked to someone walks to their desk while the talk is on, and a new hire
  // walks in from the door. Walking turned off, or reduced motion, makes every move a jump.
  const walks = useMemo<Walk[]>(() => {
    const out: Walk[] = []
    const spotOf = (id: string) => deskSpot(live, { desks }, id)
    seated.forEach((a, i) => {
      const desk = DESK_SPOTS[i]
      if (!desk) return
      const base = i === 0 && a.lead ? seq.legs : []
      const home: Spot = base.length ? base[base.length - 1].to : 'seat'
      let legs = [...base, ...talkLegs(mo.talks, a.id, spotOf, home)]
      let from: Spot | undefined
      if (mo.hire?.agentId === a.id) {
        // A fixture holds the arrival at the door; a real one walks to the desk. Talks come after the arrival.
        legs = [{ key: `join:${mo.hire.eventId}`, to: forced === 'hired' ? 'door' : 'seat' }, ...legs]
        if (mo.hire.fresh && forced !== 'hired') from = 'door'
      }
      if (legs.length) out.push({ id: a.id, desk, legs, from })
    })
    return out
  }, [live, desks, seated, seq.legs, mo, forced])
  const instant = reduced || !!settings?.appearance.reduceMotion || settings?.experimental.walking === false
  const { poses, jumping } = useWalks(walks, instant)
  // Two people talking face each other: whoever stands up turns toward the other, seated or not.
  const faced = useMemo(() => {
    const spot = (id: string): readonly [number, number] | undefined => {
      const i = seated.findIndex((a) => a.id === id)
      if (i < 0) return undefined
      const at = poses[id]?.at ?? 'seat'
      return at === 'seat' ? SEATS[i] : WAYPOINTS[at]
    }
    const out: Record<string, Pose> = {}
    for (const [id, p] of Object.entries(poses)) {
      const here = spot(id)
      out[id] = { ...p, facing: p.at !== 'seat' && here ? facingOf(mo.talks, id, here, spot) : undefined }
    }
    return out
  }, [poses, mo.talks, seated])
  const shown = useMemo(() => {
    const out = { ...status }
    for (const [id, p] of Object.entries(poses)) if (p.at !== 'seat') out[id] = 'walking'
    return out
  }, [status, poses])

  // The popover: the clicked person, else the first who needs you, else nobody. A card you closed stays closed until someone else needs you.
  // Someone can be selected while they sit at a desk or are listed under No desk yet. Anyone else has nowhere to hold the card.
  const onStage = (a: AgentDef) => layout.seated.includes(a) || deskless(layout.overflow, shown).includes(a)
  const clickedAgent = clicked ? live.find((a) => a.id === clicked && onStage(a)) : undefined
  const waiting = defaultSelected(live, shown)
  const sel = clickedAgent ?? (waiting && waiting.id !== closed ? waiting : undefined)
  const close = () => { setClicked(null); setClosed(waiting?.id ?? null) }
  useEffect(() => { if (clicked && !clickedAgent) setClicked(null) }, [clicked, clickedAgent])
  // A closed card stays closed while that agent needs you, and opens again the next time they do.
  useEffect(() => { if (closed && !live.some((a) => a.id === closed && LOUD.includes(shown[a.id] ?? 'idle'))) setClosed(null) }, [closed, live, shown])
  useEscape(close, !!sel)

  if (!room) return <div className="panel" />

  const approvals = roomApprovals.filter((a) => a.status === 'pending')
  const arriving = !!mo.hire && (poses[mo.hire.agentId]?.at ?? 'seat') !== 'seat'
  const words = arriving ? { [mo.hire!.agentId]: 'new' } : undefined
  const note = sel && arriving && mo.hire!.agentId === sel.id ? 'Joining the room' : sel && mo.chatting === sel.id ? 'Chatting with you' : undefined
  const working = live.filter((a) => shown[a.id] === 'working' || shown[a.id] === 'planning').length
  // Pause is for a room that has work to stop, so it shows while someone works or plans. A paused room always offers Resume.
  const busy = live.some((a) => BUSY.includes(status[a.id]))
  const needs = needsCount(live, shown, approvals)
  const togglePause = () => call('rooms.setPaused', { roomId, paused: !room.paused })
    .then((r) => setState((s) => ({ rooms: s.rooms.map((x) => (x.id === r.id ? r : x)) })))
    .catch((e: Error) => actions.ui.toast({ title: room.paused ? 'Could not resume the room' : 'Could not pause the room', sub: e.message }))
  // A click on bare floor closes the popover. Tags, cards, banners and the no-desk list handle their own clicks.
  const onFloorClick = (e: MouseEvent<HTMLDivElement>) => { if (sel && !(e.target as HTMLElement).closest('button, section, [role="status"]')) close() }

  return (
    <div className="panel">
      <header className="header">
        <SidebarToggle />
        <h1 className="sr-only">Floor</h1>
        <button className="pill" aria-current="page">Floor</button>
        <button className="pill" onClick={() => go({ name: 'board', roomId })}>Board</button>
        <button className="pill" onClick={() => go({ name: 'team', roomId })}>Team</button>
        <span className="grow" />
        <span className="mono muted floor-repo">{room.repo ?? room.path} · {room.defaultBranch}</span>
        {working > 0 && <span className="muted floor-count">{working} working</span>}
        {needs > 0 && <span className="floor-count" style={{ fontWeight: 500 }}>{needs} needs you</span>}
        {(busy || room.paused) && (
          <button className="btn floor-pause" aria-pressed={room.paused} onClick={() => void togglePause()}>
            <Icon name={room.paused ? 'play' : 'pause'} size={11} />{room.paused ? 'Resume room' : 'Pause room'}
          </button>
        )}
        <RightPanelToggle name="logs" />
      </header>
      <div className="floor-body">
        <main className="floor-main">
          <div className="floor-room" onClick={onFloorClick}>
            <Stage room={room} agents={live} seats={layout} status={shown} words={words} poses={faced} say={mo.say ?? seq.say} instant={instant || jumping}
              selectedId={sel?.id} popover={sel && { agent: sel, note }} onSelect={(id) => (sel?.id === id ? close() : setClicked(id))} onTogglePause={() => void togglePause()} />
          </div>
          <Brief roomId={roomId} agents={live} />
        </main>
        {logs && <Logs roomId={roomId} agents={live} status={shown} approvals={approvals} review={seq.review} />}
      </div>
    </div>
  )
}
