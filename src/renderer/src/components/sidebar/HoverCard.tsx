import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ActivityEvent, Workspace } from '@shared/types'
import { Icon } from '../../ui'
import { useStore } from '../../store'
import { leadOf, useLeadWaiting } from '../../lead'
import { agoShort } from '../../screens/rooms/roomInfo'
import { leadGlyph, workspaceGlyph, type WorkspaceGlyph } from './workspaceGlyph'

const OPEN_MS = 450
/** Right after a card closes the next one opens at once, so running the pointer down the list doesn't wait on every row. */
const WARM_MS = 300
const GAP = 14
const EDGE = 8
let warmUntil = 0

/**
 * Shows a row's card after a short hover, or at once on keyboard focus, like Conductor's workspace cards. Escape, scrolling
 * the sidebar or leaving the window puts it away, since it is placed once and doesn't follow the row. A click keeps it away
 * until the pointer leaves the row. A control marked `data-card-off` (the archive button) hides it while pointed at or
 * focused, so the control's own tooltip doesn't land on the card.
 */
export function useHoverCard() {
  const anchor = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const pressed = useRef(false)
  const id = useId()
  const [at, setAt] = useState<DOMRect | null>(null)
  const open = () => { timer.current = 0; const r = anchor.current?.getBoundingClientRect(); if (r) setAt(r) }
  const close = () => {
    window.clearTimeout(timer.current)
    timer.current = 0
    if (at) warmUntil = Date.now() + WARM_MS
    setAt(null)
  }
  const off = (t: EventTarget) => t instanceof Element && !!t.closest('[data-card-off]')
  const soon = () => {
    window.clearTimeout(timer.current)
    if (Date.now() < warmUntil) open()
    else timer.current = window.setTimeout(open, OPEN_MS)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (!at) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    // Only a scroll that moves the row counts. A chat scrolling as an agent writes must not close it.
    const scroll = (e: Event) => { if (e.target instanceof Node && anchor.current && e.target.contains(anchor.current)) close() }
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('scroll', scroll, true); window.removeEventListener('blur', close); window.removeEventListener('keydown', esc) }
  }, [at])
  const bind = {
    ref: anchor,
    onMouseOver: (e: MouseEvent<HTMLElement>) => {
      if (pressed.current) return
      if (off(e.target)) { if (at || timer.current) close() } else if (!at && !timer.current) soon()
    },
    onMouseLeave: () => { pressed.current = false; close() },
    onPointerDown: () => { pressed.current = true; close() },
    onFocus: (e: FocusEvent<HTMLElement>) => { if (off(e.target)) close(); else if (e.target.matches(':focus-visible')) open() },
    onBlur: close
  }
  return { at, id, bind }
}

/** The card itself, in a portal beside the row so the scrolling sidebar can't clip it. It reads as a tooltip and takes no pointer. */
function HoverCard({ at, id, children }: { at: DOMRect; id: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(at.top)
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0
    setTop(Math.max(EDGE, Math.min(at.top, window.innerHeight - EDGE - h)))
  }, [at])
  return createPortal(<div ref={box} id={id} role="tooltip" className="hover-card" style={{ left: at.right + GAP, top }}>{children}</div>, document.body)
}

/** The colors a card's status takes. Blue is work in progress, amber waits on you; green, red and purple keep their diff and GitHub meaning. */
type Accent = 'working' | 'needs' | 'add' | 'del' | 'merged' | 'muted'

function Status({ accent, spin, icon, label }: { accent: Accent; spin?: boolean; icon?: string; label: string }) {
  return (
    <span className="hc-status" data-accent={accent}>
      {spin ? <span className="spin" /> : icon ? <Icon name={icon} size={12} /> : null}
      {label}
    </span>
  )
}

function glyphAccent(g: WorkspaceGlyph): Accent {
  if (g.icon === 'spin') return 'working'
  if (g.icon === 'question' || g.icon === 'plan') return 'needs'
  return g.tone === 'ink' ? 'muted' : g.tone
}

/** The newest event that matches, whatever order the list arrived in. */
function newest(list: ActivityEvent[], match: (e: ActivityEvent) => boolean): ActivityEvent | undefined {
  let best: ActivityEvent | undefined
  for (const e of list) if (match(e) && (!best || e.ts > best.ts)) best = e
  return best
}

