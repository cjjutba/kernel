import type { Task } from '@shared/types'
import { actions, go, useStore } from '../../store'
import { Button, IconButton } from '../../ui'
import { useEscape } from '../../ui/hooks'
import { activityLine, clock, columnName, gateText, planSteps, prLine, taskActivity } from './model'

const NONE: never[] = []

/** TaskDetail.png: the drawer over the board. Spec, the plan it came from, what happened, and the way into its workspace. */
export function TaskDetail({ roomId, task }: { roomId: string; task: Task }) {
  const agents = useStore((s) => s.agents[roomId]) ?? NONE
  const tasks = useStore((s) => s.tasks[roomId]) ?? NONE
  const ws = useStore((s) => s.workspaces.find((w) => w.id === task.workspaceId))
  const approvals = useStore((s) => s.approvals)
  const activity = useStore((s) => s.activity)
  const close = () => go({ name: 'board', roomId })
  useEscape(close)

  const agent = agents.find((a) => a.id === (ws?.agentId ?? task.agentId))
  const steps = planSteps(task, tasks)
  const events = taskActivity(task, activity)
  const pr = prLine(ws)

  return (
    <aside aria-label={`Task ${task.id}`} className="bd-drawer">
      <div className="bd-drawer-head">
        <span className="mono muted" style={{ fontSize: 12 }}>{task.id}</span>
        <span className="ink2" style={{ fontSize: 12 }}>{columnName(task.column)}</span>
        <span className="grow" />
        <IconButton icon="close" label="Close task" onClick={close} />
      </div>
      <div className="bd-drawer-body">
        <h2 className="bd-drawer-title">{task.title}</h2>
        <dl className="bd-facts">
          <dt>Agent</dt><dd>{agent?.name ?? 'Not assigned'}</dd>
          <dt>Workspace</dt>
          <dd>{ws ? <button type="button" className="bd-link mono" onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>{ws.branch}</button> : <span className="ink2">Not started</span>}</dd>
          <dt>Pull request</dt><dd className="ink2">{pr ?? 'Not opened yet'}</dd>
          <dt>Gate</dt><dd className="ink2">{gateText(task, ws, approvals)}</dd>
        </dl>
        {task.spec && <section className="bd-section"><h3>Spec</h3><p className="bd-spec selectable">{task.spec}</p></section>}
        {steps.length > 0 && (
          <section className="bd-section" aria-label="Plan">
            <h3>Plan</h3>
            <ol className="bd-steps">
              {steps.map((s, i) => (
                <li key={s.id} data-current={s.current ? 'true' : undefined}>
                  <span className="mono muted bd-n">{i + 1}</span><span className="grow">{s.text}</span><span className="muted bd-step-state">{s.state}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="bd-section" aria-label="Activity">
          <h3>Activity</h3>
          {events.length ? (
            <ol className="bd-log">
              {events.map((e) => <li key={e.id}><span className="mono muted bd-time">{clock(e.ts)}</span><span className="ink2">{activityLine(e, agents)}</span></li>)}
            </ol>
          ) : <p className="muted" style={{ margin: 0 }}>Nothing yet.</p>}
        </section>
      </div>
      <div className="bd-drawer-foot">
        {ws && <Button onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>Open workspace</Button>}
        <span className="grow" />
        <Button variant="primary" onClick={() => actions.ui.toggleMenu('quickAsk')}>Ask Rowan about this</Button>
      </div>
    </aside>
  )
}
