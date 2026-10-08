import { useState, type ReactNode } from 'react'
import type { AgentDef, AgentLook, AgentStatus, Room, TeamTemplate } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadRoom, useStore } from '../../store'
import { Button, useBusy } from '../../ui'
import { ART, SEATS, WORD, deskless, limitBanner, lookFor, overflowShirt, pct, type Seating } from '../../floor/layout'
import floorDark from '../../floor/floor.svg'
import floorLight from '../../floor/floor-light.svg'
import { AgentCard } from './AgentCard'
import { Bubble } from './Briefing'
import { Walker, anchor } from './motion/Walker'
import type { Pose } from './motion/useWalks'
import type { Say } from './moments/moments'
import './moments/moments.css'

const SEATED: Pose = { at: 'seat', moving: false }

/** The selected person's card, open beside their seat, or beside the no-desk card when they have no desk. */
export interface Popover { agent: AgentDef; note?: string }

/**
 * The office: art, people at their desks or walking (KERNEL-23), a tag over each, a speech bubble, and the room-level states drawn on top.
 * `status` is what the floor shows, so someone away from their desk already reads "walking". `seats` is who sits where, worked out
 * from the store's own status, so the desks don't shuffle while someone walks. `popover` is the selected person's card.
 */
export function Stage({ room, agents, seats, status, words, poses, say, instant, selectedId, popover, onSelect, onTogglePause }: {
  room: Room; agents: AgentDef[]; seats: Seating; status: Record<string, AgentStatus>; /** A word to show instead of the status, for a new hire. */ words?: Record<string, string>; poses: Record<string, Pose>; say?: Say; instant: boolean
  selectedId?: string; popover?: Popover; onSelect: (id: string) => void; onTogglePause: () => void
}) {
  const { seated, overflow } = seats
  const theme = useStore((s) => s.ui.theme)
  const pose = (id: string) => poses[id] ?? SEATED
  const speaker = say ? seated.findIndex((a) => a.id === say.agentId) : -1
  const order = (a: AgentDef) => Math.max(0, agents.indexOf(a))
  const waiting = deskless(overflow, status)
  const seatOf = popover ? seated.findIndex((a) => a.id === popover.agent.id) : -1
  const card = popover && <AgentCard agent={popover.agent} roomId={room.id} agents={agents} status={status[popover.agent.id] ?? 'idle'} note={popover.note} />
  return (
    <div className="floor-stage" data-instant={instant ? 'true' : undefined}>
      <img src={theme === 'light' ? floorLight : floorDark} alt="Isometric office with desks, a task wall, a glass planning room, an open desk and a lounge" className="floor-art" />
      {seated.map((a, i) => <Person key={a.id} agent={a} look={lookFor(a, order(a))} seat={i} status={status[a.id] ?? 'idle'} present={pose(a.id).at === 'seat'} />)}
      {seated.map((a, i) => { const p = pose(a.id); return p.at === 'seat' ? null : <Walker key={a.id} at={p.at} moving={p.moving} look={lookFor(a, order(a))} facing={p.facing} /> })}
      {/* Keyed by seat as well, so a person who changes desks appears at the new one at once instead of gliding across the floor. */}
      {seated.map((a, i) => <Tag key={`${a.id}:${i}`} agent={a} at={anchor(pose(a.id).at, SEATS[i])} status={status[a.id] ?? 'idle'} word={words?.[a.id]} selected={selectedId === a.id} onSelect={() => onSelect(a.id)} />)}
      {seatOf >= 0 && <div className="agent-pop" data-side={SEATS[seatOf][0] >= 400 ? 'left' : 'right'} style={pct(SEATS[seatOf][0] + (SEATS[seatOf][0] >= 400 ? -26 : 26), SEATS[seatOf][1] + 14)}>{card}</div>}
      {say && speaker >= 0 && <Bubble text={say.text} at={anchor(pose(say.agentId).at, SEATS[speaker])} link={say.link && { label: say.link.label, onClick: () => go({ name: 'workspace', workspaceId: say.link!.workspaceId }) }} />}
      {room.paused && <PauseBanner room={room} onResume={onTogglePause} />}
      {agents.length === 0 && <Templates room={room} />}
      {waiting.length > 0 && <Overflow room={room} agents={waiting} status={status} selectedId={selectedId} onSelect={onSelect} card={popover && waiting.some((a) => a.id === popover.agent.id) ? card : undefined} />}
    </div>
  )
}

