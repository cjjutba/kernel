import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ActivityEvent, Chat, Thread, Workspace } from '@shared/types'
import { call } from '../../api'
import { Icon } from '../../icons'
import { Button, Spinner } from '../../ui'
import { useStore } from '../../store'
import { leadOf, useLeadWaiting } from '../../lead'
import { useLocalMerge } from '../../screens/workspace/pr/useLocalMerge'
import { agoShort } from '../../screens/projects/projectInfo'
import { chatLine, chatSince } from './chatCard'
import { chatWaits } from './chatWaits'
import { chatGlyph, leadGlyph, workspaceGlyph, type WorkspaceGlyph } from './workspaceGlyph'

const OPEN_MS = 700
/** Right after a card closes the next one opens at once, so running the pointer down the list doesn't wait on every row. */
const WARM_MS = 300
/** Long enough to cross the gap between a row and its card, short enough that leaving the row feels like leaving. */
const LEAVE_MS = 140
const GAP = 10
const EDGE = 8
let warmUntil = 0
let current: { close: () => void } | null = null

/**
 * Shows a row's card after a deliberate hover, or at once on keyboard focus. Escape, scrolling
 * the sidebar or leaving the window puts it away, since it is placed once and doesn't follow the row. A click keeps it away
 * until the pointer leaves the row. The pointer can cross to the card, which stays while it is over it. A control marked
 * `data-card-off` (the archive button) hides it while pointed at or focused, so the control's own tooltip doesn't land on the card.
 */
export function useHoverCard<T extends HTMLElement = HTMLDivElement>() {
  const anchor = useRef<T>(null)
  const timer = useRef(0)
  const leaving = useRef(0)
  const pressed = useRef(false)
  const id = useId()
  const [at, setAt] = useState<DOMRect | null>(null)
  const shown = useRef(false)
  const self = useRef({ close: () => {} })
  const open = () => {
    timer.current = 0
    const r = anchor.current?.getBoundingClientRect()
    if (!r) return
    if (current && current !== self.current) current.close()
    current = self.current
    shown.current = true
    setAt(r)
  }
  const close = () => {
    window.clearTimeout(timer.current)
    window.clearTimeout(leaving.current)
    timer.current = 0
    if (shown.current) warmUntil = Date.now() + WARM_MS
    shown.current = false
    if (current === self.current) current = null
    setAt(null)
  }
  self.current.close = close
  const off = (t: EventTarget) => t instanceof Element && !!t.closest('[data-card-off]')
  const soon = () => {
    window.clearTimeout(timer.current)
    if (current || Date.now() < warmUntil) open()
    else timer.current = window.setTimeout(open, OPEN_MS)
  }
  useEffect(() => { const me = self.current; return () => { window.clearTimeout(timer.current); window.clearTimeout(leaving.current); if (current === me) current = null } }, [])
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
    onMouseOver: (e: MouseEvent<T>) => {
      window.clearTimeout(leaving.current)
      if (pressed.current) return
      if (off(e.target)) { if (at || timer.current) close() } else if (!at && !timer.current) soon()
    },
    onMouseLeave: () => {
      pressed.current = false
      window.clearTimeout(timer.current)
      timer.current = 0
      if (at) leaving.current = window.setTimeout(close, LEAVE_MS)
    },
    onPointerDown: () => { pressed.current = true; close() },
    onFocus: (e: FocusEvent<T>) => { if (off(e.target)) close(); else if (e.target.matches(':focus-visible')) open() },
    onBlur: close
  }
  // The card is portalled but React still bubbles its events to the row, whose press, focus and blur close the card and would unmount its buttons before a click lands.
  const keep = (e: SyntheticEvent) => e.stopPropagation()
  const hold: CardHold = { onMouseEnter: () => window.clearTimeout(leaving.current), onMouseLeave: close, onPointerDown: keep, onFocus: keep, onBlur: keep }
  return { at, id, bind, hold, close }
}

