import { useState } from 'react'
import type { AgentDef, AgentStatus, Room, TeamTemplate } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadRoom, useStore } from '../../store'
import { ART, SEATS, WORD, limitBanner, lookFor, overflowShirt, pct, seating } from '../../floor/layout'
import floorUrl from '../../floor/floor.svg'

/** The office: art, people at their desks, a tag over each, and the room-level states drawn on top. */
export function Stage({ room, agents, status, selectedId, onSelect, onTogglePause }: {
  room: Room; agents: AgentDef[]; status: Record<string, AgentStatus>; selectedId?: string; onSelect: (id: string) => void; onTogglePause: () => void
}) {
  const { seated, overflow } = seating(agents, room)
  return (
    <div className="floor-stage">
      <img src={floorUrl} alt="Isometric office with desks, a task wall, a glass planning room, an open desk and a lounge" className="floor-art" />
      {seated.map((a, i) => <Person key={a.id} agent={a} seat={i} status={status[a.id] ?? 'idle'} />)}
      {seated.map((a, i) => <Tag key={a.id} agent={a} seat={i} status={status[a.id] ?? 'idle'} selected={selectedId === a.id} onSelect={() => onSelect(a.id)} />)}
      {room.paused && <PauseBanner room={room} onResume={onTogglePause} />}
      {agents.length === 0 && <Templates room={room} />}
      {overflow.length > 0 && <Overflow room={room} agents={overflow} status={status} />}
    </div>
  )
}

/** Someone at their desk. Working people bob, a person who needs you raises a hand, an offline desk is empty. */
function Person({ agent, seat, status }: { agent: AgentDef; seat: number; status: AgentStatus }) {
  const [x, y] = SEATS[seat]
  const look = lookFor(agent, seat)
  return (
    <div aria-hidden="true" className="floor-seat" style={{ ...pct(x - 30, y - 80), zIndex: Math.round(y / 10) }}>
      <svg viewBox="-30 -80 60 88" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        {status !== 'offline' && (
          <g className={status === 'working' ? 'floor-bob' : undefined}>
            <path d="M-8.9 -24.4 L-8.9 -43.4 Q-8.9 -53.4 2.1 -53.4 Q13.1 -53.4 13.1 -43.4 L13.1 -24.4 Z" fill={look.shirt} />
            <path d="M4.1 -52.4 Q13.1 -52.4 13.1 -43.4 L13.1 -24.4 L6.1 -24.4 Z" fill={ART.shade} fillOpacity={0.16} />
            <circle cx={2.1} cy={-61.4} r={8.4} fill={look.skin} />
            <circle cx={2.1} cy={-63} r={8.6} fill={look.hair} />
            {status === 'needs' && <g><line x1={11.1} y1={-46.4} x2={20.1} y2={-70.4} stroke={look.skin} strokeWidth={4} strokeLinecap="round" /><circle cx={20.1} cy={-72.4} r={3.5} fill={look.skin} /></g>}
          </g>
        )}
        <polygon points="-21.5,-24.0 -1.4,-12.4 -1.4,-29.2 -21.5,-40.8" fill={ART.deskLeft} />
        <polygon points="1.7,-14.2 -1.4,-12.4 -1.4,-29.2 1.7,-31.0" fill={ART.deskRight} />
        <polygon points="-18.4,-42.6 1.7,-31.0 -1.4,-29.2 -21.5,-40.8" fill={ART.deskTop} />
      </svg>
    </div>
  )
}

/** Name plus a status word. Needs you and blocked get the bright border; planning pulses a ring and walking holds one. No dots. */
function Tag({ agent, seat, status, selected, onSelect }: { agent: AgentDef; seat: number; status: AgentStatus; selected: boolean; onSelect: () => void }) {
  const [x, y] = SEATS[seat]
  return (
    <button type="button" className="floor-tag" aria-pressed={selected} aria-label={`${agent.name}, ${agent.role}, ${WORD[status]}`} onClick={onSelect}
      style={{ ...pct(x + 2.1, y - 76) }}>
      <span className="floor-tag-pill" data-status={status}>{agent.name}<span>{WORD[status]}</span></span>
    </button>
  )
}