/** "Kai edited table.tsx". A line the agent said out loud reads as it was said. */
function lineOf(e: ActivityEvent, who: string | undefined): string {
  if (e.kind === 'agent.say') return e.text
  const actor = e.actor === 'you' ? 'You' : e.actor === 'kernel' ? 'Kernel' : who ?? 'The agent'
  return `${actor} ${e.text}${e.object ? ` ${e.object}` : ''}`
}

function Card({ eyebrow, status, title, line, meta, when }: { eyebrow: ReactNode; status: ReactNode; title: string; line: string; meta?: ReactNode; when?: string }) {
  return (
    <>
      <div className="hc-head"><span className="grow ellipsis">{eyebrow}</span>{status}</div>
      <div className="hc-title ellipsis">{title}</div>
      <div className="hc-line ellipsis">{line}</div>
      <div className="hc-foot">{meta}{when && <span className="hc-when">{when}</span>}</div>
    </>
  )
}

/** A workspace's card: room and agent, its state, what the agent did last, the branch with its diff totals or PR, and when. Every line comes from real events. */
export function WorkspaceCard({ ws, at, id }: { ws: Workspace; at: DOMRect; id: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === ws.roomId)?.name)
  const agent = useStore((s) => s.agents[ws.roomId]?.find((a) => a.id === ws.agentId))
  const approvals = useStore((s) => s.approvals)
  const waiting = useMemo(() => approvals.filter((a) => a.workspaceId === ws.id && a.status === 'pending'), [approvals, ws.id])
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const last = useStore((s) => newest(s.activity, (e) => e.workspaceId === ws.id))
  const g = workspaceGlyph(ws, { waiting, running })
  const stat = ws.stat && (ws.stat.added || ws.stat.removed) ? ws.stat : undefined
  const meta = (
    <>
      <span className="mono grow ellipsis">{ws.branch}</span>
      {stat?.added ? <span className="mono add">+{stat.added}</span> : null}
      {stat?.removed ? <span className="mono del">-{stat.removed}</span> : null}
      {ws.prNumber ? <span className={`mono ${ws.prState === 'merged' ? 'hc-merged' : 'ink2'}`}>#{ws.prNumber}</span> : null}
    </>
  )
  return (
    <HoverCard at={at} id={id}>
      <Card
        eyebrow={[room, agent?.name].filter(Boolean).join(' · ')}
        status={<Status accent={glyphAccent(g)} spin={g.icon === 'spin'} icon={g.icon === 'spin' ? undefined : g.icon} label={g.label} />}
        title={ws.title ?? ws.name}
        line={last ? lineOf(last, agent?.name) : 'No recent activity'}
        meta={meta} when={last ? agoShort(last.ts) : `Started ${agoShort(ws.createdAt)}`}
      />
    </HoverCard>
  )
}

/** The Lead's card: its status on the floor, what it did or said last, and how many workspaces the room has open. */
export function LeadCard({ roomId, at, id }: { roomId: string; at: DOMRect; id: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const status = useStore((s) => (lead ? s.status[roomId]?.[lead.id] : undefined) ?? 'idle')
  const waiting = useLeadWaiting(roomId)
  const last = useStore((s) => (lead ? newest(s.activity, (e) => e.roomId === roomId && e.agentId === lead.id) : undefined))
  const open = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && w.name !== 'lead').length)
  if (!lead || !room) return null
  const g = leadGlyph(status, waiting)
  return (
    <HoverCard at={at} id={id}>
      <Card
        eyebrow={`${room.name} · Lead`}
        // The icon shows only for what waits on you, so the other statuses keep the card as designed.
        status={<Status accent={glyphAccent(g)} spin={g.icon === 'spin'} icon={waiting.length ? g.icon : undefined} label={g.label} />}
        title={lead.name}
        line={last ? lineOf(last, lead.name) : 'No recent activity'}
        meta={<span className="grow ellipsis">{open ? `${open} open workspace${open === 1 ? '' : 's'}` : 'No open workspaces'}</span>}
        when={last && agoShort(last.ts)}
      />
    </HoverCard>
  )
}
