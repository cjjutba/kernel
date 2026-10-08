import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent, AgentDef, AgentStatus, Approval, Workspace } from '@shared/types'
import { call } from '../../api'
import { Icon, useBusy } from '../../ui'
import { actions, go, useStore } from '../../store'
import { latestWarn } from '../../floor/layout'
import { earlierLabel, foldWhat, foldWho, logDays, type LogRow } from '../../floor/logs'
import { ApprovalCard } from '../workspace/cards/ApprovalCard'
import { PermCard, PlanCard, ReviewCard } from './Briefing'
import { FloorCard } from './FloorCard'
import type { Sequence } from './sequence'
import { OverlapCard, OverlapLinks, QuestionCard } from './moments/Cards'
import './logs.css'

/** Show everything outlasts a restart. localStorage may be missing or blocked, so every access is guarded. */
const EVERYTHING = 'kernel.logsEverything'
export function readEverything(): boolean {
  try { return localStorage.getItem(EVERYTHING) === '1' } catch { return false }
}
export function keepEverything(on: boolean) {
  try { if (on) localStorage.setItem(EVERYTHING, '1'); else localStorage.removeItem(EVERYTHING) } catch { /* not remembered */ }
}

/** The Logs header's switch between what the team did and the whole log. */
export function ShowEverything({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return <button type="button" className="btn log-all" aria-pressed={on} onClick={() => onChange(!on)}>Show everything</button>
}

const initials = (name?: string) => (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'Y'

const failed = (e: unknown) => actions.ui.toast({ title: 'That did not work', sub: (e as Error).message })

/** An agent a hook stopped: what stopped it, and Attach output, which asks the agent to attach it. */
function BlockedCard({ roomId, agent: a, ws, ev, saying }: { roomId: string; agent: AgentDef; ws?: Workspace; ev?: ActivityEvent; saying?: string }) {
  const [busy, run] = useBusy()
  const task = ev?.object ?? ws?.name
  const output = ev?.data?.output
  return (
    <FloorCard title={`${a.name} is blocked${task ? ` on ${task}` : ''}`}
      sub={typeof ev?.data?.detail === 'string' ? ev.data.detail : saying ?? 'A hook stopped the last step.'}
      code={Array.isArray(output) ? output.map(String) : typeof output === 'string' ? [output] : undefined}
      actions={[
        ...(ws ? [{ label: 'Open workspace', onClick: () => go({ name: 'workspace', workspaceId: ws.id }) }] : []),
        { label: 'Attach output', primary: true, busy: !!busy, busyLabel: 'Sending', onClick: () => void run('attach', () => call('rooms.brief', { roomId, agentId: a.id, text: `Attach the test output${task ? ` to ${task}` : ''} so the hook lets the task close.` }).catch(failed)) }
      ]} />
  )
}

/** An agent whose Claude Code session ended: a terminal in its worktree, or a new session in the same chat. */
function OfflineCard({ agent: a, ws, ev }: { agent: AgentDef; ws?: Workspace; ev?: ActivityEvent }) {
  const [busy, run] = useBusy<'terminal' | 'restart'>()
  return (
    <FloorCard title={`${a.name}’s session ended`}
      sub={typeof ev?.data?.detail === 'string' ? ev.data.detail : `Claude Code exited${ws ? ` in ${ws.name}` : ''}. The worktree and chat are saved.`}
      actions={ws ? [
        { label: 'Open terminal', busy: busy === 'terminal', busyLabel: 'Opening', onClick: () => void run('terminal', () => call('app.openTerminal', { cwd: ws.path }).catch(failed)) },
        { label: 'Restart session', primary: true, busy: busy === 'restart', busyLabel: 'Restarting', onClick: () => void run('restart', () => call('chats.list', { workspaceId: ws.id }).then((cs) => (cs[0] ? call('chats.restart', { chatId: cs[0].id }) : undefined)).catch(failed)) }
      ] : []} />
  )
}

/**
 * Things waiting on the user first, as cards in one pattern, then what the team did, newest first.
 * Lines said out loud (`agent.say`) show as the speech bubble on the floor, not here.
 * An agent's tool calls fold into one row (`logRows`), so a busy room stays readable.
 * Lifecycle events (sessions, turns, archives) stay out of the list until Show everything is on.
 */
export function Logs({ roomId, agents, status, approvals, review }: {
  roomId: string; agents: AgentDef[]; status: Record<string, AgentStatus>; approvals: Approval[]; review?: Sequence['review']
}) {
  const events = useStore((s) => s.activity.filter((e) => e.roomId === roomId && e.kind !== 'agent.say'))
  const [everything, setEverything] = useState(readEverything)
  const days = useMemo(() => { const d = logDays(events, everything); return d.length ? d : [{ label: 'Today', rows: [] }] }, [events, everything])
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived'))
  const saying = useStore((s) => s.saying)
  const overlaps = useStore((s) => s.overlaps[roomId])
  const account = useStore((s) => s.account)
  const blocked = agents.filter((a) => status[a.id] === 'blocked')
  const offline = agents.filter((a) => status[a.id] === 'offline')
  const wsOf = (a: AgentDef) => workspaces.find((w) => w.agentId === a.id)

  return (
    <aside aria-label="Logs" className="floor-logs">
      <div className="floor-logs-head">
        <h2>Logs</h2>
        <ShowEverything on={everything} onChange={(on) => { keepEverything(on); setEverything(on) }} />
      </div>
      <div className="floor-logs-body">
        {approvals.map((a) => (a.kind === 'plan' || a.toolName === 'ExitPlanMode' ? <PlanCard key={a.id} approval={a} agents={agents} />
          : a.kind === 'question' ? <QuestionCard key={a.id} approval={a} agents={agents} />
          : a.kind === 'tool' && !a.agentFile ? <PermCard key={a.id} approval={a} agents={agents} />
          : <ApprovalCard key={a.id} approval={a} />))}
        {(overlaps ?? []).filter((o) => !o.resolved).map((o) => <OverlapCard key={o.id} overlap={o} roomId={roomId} agents={agents} workspaces={workspaces} />)}
        {review && <ReviewCard roomId={roomId} title={review.title} sub={review.sub} />}
        {blocked.map((a) => <BlockedCard key={`blocked-${a.id}`} roomId={roomId} agent={a} ws={wsOf(a)} ev={latestWarn(events, a.id, ['agent.status', 'tool.failed', 'note'])} saying={saying[a.id]} />)}
        {offline.map((a) => <OfflineCard key={`offline-${a.id}`} agent={a} ws={wsOf(a)} ev={latestWarn(events, a.id, ['session.end', 'note'])} />)}
        {days.map((d) => (
          <div key={d.label} className="log-group">
            <p className="log-day">{d.label}</p>
            <ol className="log-list">
              {d.rows.map((r) => <Line key={r.id} row={r} agents={agents} workspaces={workspaces} you={initials(account?.name)} />)}
            </ol>
          </div>
        ))}
      </div>
    </aside>
  )
}

const whoOf = (e: ActivityEvent, agents: AgentDef[]) =>
  (e.actor ?? 'agent') === 'you' ? 'You' : e.actor === 'kernel' ? 'Kernel' : agents.find((a) => a.id === e.agentId)?.name ?? 'An agent'

function Line({ row, agents, workspaces, you }: { row: LogRow; agents: AgentDef[]; workspaces: Workspace[]; you: string }) {
  const [open, setOpen] = useState(false)
  const e = row.event
  const actor = e.actor ?? 'agent'
  const who = whoOf(e, agents)
  const list = `log-steps-${row.id}`
  const fold = row.fold
  const all = fold ? [e, ...row.earlier] : []
  return (
    <li className="log-line">
      <span aria-hidden="true" className="log-av" data-you={actor === 'you' ? 'true' : undefined}>{actor === 'you' ? you : who[0]}</span>
      <div className="col" style={{ gap: 4, minWidth: 0 }}>
        {fold
          ? <p className="log-text"><span className="log-who">{foldWho(all.map((x) => whoOf(x, agents)))}</span><span>{foldWhat(fold, all.length)}</span></p>
          : <p className="log-text"><span className="log-who">{who}</span><What e={e} /></p>}
        {e.kind === 'overlap' && Array.isArray(e.data?.workspaceIds) && <OverlapLinks workspaceIds={e.data.workspaceIds.map(String)} workspaces={workspaces} />}
        {e.quote && <Quote text={e.quote} />}
      </div>
      <Time ts={e.ts} />
      {row.earlier.length > 0 && (
        <div className="log-run">
          <button type="button" className="log-fold" aria-expanded={open} aria-controls={list} onClick={() => setOpen(!open)}>
            <span className="log-chev" data-open={open}><Icon name="right" size={11} /></span>
            {fold ? `Show all ${all.length}` : earlierLabel(row.earlier.length, e.kind === 'tool.failed' && row.earlier.every((s) => s.kind === 'tool.failed'))}
          </button>
          {open && (
            <ol id={list} className="log-steps">
              {(fold ? all : row.earlier).map((s) => (
                <li key={s.id} className="log-step">
                  <p className="log-text">{fold && <span className="log-who">{whoOf(s, agents)}</span>}<What e={s} /></p>
                  <Time ts={s.ts} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}

/** The verb and its object. The object stays on one line, cut to fit, with the whole of it on hover. */
function What({ e }: { e: ActivityEvent }) {
  return (
    <>
      <span>{e.text}</span>
      {e.object && <span className="log-obj" title={e.object} data-warn={e.warn ? 'true' : undefined}>{e.object}</span>}
    </>
  )
}

function Time({ ts }: { ts: number }) {
  return <time className="mono log-time" dateTime={new Date(ts).toISOString()}>{new Date(ts).toTimeString().slice(0, 5)}</time>
}

/** A brief or message, cut to three lines. A longer one opens in place when clicked. */
function Quote({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1)
  }, [text, open])
  const body = <span ref={ref} className="log-quote-text" data-open={open}>{text}</span>
  if (!long) return <p className="log-quote">{body}</p>
  return <button type="button" className="log-quote" aria-expanded={open} onClick={() => setOpen(!open)}>{body}</button>
}