/** Room paused by you, or by a limit. Each says what happens next and offers the way out. */
function PauseBanner({ room, onResume }: { room: Room; onResume: () => void }) {
  const usage = useStore((s) => s.usage)
  const [notified, setNotified] = useState(false)
  const [done, setDone] = useState(false)
  if (done) return null
  if (room.pausedBy !== 'limit') {
    return (
      <div role="status" className="floor-banner">
        <span>Room paused. Agents finish their current step, then wait.</span>
        <button type="button" className="floor-banner-btn" onClick={onResume}>Resume</button>
      </div>
    )
  }
  const limit = limitBanner(usage)
  const notify = () => call('usage.notifyOnReset', { type: limit.type }).then(() => setNotified(true)).catch((e: Error) => actions.ui.toast({ title: 'Could not set that up', sub: e.message }))
  return (
    <div role="status" className="floor-banner">
      <span>{notified ? 'You will get a notification when the limit resets.' : limit.text}</span>
      <button type="button" className="floor-banner-btn" onClick={notified ? () => setDone(true) : () => void notify()}>{notified ? 'Done' : 'Notify me'}</button>
    </div>
  )
}

const TEMPLATES: { name: string; sub: string; template: (from?: string) => TeamTemplate }[] = [
  { name: 'Starter team', sub: 'Lead, Frontend, Backend, QA and Reviewer', template: () => ({ kind: 'starter' }) },
  { name: 'Pair', sub: 'A Lead and one engineer', template: () => ({ kind: 'pair' }) },
  { name: 'From another room', sub: '', template: (from) => ({ kind: 'copy', fromRoomId: from ?? '' }) }
]

/** An empty room: pick a team to seat, or make one agent. */
function Templates({ room }: { room: Room }) {
  const other = useStore((s) => {
    const r = s.rooms.find((x) => x.id !== room.id && !x.archived && (s.agents[x.id] ?? []).some((a) => !a.retired))
    return r ? { id: r.id, name: r.name } : null
  })
  const [busy, setBusy] = useState(false)
  const seed = async (template: TeamTemplate) => {
    setBusy(true)
    try { await call('agents.seed', { roomId: room.id, template }); await loadRoom(room.id) } catch (e) {
      actions.ui.toast({ title: 'Could not seat that team', sub: (e as Error).message })
    } finally { setBusy(false) }
  }
  return (
    <section className="floor-empty" aria-label="No agents in this room yet">
      <h2>No agents in this room yet</h2>
      <p className="muted">Kernel reads agents from .claude/agents in this repo, and that folder is empty. Start from a team or make your own.</p>
      {TEMPLATES.map((t) => {
        const copy = t.name === 'From another room'
        return (
          <button key={t.name} type="button" className="floor-template" disabled={busy || (copy && !other)} onClick={() => void seed(t.template(other?.id))}>
            <span style={{ fontWeight: 500 }}>{t.name}</span>
            <span className="muted" style={{ fontSize: 12 }}>{copy ? (other ? `Copy agents from ${other.name}` : 'No other room has agents yet') : t.sub}</span>
          </button>
        )
      })}
      <button type="button" className="floor-link" onClick={() => actions.ui.openModal({ name: 'newAgent', roomId: room.id, step: 'describe' })}>Create one agent instead</button>
    </section>
  )
}

/** More agents than desks: the rest, still at work, listed with a way to add desks. */
function Overflow({ room, agents, status }: { room: Room; agents: AgentDef[]; status: Record<string, AgentStatus> }) {
  return (
    <section className="floor-overflow" aria-label="Agents without a desk">
      <span className="muted" style={{ fontSize: 12 }}>No desk yet, still working</span>
      {agents.map((a, i) => (
        <div key={a.id} className="row" style={{ gap: 8 }}>
          <span aria-hidden="true" className="overflow-dot" style={{ background: a.look?.shirt ?? overflowShirt(i), color: ART.onShirt }}>{a.name[0]}</span>
          <span style={{ fontWeight: 500 }}>{a.name}</span><span className="muted">{a.role}</span>
          <span className="grow" /><span className="muted" style={{ fontSize: 12 }}>{WORD[status[a.id] ?? 'idle']}</span>
        </div>
      ))}
      <button type="button" className="floor-link" onClick={() => go({ name: 'settings', page: 'room', roomId: room.id })}>Add desks in room settings</button>
    </section>
  )
}
