import type { ActivityEvent, AgentDef, AgentStatus, Approval, Room, Task, Workspace } from '@shared/types'
import { seating } from '../../floor/layout'
import { DESK_SPOTS } from './motion/waypoints'
import type { Leg } from './motion/walks'

// The briefing sequence (KERNEL-23): the user briefs the Lead, the Lead plans at the task wall, the user approves, the Lead walks
// to each desk as it hands out work, the team works, and review comes back. Every stage is read from the store.

/** The stages, named like the `%%STAGE%%` values of the canvas floor templates. */
export const STAGES = ['idle', 'sent', 'planning', 'plan', 'handoff', 'working', 'needs', 'review'] as const
export type Stage = (typeof STAGES)[number]

export interface SequenceInput {
  room: Pick<Room, 'id' | 'desks'>
  /** Agents in the room, retired ones left out. */
  agents: AgentDef[]
  status: Record<string, AgentStatus>
  approvals: Approval[]
  activity: ActivityEvent[]
  workspaces: Workspace[]
  tasks?: Task[]
  /** `ui.stage`: a fixture forcing one stage. */
  forced?: string
}

export interface Sequence {
  stage: Stage
  /** The Lead's walk, in order. The last leg is where the Lead ends up. */
  legs: Leg[]
  /** Who the agent card follows when nobody was clicked and nobody needs the user: the agent being handed work. */
  focus?: string
  /** A line said out loud on the floor (the Lead's `say` tool), shown as a speech bubble. */
  say?: { id: string; agentId: string; text: string }
  /** PRs ready to merge, for the review card. */
  review?: { title: string; sub: string }
}

const busy = (s?: AgentStatus) => s === 'working' || s === 'planning' || s === 'walking'
/** Events that don't mean the Lead has started on a brief. */
const QUIET: ActivityEvent['kind'][] = ['agent.say', 'agent.status', 'brief']
const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const isStage = (s: string | undefined): s is Stage => !!s && (STAGES as readonly string[]).includes(s)

/**
 * Which stage the room is in, and what the floor draws for it.
 * - plan: the Lead's plan approval (`request_plan_approval`) is pending
 * - handoff: the newest plan was approved and the Lead is still running, handing out work with `create_workspace`
 * - sent, then planning: a brief (`rooms.brief`) the Lead is on; planning once the Lead acts on it in plan mode.
 *   A plan sent back with changes reopens the brief, so the Lead plans at the wall again
 * - needs: an approval is pending or an agent needs the user
 * - review: a PR in the room is ready to merge
 * - working: anyone is busy
 * A fixture's `ui.stage` replaces the stage; the legs, focus and bubble still come from its events.
 */