export interface CardHold {
  onMouseEnter: () => void
  onMouseLeave: () => void
  onPointerDown: (e: SyntheticEvent) => void
  onFocus: (e: SyntheticEvent) => void
  onBlur: (e: SyntheticEvent) => void
}

/** The card itself, in a portal beside the row so the scrolling sidebar can't clip it. */
function HoverCard({ at, id, hold, label, children }: { at: DOMRect; id: string; hold: CardHold; label: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(at.top)
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0
    setTop(Math.max(EDGE, Math.min(at.top, window.innerHeight - EDGE - h)))
  }, [at])
  return createPortal(<div ref={box} id={id} role="group" aria-label={label} className="hover-card" style={{ left: at.right, top, paddingLeft: GAP }} {...hold}><div className="hc-box">{children}</div></div>, document.body)
}

function State({ g, merged }: { g: WorkspaceGlyph; merged?: boolean }) {
  return (
    <span className="hc-state" data-tone={merged ? 'merged' : g.tone === 'needs' || g.tone === 'plan' ? 'needs' : undefined} aria-hidden="true">
      {g.icon === 'spin' ? <Spinner label={null} /> : <Icon name={g.icon} size={14} />}
    </span>
  )
}

/** The newest event that matches, whatever order the list arrived in. */
function newest(list: ActivityEvent[], match: (e: ActivityEvent) => boolean): ActivityEvent | undefined {
  let best: ActivityEvent | undefined
  for (const e of list) if (match(e) && (!best || e.ts > best.ts)) best = e
  return best
}

/** "Christian edited table.tsx". A line the agent said out loud reads as it was said. */
function lineOf(e: ActivityEvent, who: string | undefined): string {
  if (e.kind === 'agent.say') return e.text
  const actor = e.actor === 'you' ? 'You' : e.actor === 'kernel' ? 'Kernel' : who ?? 'The agent'
  return `${actor} ${e.text}${e.object ? ` ${e.object}` : ''}`
}

interface Pr { number: number; url?: string; merged: boolean }

