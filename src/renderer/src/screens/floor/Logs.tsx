import type { ActivityEvent, AgentDef, AgentStatus, Approval, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { dayLabel, latestWarn } from '../../floor/layout'
import { ApprovalCard } from '../workspace/cards/ApprovalCard'
import { PermCard, PlanCard, ReviewCard } from './Briefing'
import { FloorCard } from './FloorCard'
import type { Sequence } from './sequence'
import { OverlapCard, OverlapLinks, QuestionCard } from './moments/Cards'

const initials = (name?: string) => (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'Y'

/**
 * Things waiting on CJ first, as cards in one pattern, then what the team did, newest first.
 * Lines said out loud (`agent.say`) show as the speech bubble on the floor, not here.
 */
export function Logs({ roomId, agents, status, approvals, review }: {
  roomId: string; agents: AgentDef[]; status: Record<string, AgentStatus>; approvals: Approval[]; review?: Sequence['review']
}) {
  const events = useStore((s) => s.activity.filter((e) => e.roomId === roomId && e.kind !== 'agent.say').slice(0, 40))
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived'))
  const saying = useStore((s) => s.saying)
  const overlaps = useStore((s) => s.overlaps[roomId])
  const account = useStore((s) => s.account)
  const blocked = agents.filter((a) => status[a.id] === 'blocked')
  const offline = agents.filter((a) => status[a.id] === 'offline')
  const wsOf = (a: AgentDef) => workspaces.find((w) => w.agentId === a.id)
  const failed = (e: unknown) => actions.ui.toast({ title: 'That did not work', sub: (e as Error).message })

  const groups: { label: string; events: ActivityEvent[] }[] = []
  for (const e of events) {
    const label = dayLabel(e.ts)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.events.push(e)
    else groups.push({ label, events: [e] })
  }

  if (!groups.length) groups.push({ label: 'Today', events: [] })

  return (
    <aside aria-label="Logs" className="floor-logs">
      <div className="floor-logs-head"><h2>Logs</h2></div>
      <div className="floor-logs-body">
        {approvals.map((a) => (a.kind === 'plan' || a.toolName === 'ExitPlanMode' ? <PlanCard key={a.id} approval={a} agents={agents} />
          : a.kind === 'question' ? <QuestionCard key={a.id} approval={a} agents={agents} />
          : a.kind === 'tool' && !a.agentFile ? <PermCard key={a.id} approval={a} agents={agents} />
          : <ApprovalCard key={a.id} approval={a} />))}
        {(overlaps ?? []).filter((o) => !o.resolved).map((o) => <OverlapCard key={o.id} overlap={o} roomId={roomId} agents={agents} workspaces={workspaces} />)}
        {review && <ReviewCard roomId={roomId} title={review.title} sub={review.sub} />}
        {blocked.map((a) => {
          const ev = latestWarn(events, a.id, ['agent.status', 'tool.failed', 'note'])
          const ws = wsOf(a)
          const task = ev?.object ?? ws?.name
          const output = ev?.data?.output
          return (
            <FloorCard key={`blocked-${a.id}`} title={`${a.name} is blocked${task ? ` on ${task}` : ''}`}
              sub={typeof ev?.data?.detail === 'string' ? ev.data.detail : saying[a.id] ?? 'A hook stopped the last step.'}
              code={Array.isArray(output) ? output.map(String) : typeof output === 'string' ? [output] : undefined}
              actions={[
                ...(ws ? [{ label: 'Open workspace', onClick: () => go({ name: 'workspace', workspaceId: ws.id }) }] : []),
                { label: 'Attach output', primary: true, onClick: () => void call('rooms.brief', { roomId, agentId: a.id, text: `Attach the test output${task ? ` to ${task}` : ''} so the hook lets the task close.` }).catch(failed) }
              ]} />
          )
        })}
        {offline.map((a) => {
          const ev = latestWarn(events, a.id, ['session.end', 'note'])
          const ws = wsOf(a)
          return (
            <FloorCard key={`offline-${a.id}`} title={`${a.name}’s session ended`}
              sub={typeof ev?.data?.detail === 'string' ? ev.data.detail : `Claude Code exited${ws ? ` in ${ws.name}` : ''}. The worktree and chat are saved.`}
              actions={ws ? [
                { label: 'Open terminal', onClick: () => void call('app.openTerminal', { cwd: ws.path }).catch(failed) },
                { label: 'Restart session', primary: true, onClick: () => void call('chats.list', { workspaceId: ws.id }).then((cs) => (cs[0] ? call('chats.restart', { chatId: cs[0].id }) : undefined)).catch(failed) }
              ] : []} />
          )
        })}
        {groups.map((g) => (
          <div key={g.label} className="log-group">
            <p className="log-day">{g.label}</p>
            <ol className="log-list">
              {g.events.map((e) => <Line key={e.id} e={e} agents={agents} workspaces={workspaces} you={initials(account?.name)} />)}
            </ol>
          </div>
        ))}
      </div>
    </aside>
  )
}

function Line({ e, agents, workspaces, you }: { e: ActivityEvent; agents: AgentDef[]; workspaces: Workspace[]; you: string }) {
  const actor = e.actor ?? 'agent'
  const who = actor === 'you' ? 'You' : actor === 'kernel' ? 'Kernel' : agents.find((a) => a.id === e.agentId)?.name ?? 'An agent'
  return (
    <li className="log-line">
      <span aria-hidden="true" className="log-av" data-you={actor === 'you' ? 'true' : undefined}>{actor === 'you' ? you : who[0]}</span>
      <div className="col" style={{ gap: 4, minWidth: 0 }}>
        <p className="log-text"><span className="log-who">{who}</span><span>{e.text}</span>{e.object && <span className="log-obj" data-warn={e.warn ? 'true' : undefined}>{e.object}</span>}</p>
        {e.kind === 'overlap' && Array.isArray(e.data?.workspaceIds) && <OverlapLinks workspaceIds={e.data.workspaceIds.map(String)} workspaces={workspaces} />}
        {e.quote && <p className="log-quote">{e.quote}</p>}
      </div>
      <time className="mono log-time" dateTime={new Date(e.ts).toISOString()}>{new Date(e.ts).toTimeString().slice(0, 5)}</time>
    </li>
  )
}