/** Someone at their desk. Working people bob, a person who needs you raises a hand, an offline desk or one whose owner is up walking is empty. */
function Person({ look, seat, status, present }: { agent: AgentDef; look: AgentLook; seat: number; status: AgentStatus; present: boolean }) {
  const [x, y] = SEATS[seat]
  return (
    <div aria-hidden="true" className="floor-seat" style={{ ...pct(x - 30, y - 80), zIndex: Math.round(y / 10) }}>
      <svg viewBox="-30 -80 60 88" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        {status !== 'offline' && present && (
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

/** The name, plus a status word unless they are idle. Needs you and blocked get the bright border; planning pulses a ring and walking holds one. No dots. */
function Tag({ agent, at, status, word: shown, selected, onSelect }: { agent: AgentDef; at: [number, number]; status: AgentStatus; word?: string; selected: boolean; onSelect: () => void }) {
  const word = shown ?? WORD[status]
  return (
    <button type="button" className="floor-tag" aria-pressed={selected} aria-label={`${agent.name}, ${agent.role}, ${word}`} onClick={onSelect}
      style={pct(at[0], at[1])}>
      <span className="floor-tag-pill" data-status={status}>{agent.name}{(shown || status !== 'idle') && <span>{word}</span>}</span>
    </button>
  )
}

/** Room paused by you, or by a limit. Each says what happens next and offers the way out. */
function PauseBanner({ room, onResume }: { room: Room; onResume: () => void }) {
  const usage = useStore((s) => s.usage)
  const [notified, setNotified] = useState(false)
  // Done only closes the notification line; the room is still paused, so the banner stays up.
  const [done, setDone] = useState(false)
  const [busy, run] = useBusy()
  if (room.pausedBy !== 'limit') {
    return (
      <div role="status" className="floor-banner">
        <span>Room paused. Agents finish their current step, then wait.</span>
        <button type="button" className="floor-banner-btn" onClick={onResume}>Resume</button>
      </div>
    )
  }
  const limit = limitBanner(usage)
  const notify = () => run('notify', () => call('usage.notifyOnReset', { type: limit.type }).then(() => setNotified(true)).catch((e: Error) => actions.ui.toast({ title: 'Could not set that up', sub: e.message })))
  return (
    <div role="status" className="floor-banner">
      <span>{notified && !done ? 'You will get a notification when the limit resets.' : limit.text}</span>
      {!done && <Button variant="primary" className="floor-banner-btn" busy={!!busy} busyLabel="Setting up" onClick={notified ? () => setDone(true) : () => void notify()}>{notified ? 'Done' : 'Notify me'}</Button>}
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
  const preferred = useStore((x) => x.settings?.team.defaultTemplate ?? 'starter')
  const [busy, run] = useBusy()
  const seed = (name: string, template: TeamTemplate) => run(name, async () => {
    try { await call('agents.seed', { roomId: room.id, template }); await loadRoom(room.id) } catch (e) {
      actions.ui.toast({ title: 'Could not seat that team', sub: (e as Error).message })
    }
  })
  return (
    <section className="floor-empty" aria-label="No agents in this room yet">
      <h2>No agents in this room yet</h2>
      <p className="muted">Kernel reads agents from .claude/agents in this repo, and that folder is empty. Start from a team or make your own.</p>
      {[...TEMPLATES].sort((a, b) => Number(b.template().kind === preferred) - Number(a.template().kind === preferred)).map((t) => {
        const copy = t.name === 'From another room'
        return (
          <button key={t.name} type="button" className="floor-template" disabled={busy !== null || (copy && !other)} aria-busy={busy === t.name || undefined} onClick={() => void seed(t.name, t.template(other?.id))}>
            <span style={{ fontWeight: 500 }}>{t.name}</span>
            {busy === t.name
              ? <span className="muted floor-template-busy"><span className="spin" aria-hidden="true" />Seating the team</span>
              : <span className="muted" style={{ fontSize: 12 }}>{copy ? (other ? `Copy agents from ${other.name}` : 'No other room has agents yet') : t.sub}</span>}
          </button>
        )
      })}
      <button type="button" className="floor-link" onClick={() => actions.ui.openModal({ name: 'newAgent', roomId: room.id, step: 'describe' })}>Create one agent instead</button>
    </section>
  )
}

/** More agents than desks: the ones without a desk who are doing something, listed with a way to add desks. */
function Overflow({ room, agents, status, selectedId, onSelect, card }: { room: Room; agents: AgentDef[]; status: Record<string, AgentStatus>; selectedId?: string; onSelect: (id: string) => void; card?: ReactNode }) {
  return (
    <section className="floor-overflow" aria-label="Agents without a desk">
      {card && <div className="agent-pop" data-side="above">{card}</div>}
      <span className="muted" style={{ fontSize: 12 }}>No desk yet</span>
      {agents.map((a, i) => (
        <button key={a.id} type="button" className="overflow-row" aria-pressed={selectedId === a.id} aria-label={`${a.name}, ${a.role}, ${WORD[status[a.id] ?? 'idle']}`} onClick={() => onSelect(a.id)}>
          <span aria-hidden="true" className="overflow-dot" style={{ background: a.look?.shirt ?? overflowShirt(i), color: ART.onShirt }}>{a.name[0]}</span>
          <span style={{ fontWeight: 500 }}>{a.name}</span><span className="muted">{a.role}</span>
          <span className="grow" /><span className="muted" style={{ fontSize: 12 }}>{WORD[status[a.id] ?? 'idle']}</span>
        </button>
      ))}
      <button type="button" className="floor-link" onClick={() => go({ name: 'settings', page: 'room', roomId: room.id })}>Add desks in room settings</button>
    </section>
  )
}