function Card({ eyebrow, stat, state, title, line, wrap, onArchive, pr, when }: { eyebrow: string; stat?: { added: number; removed: number }; state: ReactNode; title: string; line: string; /** Lets the title and the line run to more rows, for a long chat name or a question that doesn't fit on one. */ wrap?: boolean; /** Set when the row has Archive. */ onArchive?: () => void; pr?: Pr; when?: string }) {
  return (
    <>
      <div className="hc-head">
        <span className="hc-eyebrow ellipsis">{eyebrow}</span>
        {stat?.added ? <span className="mono add">+{stat.added}</span> : null}
        {stat?.removed ? <span className="mono del">-{stat.removed}</span> : null}
        <span className="grow" />
        {state}
      </div>
      <div className={`hc-title ${wrap ? 'hc-wrap-title' : 'ellipsis'}`}>{title}</div>
      <div className={`hc-line ${wrap ? 'hc-wrap' : 'ellipsis'}`}>{line}</div>
      <div className="hc-foot">
        {onArchive && <Button size="xs" icon="archive" onClick={onArchive}>Archive</Button>}
        {pr && (pr.url
          ? <button type="button" className="hc-pr mono" data-merged={pr.merged ? '' : undefined} aria-label={`Open pull request ${pr.number}`} onClick={() => void call('system.openExternal', { url: pr.url! }).catch(() => undefined)}><Icon name="pr" size={12} />#{pr.number}<Icon name="ext" size={12} /></button>
          : <span className="hc-pr mono" data-merged={pr.merged ? '' : undefined}><Icon name="pr" size={12} />#{pr.number}</span>)}
        <span className="grow" />
        {when && <span className="hc-when">{when}</span>}
      </div>
    </>
  )
}

const sum = (list: Workspace[]) => list.reduce((t, w) => ({ added: t.added + (w.stat?.added ?? 0), removed: t.removed + (w.stat?.removed ?? 0) }), { added: 0, removed: 0 })

/** A workspace's card: its parent chat or project with the diff totals, its title, what the agent did last, and the PR and time. Every line comes from real events. */
export function WorkspaceCard({ ws, parent, at, id, hold, onArchive }: { ws: Workspace; /** The chat that started it, when the row sits under one. */ parent?: string; at: DOMRect; id: string; hold: CardHold; onArchive: () => void }) {
  const project = useStore((s) => s.projects.find((r) => r.id === ws.projectId)?.name)
  const agent = useStore((s) => s.agents[ws.projectId]?.find((a) => a.id === ws.agentId))
  const approvals = useStore((s) => s.approvals)
  const waiting = useMemo(() => approvals.filter((a) => a.workspaceId === ws.id && a.status === 'pending'), [approvals, ws.id])
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const last = useStore((s) => newest(s.activity, (e) => e.workspaceId === ws.id))
  const g = workspaceGlyph(ws, { waiting, running })
  const title = ws.title ?? ws.name
  return (
    <HoverCard at={at} id={id} hold={hold} label={title}>
      <Card
        eyebrow={parent ?? project ?? ''} stat={ws.stat} state={<State g={g} merged={ws.prState === 'merged'} />}
        title={title} line={last ? lineOf(last, agent?.name) : 'No recent activity'}
        onArchive={onArchive} pr={ws.prNumber ? { number: ws.prNumber, url: ws.prUrl, merged: ws.prState === 'merged' } : undefined}
        when={agoShort(last ? last.ts : ws.createdAt)}
      />
    </HoverCard>
  )
}

/** The Lead's card: its project, what it did or said last, and how long ago. */
export function LeadCard({ projectId, at, id, hold }: { projectId: string; at: DOMRect; id: string; hold: CardHold }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
  const lead = useStore((s) => leadOf(s.agents, projectId))
  const status = useStore((s) => (lead ? s.status[projectId]?.[lead.id] : undefined) ?? 'idle')
  const waiting = useLeadWaiting(projectId)
  const last = useStore((s) => (lead ? newest(s.activity, (e) => e.projectId === projectId && e.agentId === lead.id) : undefined))
  if (!lead || !project) return null
  const g = leadGlyph(status, waiting)
  return (
    <HoverCard at={at} id={id} hold={hold} label="New chat">
      <Card eyebrow={project.name} state={<State g={g} />} title="New chat" line={last ? lineOf(last, lead.name) : 'No recent activity'} when={last && agoShort(last.ts)} />
    </HoverCard>
  )
}

/**
 * A chat row's card: the project with the diff totals of the workspaces the chat started, the chat's title, and what waits on you, from the
 * pending approval of the tab or workspace that has waited longest. With nothing waiting it says so. Archive shows where the row has it.
 */
export function ChatCard({ projectId, thread, ws, tabs, owned, at, id, hold, onArchive }: { projectId: string; thread: Thread; ws?: Workspace; tabs: Chat[]; owned: Workspace[]; at: DOMRect; id: string; hold: CardHold; onArchive?: () => void }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId)?.name)
  const agents = useStore((s) => s.agents[projectId])
  const approvals = useStore((s) => s.approvals)
  const working = useStore((s) => tabs.filter((c) => s.running[c.id]).length)
  const lastItem = useStore((s) => tabs.reduce((t, c) => (s.items[c.id] ?? []).reduce((m, i) => Math.max(m, i.ts), t), 0))
  const waits = useMemo(() => chatWaits({ tabs, owned, approvals }), [tabs, owned, approvals])
  const local = useLocalMerge(ws)
  const pending = useStore((s) => (ws ? s.prPending[ws.id] : undefined))
  const g = chatGlyph({ ws, waiting: waits.map((w) => w.approval), running: working > 0, local, pending })
  const stat = sum(owned)
  return (
    <HoverCard at={at} id={id} hold={hold} label={thread.title}>
      <Card
        eyebrow={project ?? ''} stat={stat} state={<State g={g} />}
        title={thread.title} line={chatLine(waits, agents)} wrap onArchive={onArchive}
        when={agoShort(chatSince(waits, lastItem, thread.createdAt))}
      />
    </HoverCard>
  )
}
