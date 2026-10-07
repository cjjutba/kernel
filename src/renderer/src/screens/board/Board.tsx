import { useEffect, useMemo, useState } from 'react'
import type { Task, TaskColumn, Workspace } from '@shared/types'
import { go, loadRoom, useStore } from '../../store'
import { Button, Icon } from '../../ui'
import { COLUMNS, cardMeta, cardTag } from './model'
import { TaskDetail } from './TaskDetail'
import './board.css'

const NO_TASKS: Task[] = []

/** The column's glyph: dashed for Spec, an outline for Plan, filling up through Building, QA and Review, a check for Done. */
function ColumnIcon({ column }: { column: TaskColumn }) {
  const ring = <circle cx="7" cy="7" r="5.5" />
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" className="bd-icon" data-column={column}>
      {column === 'spec' && <circle cx="7" cy="7" r="5.5" strokeDasharray="2 2" />}
      {column === 'plan' && ring}
      {column === 'build' && <>{ring}<path d="M7 3.8a3.2 3.2 0 0 1 0 6.4Z" fill="currentColor" stroke="none" /></>}
      {column === 'qa' && <>{ring}<path d="M7 3.8a3.2 3.2 0 1 1-3.2 3.2H7Z" fill="currentColor" stroke="none" /></>}
      {column === 'review' && <>{ring}<circle cx="7" cy="7" r="3.2" fill="currentColor" stroke="none" /></>}
      {column === 'done' && <><circle cx="7" cy="7" r="6.2" fill="currentColor" stroke="none" /><path d="m4.4 7.1 1.8 1.8 3.5-3.6" stroke="var(--on-ink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>}
    </svg>
  )
}

/** Board.png: what Rowan planned, who has each task and where it is. A card opens its task in the drawer (TaskDetail.png). */
export function Board({ roomId, taskId }: { roomId: string; taskId?: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId])
  const tasks = useStore((s) => s.tasks[roomId] ?? NO_TASKS)
  const workspaces = useStore((s) => s.workspaces)
  const [filter, setFilter] = useState<string>('all')
  useEffect(() => { void loadRoom(roomId) }, [roomId])

  const team = useMemo(() => (agents ?? []).filter((a) => !a.retired), [agents])
  const wsOf = useMemo(() => {
    const byId = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]))
    return (t: Task) => (t.workspaceId ? byId.get(t.workspaceId) : undefined)
  }, [workspaces])
  const shown = tasks.filter((t) => filter === 'all' || t.agentId === filter)
  const milestone = tasks.find((t) => t.milestone)?.milestone

  if (!room) return <div className="panel" />
  const open = taskId ? tasks.find((t) => t.id === taskId) : undefined

  return (
    <div className="panel">
      <header className="header" style={{ borderBottom: 0 }}>
        <span className="ink2">{room.name}</span><Icon name="right" size={12} /><h1>Board</h1>
        <span className="grow" />
        <span className="mono muted" style={{ fontSize: 12 }}>{milestone ? `${milestone} · ` : ''}{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
      </header>
      <div className="bd-bar">
        <button type="button" className="pill" onClick={() => go({ name: 'floor', roomId })}>Floor</button>
        <button type="button" className="pill" aria-current="page">Board</button>
        <button type="button" className="pill" onClick={() => go({ name: 'team', roomId })}>Team</button>
        <span className="grow" />
        <div role="group" aria-label="Filter by agent" className="bd-filter">
          {[{ id: 'all', name: 'All' }, ...team].map((a) => (
            <button key={a.id} type="button" aria-pressed={filter === a.id} onClick={() => setFilter(a.id)}>{a.name}</button>
          ))}
        </div>
      </div>
      <div className="bd-body">
        {!tasks.length && (
          <div className="bd-empty">
            <p className="bd-empty-title">No tasks yet</p>
            <p className="muted">Brief Rowan and he fills the board with a plan you can approve.</p>
            <Button variant="primary" size="lg" onClick={() => go({ name: 'floor', roomId })}>Brief Rowan</Button>
          </div>
        )}
        <div className="bd-cols">
          {COLUMNS.map((col) => {
            const cards = shown.filter((t) => t.column === col.key)
            return (
              <section key={col.key} className="bd-col" aria-label={col.name}>
                <div className="bd-col-head">
                  <ColumnIcon column={col.key} />
                  <h2>{col.name}</h2>
                  <span className="muted bd-count">{cards.length}</span>
                  <span className="grow" />
                  {col.gate && <span className="bd-gate" title="You approve this step"><Icon name="lock" size={10} />You</span>}
                </div>
                {cards.map((t) => <Card key={t.id} task={t} ws={wsOf(t)} selected={t.id === taskId} />)}
              </section>
            )
          })}
        </div>
        {open && <TaskDetail roomId={roomId} task={open} />}
      </div>
    </div>
  )
}

function Card({ task, ws, selected }: { task: Task; ws?: Workspace; selected: boolean }) {
  const agent = useStore((s) => s.agents[task.roomId]?.find((a) => a.id === task.agentId))
  const tag = cardTag(task, ws)
  const meta = cardMeta(task, ws)
  return (
    <button type="button" className="bd-card" data-state={task.state} data-selected={selected ? 'true' : undefined} aria-label={`Open ${task.id}, ${task.title}`} onClick={() => go({ name: 'task', roomId: task.roomId, taskId: task.id })}>
      <span className="row bd-card-top">
        <span className="mono bd-id">{task.id}</span>
        <span className="grow" />
        {agent && <span className="bd-av" aria-hidden="true">{agent.name[0]}</span>}
      </span>
      <span className="bd-title">{task.title}</span>
      {(agent || tag) && (
        <span className="bd-chips">
          {agent && <span className="bd-chip">{agent.name}</span>}
          {tag && <span className="bd-chip" data-tag={task.state}>{tag}</span>}
        </span>
      )}
      {meta && <span className="mono bd-meta">{meta}</span>}
    </button>
  )
}