export function sequence(i: SequenceInput): Sequence {
  const roomId = i.room.id
  const lead = i.agents.find((a) => a.lead)
  const events = i.activity.filter((e) => e.roomId === roomId).sort((a, b) => b.ts - a.ts)
  const approvals = i.approvals.filter((a) => a.roomId === roomId)
  const leadWs = new Set(i.workspaces.filter((w) => w.roomId === roomId && w.agentId === lead?.id).map((w) => w.id))
  const byLead = (e: ActivityEvent) => !!lead && (e.agentId === lead.id || (!!e.workspaceId && leadWs.has(e.workspaceId)))
  const agentOf = (v: unknown) => (typeof v === 'string' ? i.agents.find((a) => a.id === v || a.name.toLowerCase() === v.toLowerCase())?.id : undefined)

  const brief = lead ? events.find((e) => e.kind === 'brief' && (!e.agentId || e.agentId === lead.id)) : undefined
  const plans = lead ? approvals.filter((a) => a.kind === 'plan' && a.agentId === lead.id).sort((a, b) => b.createdAt - a.createdAt) : []
  const lastPlan = plans[0]
  const briefAt = brief?.ts ?? -Infinity
  const planAt = lastPlan?.createdAt ?? -Infinity
  const leadStatus = lead ? i.status[lead.id] : undefined
  // Kernel's teammate updates (KERNEL-72) start the Lead again after it handed off. That turn isn't another hand-off.
  const updatedAt = events.find((e) => e.kind === 'note' && e.data?.leadUpdate === true)?.ts ?? -Infinity

  // Each `create_workspace` the Lead ran for the current plan, oldest first.
  const handoffs = events
    .filter((e) => e.kind === 'workspace.created' && byLead(e) && agentOf(e.data?.assignee) && e.ts >= Math.max(planAt, briefAt))
    .reverse()
  const ready = i.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && w.prState === 'ready')

  // A plan sent back (changes requested) or left to expire keeps the brief open: the Lead plans again. The planning
  // round then starts at that plan, so the wall walk, the "started" check and the bubble count from there.
  const revising = !!lastPlan && lastPlan.status !== 'allowed' && lastPlan.status !== 'pending'
  const reopened = revising && planAt >= briefAt
  const openAt = reopened ? planAt : briefAt
  const round = reopened ? `plan:${lastPlan!.id}` : brief?.id ?? 'stage'

  let stage: Stage
  const onBrief = !!brief && busy(leadStatus) && (planAt < briefAt || revising)
  if (plans.some((a) => a.status === 'pending')) stage = 'plan'
  else if (lastPlan?.status === 'allowed' && busy(leadStatus) && planAt >= briefAt && updatedAt < planAt) stage = 'handoff'
  else if (onBrief) {
    const started = events.some((e) => e !== brief && e.ts >= openAt && byLead(e) && !QUIET.includes(e.kind))
    stage = started && leadStatus === 'planning' ? 'planning' : 'sent'
  } else if (approvals.some((a) => a.status === 'pending') || i.agents.some((a) => i.status[a.id] === 'needs')) stage = 'needs'
  else if (ready.length) stage = 'review'
  else if (i.agents.some((a) => busy(i.status[a.id]))) stage = 'working'
  else stage = 'idle'
  if (isStage(i.forced)) stage = i.forced

  // Where the Lead walks: the task wall while planning, each assignee's desk in turn while handing off, otherwise the desk.
  const { seated } = seating(i.agents, i.room)
  const deskOf = (agentId?: string) => {
    const seat = seated.findIndex((a) => a.id === agentId)
    return seat >= 0 ? DESK_SPOTS[seat] : undefined
  }
  let legs: Leg[] = [{ key: 'seat', to: 'seat' }]
  if (stage === 'planning') legs = [{ key: `wall:${round}`, to: 'wall' }]
  if (stage === 'handoff') {
    const stops = handoffs.flatMap((e) => { const to = deskOf(agentOf(e.data?.assignee)); return to ? [{ key: e.id, to }] : [] })
    if (stops.length) legs = stops
  }

  const assignees = handoffs.map((e) => agentOf(e.data?.assignee))
  const focus = stage === 'handoff' ? assignees[assignees.length - 1] : stage === 'working' || stage === 'needs' ? assignees[0] : undefined

  // The bubble shows the newest line said since the stage began, and only in the stages that talk.
  const since = stage === 'sent' || stage === 'planning' ? openAt : stage === 'handoff' ? planAt : stage === 'review' ? Math.max(briefAt, planAt) : null
  const said = events.find((e) => e.kind === 'agent.say' && e.agentId)
  const say = said && since !== null && said.ts >= since ? { id: said.id, agentId: said.agentId!, text: said.text } : undefined

  return { stage, legs, focus, say, review: ready.length ? reviewCard(ready, i.tasks ?? [], i.agents) : undefined }
}

/**
 * The review card's words. PRs from one split task read as that task ("T-15 is ready to merge"). The reviewer is named
 * only when the plan gave a reviewer agent a task under the same parent, since a ready PR alone says nothing about who reviewed it.
 */
export function reviewCard(ready: Workspace[], tasks: Task[], agents: AgentDef[]): { title: string; sub: string } {
  const taskOf = (w: Workspace) => tasks.find((t) => t.workspaceId === w.id)
  const parents = new Set(ready.map((w) => { const t = taskOf(w); return t ? t.parentId ?? t.id : undefined }))
  const parent = parents.size === 1 ? [...parents][0] : undefined
  const reviewer = parent
    ? agents.find((a) => /review/i.test(a.role) && tasks.some((t) => t.parentId === parent && t.agentId === a.id))
    : undefined
  const n = ready.length
  const one = n === 1 ? ready[0] : undefined
  const title = `${parent ?? (one ? (one.prNumber ? `PR #${one.prNumber}` : one.name) : `${n} PRs`)} ${n === 1 || parent ? 'is' : 'are'} ready to merge`
  const prs = one ? 'The PR' : `${cap(NUMBERS[n] ?? String(n))} PRs`
  const sub = reviewer ? `${prs} passed ${reviewer.name}’s review and every check is green.` : `${prs} ${one ? 'has' : 'have'} green checks and no changes requested.`
  return { title, sub }
}
