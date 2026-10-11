import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentDef, Decision, PrState, QueueReason, Workspace, WorkspaceMode } from '@shared/types'
import { isLeadWorkspace } from '@shared/leadWorkspace'
import { blockedWhy } from '@shared/merge'
import { isReviewer, RESERVED_AGENT_IDS, takesTasks } from '@shared/team'
import { bus } from '../bus'
import { kernelServer } from './kernelServer'
import { renderAgentFile } from './agents'
import { HANDOFF_NOW } from './handoff'
import { firstLine } from './text'
import { archiveSkip, CLOSED_PR } from './archiveGuard'
import { isMerged, joinLabels, waitLabel, waitRefusal, waitTargets } from './waits'

export interface KernelToolDeps {
  roomId: string
  lead: AgentDef | undefined
  /** The Lead tab these tools belong to. Workspaces it hands off report back to it (KERNEL-105). */
  chatId?: string
  /** The name of the Lead chat a tab is in, for work another chat handed off. */
  chatTitle?: (chatId: string) => string | undefined
  /** Whether a tab is in the same Lead chat as this one, whose work is this tab's too (KERNEL-337). Left out, only this tab is. */
  ownTab?: (chatId: string) => boolean
  /** Plans approved in every tab of this tab's Lead chat, newest first: the tab's title, when it was asked for, and the plan (KERNEL-337). */
  plans?: () => { tab: string; at: number; plan: string }[]
  agents: () => Promise<AgentDef[]>
  workspaces: () => Workspace[]
  /**
   * `setupFailed` says how setup failed, when it did ("exit code 1"), and `queued` what the brief waits for when it didn't
   * go out (KERNEL-272), so the result can tell the Lead the teammate hasn't started.
   */
  createWorkspace: (o: { prompt: string; agentId: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string; reviewOf?: string; linkReviewOf?: string; issue?: string; waitFor?: string[] }) => Promise<Workspace & { setupFailed?: string; queued?: QueueReason }>
  /**
   * Sends the Lead's message into a teammate's workspace. `ok` is false when it was refused; `sent` is true when it went out
   * now rather than waiting in a queue; `note` says what happened.
   */
  messageWorkspace: (workspaceId: string, text: string) => Promise<{ ok: boolean; sent?: boolean; note: string }>
  /** `steps` and `agentFile` shape plan and hire cards; the hand-off links come from `onWorkspace`. */
  askUser: (o: { kind: 'plan' | 'question' | 'agent'; title: string; detail?: string; options?: string[]; steps?: string[]; agentFile?: { path: string; text: string } }) => Promise<Decision | null>
  hireAgent: (o: { id: string; description: string; prompt: string; model?: string; tools?: string[]; role?: string }) => Promise<string>
  /** Archives with the user's Settings for the branch, as the sidebar does (KERNEL-93). */
  archiveWorkspace: (workspaceId: string) => Promise<void>
  /** Merges the workspace's PR as the Merge button does, refusing with the reason when it can't merge (KERNEL-349). */
  mergeWorkspace?: (workspaceId: string) => Promise<Workspace>
  /** Whether Settings, Pull requests lets the Lead merge. Read on each call, since the Lead's tools are built once. Left out, it can't (KERNEL-352). */
  leadMerge?: () => boolean
  /** Whether the user started the Lead's current turn, rather than Kernel. Left out, Kernel did. */
  userTurn?: () => boolean
  /** Sets what the workspace waits for, by workspace id; an empty list ends the wait and starts a held brief (KERNEL-259). */
  setWait?: (workspaceId: string, on: string[]) => Promise<Workspace>
  /** Reads the PR from GitHub and saves its state, so a merge Kernel missed doesn't block archive (KERNEL-109). Left out, the saved state decides. */
  refreshPr?: (workspaceId: string) => Promise<Workspace>
  /** Whether any of the workspace's chats is running a turn. */
  isRunning: (workspaceId: string) => boolean
  /** Whether archiving would lose uncommitted work: 'dirty', 'unknown' when git can't tell, or false. */
  unsaved: (workspaceId: string) => Promise<'dirty' | 'unknown' | false>

  /** Whether the Lead chat is in plan mode now. Read on each call, since the toggle can change mid-session. Left out, it counts as off (KERNEL-176). */
  planMode?: () => boolean
  /** The user approved a plan, and a workspace was created. Together they hold the Lead to the hand-off (KERNEL-67). An approval also ends plan mode (D-074). */
  planApproved?: () => void | Promise<void>
  handedOff?: () => void
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** Why a brief or message waits, and when it goes out, for the reasons that hold a whole chat rather than one turn. */
const WAITS: Partial<Record<QueueReason, { because: string; until: string }>> = {
  capacity: { because: 'Every agent slot in Settings, Models is in use', until: 'when a slot frees up' },
  paused: { because: 'The room is paused', until: 'when the user resumes it' },
  offline: { because: 'Kernel is offline or signed out', until: 'once it is back' }
}

/**
 * What create_workspace and message_agent tell the Lead when the agent limit, a paused room or being offline holds what
 * they sent, so both tools use the same words (KERNEL-272). A brief also says the teammate hasn't started. Nothing for
 * other reasons, which each tool words itself.
 */
export function queuedNote(why: QueueReason | undefined, o: { name: string; brief?: boolean }): string | undefined {
  const w = why && WAITS[why]
  if (!w) return undefined
  return o.brief ? `${w.because}, so ${o.name} hasn't started. The brief goes out ${w.until}.` : `${w.because}, so the message goes out ${w.until}.`
}

/** request_plan_approval's refusal in a chat that isn't in plan mode (KERNEL-176). */
export const PLAN_MODE_OFF = 'Not asked: plan mode is off in this chat, so there is no plan to approve. Answer in the chat, suggest what you would hand off and to whom, and ask the user before calling create_workspace. If their message already says to go ahead, hand it off now.'

/** request_plan_approval's refusal when it gets task lines without the write-up (KERNEL-373). */
export const NO_PLAN = 'Not asked: plan is missing. Pass the full plan as markdown in plan (context, approach, files, checks) and one line per task in steps, then call request_plan_approval again.'

/** merge_workspace's refusals: the switch in Settings is off, or Kernel started the turn (KERNEL-352). */
export const MERGE_OFF = 'Merging is off in Settings, Pull requests. Tell the user they can merge from the PRs tab.'
export const MERGE_NOT_ASKED = 'Only the user can ask you to merge. Tell them which PRs are ready.'

/** Why merge_workspace skips a PR in this state. Nothing for the states a merge can start from, which `mergePr` checks. */
const NOT_MERGEABLE: Partial<Record<PrState, string>> = {
  none: 'it has no pull request yet', creating: 'its pull request is still being opened', draft: 'it is still a draft',
  checks: 'checks are still running', cifail: 'checks failing', changes: 'a review asked for changes', conflict: 'it has merge conflicts',
  resolving: 'its conflicts are being resolved', merging: 'it is already merging', merged: 'it already merged', closed: 'it was closed'
}

/**
 * The agent `asked` names: its exact id, else the one whose id or name matches ignoring case. A miss or a name two
 * agents share comes back as the tool's refusal, listing who takes tasks, so the Lead can try again with a real id
 * (KERNEL-119). `reason` is what Kernel counts (KERNEL-397).
 */
export function pickAgent(team: AgentDef[], asked: string): AgentDef | { refusal: string; reason: 'unknown' | 'ambiguous' | 'no-teammates' } {
  const exact = team.find((a) => a.id === asked)
  if (exact) return exact
  const want = asked.trim().toLowerCase()
  const found = team.filter((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want)
  if (found.length === 1) return found[0]
  if (found.length > 1) return { reason: 'ambiguous', refusal: `Not created: "${asked}" matches more than one agent (${found.map((a) => a.id).join(', ')}). Use the id from list_agents.` }
  const list = takers(team)
  return list
    ? { reason: 'unknown', refusal: `Not created: no agent "${asked}" on this team. Use an id from list_agents: ${list}.` }
    : { reason: 'no-teammates', refusal: `Not created: this team has no teammates yet. Propose one with hire_agent.` }
}

/** The agents the Lead can hand a task to, as refusals list them. */
const takers = (team: AgentDef[]) => team.filter((a) => !a.lead && takesTasks(a)).map((a) => `${a.id} (${a.name}, ${a.role})`).join(', ')

/** What list_agents adds after an agent's role: who leads, who reviews and who doesn't take tasks (KERNEL-397). */
function roleTag(a: AgentDef): string {
  if (a.lead) return ' (the Lead, you)'
  if (isReviewer(a)) return takesTasks(a) ? ' (reviews PRs, takes tasks)' : ' (reviews PRs)'
  return takesTasks(a) ? '' : " (helper, doesn't take tasks)"
}

/** What the Lead's server tells the model, next to the tools. */
export const LEAD_INSTRUCTIONS = 'You lead a team of agents in Kernel. While the chat is in plan mode, plan first and ask for approval with request_plan_approval: the full plan as markdown in plan, and one line per task in steps, which plan doesn\'t repeat. Once the user approves, hand each task to one teammate with create_workspace in the same turn. With plan mode off, don\'t ask for plan approval. Answer in the chat, suggest what you would hand off and to whom, and ask the user before calling create_workspace, unless their message already says to go ahead. A task that needs another task\'s PR merged first takes wait_for, and wait_for_merge sets or ends a wait later. Follow up with message_agent. Use say for a short status line people see on your card in the sidebar. When the user asks, archive finished workspaces with archive_workspace; it skips any that are still in use. Merge ready PRs with merge_workspace only when the user asks; it says when merging is off.'

/**
 * The workspace a reviewer's base names: the Lead sometimes starts a review from the reviewed branch with base_ref instead
 * of review_of (KERNEL-299). Only for a Reviewer, so a task branched off another task is never archived with it. The base
 * may carry `origin/`. A workspace on the main checkout has no branch of its own to review. An open workspace wins;
 * `done` also takes an archived one whose PR merged or closed, for the start sweep.
 */
export function reviewedByBase(agent: AgentDef | undefined, baseRef: string | undefined, workspaces: Workspace[], o: { self?: string; done?: boolean } = {}): Workspace | undefined {
  if (!agent || !isReviewer(agent) || !baseRef) return undefined
  const branch = baseRef.trim().replace(/^origin\//, '')
  const on = workspaces.filter((w) => w.id !== o.self && w.mode !== 'current' && w.branch === branch).sort((a, b) => b.createdAt - a.createdAt)
  return on.find((w) => w.status !== 'archived') ?? (o.done ? on.find((w) => w.prState === 'merged' || w.prState === 'closed') : undefined)
}

/**
 * Tools exposed to the Lead as mcp__kernel__*. They are how a plan turns into workspaces:
 * Rowan proposes a plan, waits for the user to approve it, then creates one workspace per task.
 */
export function kernelMcpServer(d: KernelToolDeps) {
  return kernelServer(kernelTools(d), LEAD_INSTRUCTIONS)
}

/** The Lead's tools, apart from the server so tests can call them. */
export function kernelTools(d: KernelToolDeps) {
  /** Work a tab of this Lead chat handed off, this tab or another (KERNEL-337). */
  const mine = (w: Workspace) => !!w.leadChatId && !!d.chatId && (w.leadChatId === d.chatId || !!d.ownTab?.(w.leadChatId))
  /** Which Lead chat a workspace reports to, as list_workspaces shows it. Nothing for work no Lead chat handed off. */
  const owner = (w: Workspace) => {
    if (!w.leadChatId || !d.chatId) return ''
    if (mine(w)) return ' · yours'
    const title = d.chatTitle?.(w.leadChatId)
    return title ? ` · from Lead chat "${title}"` : ' · from another Lead chat'
  }
  /**
   * The workspace with its PR state as GitHub has it. A saved open state can be stale, as when the PR merged after the
   * folder was deleted. A closed one needs no check, and when GitHub can't be reached the saved state decides (KERNEL-109).
   */
  const latestPr = async (ws: Workspace): Promise<Workspace> => {
    if (CLOSED_PR.has(ws.prState) || !d.refreshPr) return ws
    return d.refreshPr(ws.id).catch(() => ws)
  }
  /** What list_workspaces shows for a wait: " · waits for PR #164". */
  const waits = (w: Workspace, all: Workspace[]) => {
    const on = w.waitsFor?.on ?? []
    if (!on.length) return ''
    return ` · waits for ${joinLabels(on.map((id) => { const t = all.find((x) => x.id === id); return t?.prNumber ? `PR #${t.prNumber}` : `workspace ${id}` }))}`
  }
  /** "PR #164 by Noor" for each target, joined. */
  const labels = (targets: Workspace[], team: AgentDef[]) => joinLabels(targets.map((t) => waitLabel(t, team.find((a) => a.id === t.agentId)?.name ?? t.agentId)))
  /**
   * A hand-off Kernel made wait because Linear marks its issue as blocked (KERNEL-263): the teammate started, and Kernel
   * messages it when the blocking PRs merge. Rowan's own wait_for always holds the brief, so a wait that doesn't is Linear's.
   */
  const blocked = (ws: Workspace, team: AgentDef[], pick: AgentDef, queued: boolean) => {
    const key = (w: Workspace | undefined) => (w?.source?.kind === 'issue' ? w.source.id : undefined)
    const issue = key(ws)
    if (!ws.waitsFor?.on.length || ws.waitsFor.held || !issue) return ''
    const all = d.workspaces()
    const on = ws.waitsFor.on.map((id) => all.find((w) => w.id === id)).filter((t): t is Workspace => !!key(t))
    if (!on.length) return ''
    const name = (t: Workspace) => team.find((a) => a.id === t.agentId)?.name ?? t.agentId
    const builders = [...new Set(on.map(name))]
    const prs = on.map((t) => (t.prNumber ? `PR #${t.prNumber}` : `${name(t)}'s PR`))
    return ` Linear marks ${issue} as blocked by ${joinLabels(on.map((t) => key(t)!))}, which ${joinLabels(builders)} ${builders.length > 1 ? 'are' : 'is'} building. ${pick.name} starts ${queued ? 'once the brief goes out' : 'now'}, and Kernel messages ${pick.name} when ${joinLabels(prs)} ${prs.length > 1 ? 'merge' : 'merges'}. Pass wait_for to hold the brief instead.`
  }
  return [
    tool('list_agents', 'List the agents in this room with their roles.', {}, async () => {
      const agents = await d.agents()
      return text(agents.map((a) => `${a.id}: ${a.name}, ${a.role}${roleTag(a)}. ${a.description}`).join('\n') || 'No agents in .claude/agents yet.')
    }),
    tool('list_workspaces', 'List open workspaces in this room: id, agent, branch, PR state, and "yours" for the ones you handed off in this chat.', {}, async () => {
      const all = d.workspaces()
      const list = all.filter((w) => w.status !== 'archived')
      return text(list.map((w) => `${w.id} · ${w.agentId} · ${w.branch} · PR ${w.prState}${w.prNumber ? ' #' + w.prNumber : ''}${w.prBlocked ? ` (GitHub blocks the merge: ${blockedWhy[w.prBlocked]})` : ''}${waits(w, all)}${owner(w)}`).join('\n') || 'No open workspaces.')
    }),
    tool('request_plan_approval', 'Show a plan to the user and wait for approval. Only while the chat is in plan mode. With plan mode off it refuses, and you ask in the chat before handing off. Put the full plan as markdown in plan, and one line per task in steps, which plan doesn\'t repeat. Returns "approved" with what to do next, or the requested changes.', {
      title: z.string().describe('Short plan title, for example "T-15 Export invoices as PDF"'),
      plan: z.string().describe('The full plan as markdown: context, approach, files, checks. The tasks go in steps, not here'),
      steps: z.array(z.string()).min(1).describe('One line per task, ideally "<task> · <agent name>"')
    }, async ({ title, plan, steps }) => {
      // The chat's plan toggle decides, so a plan never shows with Copy and Approve in a chat that isn't planning (KERNEL-176).
      if (!d.planMode?.()) return { ...text(PLAN_MODE_OFF), isError: true }
      // Task lines alone hide the write-up, which then never reaches the chat or .kernel/plans/ (KERNEL-373).
      if (!plan?.trim()) return { ...text(NO_PLAN), isError: true }
      bus.activity({ kind: 'approval.requested', roomId: d.roomId, agentId: d.lead?.id, text: 'asked you to review', object: title })
      const decision = await d.askUser({ kind: 'plan', title, detail: plan, steps })
      if (!decision) return text('No answer yet. Wait and ask again later.')
      // Out of plan mode before the answer goes back, so the hand-off that follows runs outside it.
      if (decision.behavior === 'allow') { await d.planApproved?.(); return text(`approved. ${HANDOFF_NOW}`) }
      return text(`changes requested: ${decision.behavior === 'deny' ? decision.message ?? 'no details' : decision.text}`)
    }),
    tool('ask_user', 'Ask the user a short question, optionally with options. Waits for the answer.', {
      question: z.string(), options: z.array(z.string()).optional()
    }, async ({ question, options }) => {
      const decision = await d.askUser({ kind: 'question', title: question, options })
      if (!decision) return text('No answer yet.')
      return text(decision.behavior === 'answer' ? decision.text : decision.behavior)
    }),
    tool('create_workspace', 'Create a workspace for one task and hand it to an agent. The agent starts once setup passes, or, with wait_for, once those PRs merge.', {
      agent: z.string().describe('Agent id from list_agents, for example "kai"'),
      title: z.string().describe('Task title, used to name the branch'),
      brief: z.string().describe('Everything the agent needs: goal, files, acceptance criteria'),
      mode: z.enum(['worktree', 'current']).optional(),
      base_ref: z.string().optional(),
      branch: z.string().optional().describe('Only when the user asked for a particular branch name. Left out, Kernel names it from the issue key and title, for example fix/kernel-267-review-cant-start-reviewed-branch'),
      issue: z.string().optional().describe('The key of the Linear issue this task builds, for example "KERNEL-83". Kernel links the workspace to it, names the branch after it unless you pass branch, and moves the issue to In Progress'),
      review_of: z.string().optional().describe("For a review: the id of the workspace whose work to review. The reviewer's worktree starts from that workspace's branch, and the reviewer reports back with submit_review"),
      wait_for: z.array(z.string()).optional().describe('For a task that needs other tasks merged first: the ids of their workspaces (a PR number like "#164" or a Linear key works too). Kernel creates the worktree and runs setup now, holds the brief, and sends it from the new base once every one of them has merged')
    }, async ({ agent, title, brief, mode, base_ref, branch, issue, review_of: askedReview, wait_for }) => {
      // An agent the team doesn't have used to fall back to the Lead, whose work never reports back (KERNEL-119).
      const team = await d.agents()
      const pick = pickAgent(team, agent)
      if ('refusal' in pick) { bus.track({ name: 'handoff.refused', reason: pick.reason }); return { ...text(pick.refusal), isError: true } }
      if (pick.lead) { bus.track({ name: 'handoff.refused', reason: 'self' }); return { ...text('Not created: hand tasks to a teammate, not to yourself. Call list_agents for the team.'), isError: true } }
      const refuse = (why: string) => ({ ...text(`Not created: ${why}`), isError: true })
      // A reviewer started on another workspace's branch is a review of it, with the same checks. It keeps base_ref and
      // branch, since a long reviewed branch can't take review_of yet (KERNEL-299, KERNEL-265).
      const review_of = askedReview ?? reviewedByBase(pick, base_ref, d.workspaces())?.id
      // A helper only answers when another agent calls it, so it gets no workspace of its own. The reviewer can still review (KERNEL-397).
      if (!takesTasks(pick) && !(review_of && isReviewer(pick))) {
        bus.track({ name: 'handoff.refused', reason: 'helper' })
        const list = takers(team)
        return refuse(`${pick.name} is a helper in this room and doesn't take tasks${isReviewer(pick) ? ', only reviews with review_of' : ''}.${list ? ` Use an id from list_agents: ${list}.` : ' Propose a teammate with hire_agent.'}`)
      }
      // A Lead that carries on after a quit may call this again for a task it already handed off (KERNEL-287). The same
      // issue anywhere in the room, or the same agent and title from this chat, is that task while its PR is still open.
      if (!review_of) {
        const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
        const open = d.workspaces().find((w) => w.status !== 'archived' && !w.reviewOf && w.prState !== 'merged' && w.prState !== 'closed' && (issue
          ? w.source?.kind === 'issue' && same(w.source.id, issue)
          : mine(w) && w.agentId === pick.id && !!w.title && same(w.title, title)))
        if (open) {
          const name = team.find((a) => a.id === open.agentId)?.name ?? open.agentId
          const what = issue ? `${issue.trim()} is already handed off` : 'this task is already handed off'
          if (open.status === 'failed') return refuse(`${what} to ${name} (workspace ${open.id}), and its setup failed. Tell the user to fix it and click Run again there.`)
          return refuse(`${what} to ${name} (workspace ${open.id}). Follow up with message_agent.`)
        }
      }
      // A review starts from the work it reviews, and only one per reviewer is open at a time (KERNEL-130).
      if (review_of) {
        const target = d.workspaces().find((w) => w.id === review_of)
        if (!target) return refuse(`there is no workspace ${review_of} in this room to review. Call list_workspaces for the ids.`)
        if (target.status === 'archived') return refuse(`${target.name} is archived. Ask the user to restore it from History first.`)
        if (team.find((a) => a.id === target.agentId)?.lead) return refuse('that is your own workspace.')
        if (target.reviewOf) return refuse(`${target.name} is itself a review. Review the work it reviews instead (workspace ${target.reviewOf}).`)
        if (target.prState === 'merged' || target.prState === 'closed') return refuse(`${target.name}'s PR is already ${target.prState}, so there is nothing left to review.`)
        if (target.mode === 'current') return refuse(`${target.name} works on the main checkout, not a branch of its own, so there is no branch to review. Ask its teammate to commit and open a pull request first.`)
        const open = d.workspaces().find((w) => w.reviewOf === target.id && w.agentId === pick.id && w.status !== 'archived')
        if (open?.status === 'failed') return refuse(`${pick.name} already has a review of this open (workspace ${open.id}), and its setup failed. Tell the user to fix it and click Run again there.`)
        if (open) return refuse(`${pick.name} already has a review of this open (workspace ${open.id}). Ask for another pass with message_agent.`)
      }
      // Work that merged already is left out; with nothing left, the hand-off starts as usual (KERNEL-259).
      let targets: Workspace[] = []
      if (wait_for?.length) {
        const all = d.workspaces()
        const why = waitRefusal({ workspaces: all, refs: wait_for, mode, reviewOf: review_of, isLead: (w) => !!team.find((a) => a.id === w.agentId)?.lead })
        if (why) return { ...text(`Not created: ${why}`), isError: true }
        targets = waitTargets(all, wait_for).filter((t) => !isMerged(t))
      }
      const ws = await d.createWorkspace({ prompt: brief, agentId: pick.id, mode, baseRef: base_ref, title, branch, ...(issue ? { issue } : {}), ...(askedReview ? { reviewOf: askedReview } : review_of ? { linkReviewOf: review_of } : {}), ...(wait_for?.length ? { waitFor: targets.map((t) => t.id) } : {}) })
      bus.activity({ kind: 'workspace.created', roomId: d.roomId, workspaceId: ws.id, agentId: d.lead?.id, text: `assigned ${title} to`, object: pick.id, data: { assignee: pick.id } })
      d.handedOff?.()
      // Kernel's backfill reads the "Created <id> on" prefix (kernel.ts backfillLeadChats), so it stays first.
      const failed = ws.status === 'failed' ? ` Setup failed (${ws.setupFailed ?? 'it did not pass'}), so ${pick.name} hasn't started. The brief waits until the user fixes setup and clicks Run again in that workspace.` : ''
      const stale = ws.fetchFailed ? ` ${ws.fetchFailed}` : ''
      const waiting = ws.waitsFor?.held && ws.waitsFor.on.length ? ` ${pick.name} waits for ${labels(targets.filter((t) => ws.waitsFor!.on.includes(t.id)), team)} to merge, and Kernel sends the brief then. Tell the user that merging it starts ${pick.name}.` : ''
      // A brief held for a slot, a pause or the connection isn't the teammate starting either (KERNEL-272). A brief held
      // for a merge says so above instead.
      const queued = failed || waiting ? undefined : queuedNote(ws.queued, { name: pick.name, brief: true })
      return text(`Created ${ws.id} on ${ws.branch} for ${pick.id}.${stale}${failed}${waiting}${queued ? ` ${queued}` : ''}${wait_for?.length ? '' : blocked(ws, team, pick, !!queued)}`)
    }),
    tool('wait_for_merge', "Make a teammate wait for other workspaces' PRs to merge, or stop waiting. Replaces any earlier wait. A teammate whose brief hasn't gone out gets it once they merge; one that already started is told to rebase onto them. An empty list ends the wait and sends a held brief now.", {
      workspace_id: z.string().describe('The workspace that waits, from list_workspaces'),
      on: z.array(z.string()).describe('The ids of the workspaces whose PRs it waits for (a PR number like "#164" or a Linear key works too). Empty to stop waiting')
    }, async ({ workspace_id, on }) => {
      const refuse = (why: string) => ({ ...text(`Not set: ${why}`), isError: true })
      if (!d.setWait) return refuse('waiting is not available here.')
      const all = d.workspaces()
      const ws = all.find((w) => w.id === workspace_id && w.status !== 'archived')
      if (!ws) return refuse(`there is no open workspace ${workspace_id} in this room. Call list_workspaces for the ids.`)
      const team = await d.agents()
      const isLead = (w: Workspace) => !!team.find((a) => a.id === w.agentId)?.lead
      if (isLead(ws)) return refuse('that is your own workspace.')
      const name = team.find((a) => a.id === ws.agentId)?.name ?? ws.agentId
      if (on.length) { const why = waitRefusal({ workspaces: all, refs: on, waiter: ws, isLead }); if (why) return refuse(why) }
      const targets = waitTargets(all, on)
      const merged = targets.filter(isMerged)
      const left = targets.filter((t) => !isMerged(t))
      const was = ws.waitsFor
      const after = await d.setWait(ws.id, left.map((t) => t.id))
      const already = merged.length ? `${labels(merged, team)} already merged. ` : ''
      if (!left.length) {
        if (!was) return text(`${already}${name} wasn't waiting for anything.`)
        return text(`${already}${name} no longer waits.${was.held && ws.status === 'ready' ? ` Kernel sent the brief, so ${name} starts now.` : ''}`)
      }
      const label = labels(left, team)
      return text(`${already}${after.waitsFor?.held ? `${name} waits for ${label} to merge, and Kernel sends the brief then. Tell the user that merging it starts ${name}.` : `${name} waits for ${label} to merge, and Kernel tells ${name} to rebase onto it then. Tell the user that merging it moves ${name} on.`}`)
    }),
    tool('message_agent', 'Send a follow-up message into an existing workspace chat.', {
      workspace_id: z.string(), text: z.string()
    }, async ({ workspace_id, text: t }) => {
      const r = await d.messageWorkspace(workspace_id, t)
      // Nothing went out: say why, as an error, so the Lead doesn't report it as done (KERNEL-118).
      if (!r.ok) return { ...text(r.note), isError: true }
      const ws = d.workspaces().find((w) => w.id === workspace_id)
      // The log shows who the Lead messaged and its first line (KERNEL-24), once the message has gone out.
      if (ws && d.lead && r.sent !== false) bus.activity({ kind: 'agent.talk', roomId: d.roomId, workspaceId: ws.id, agentId: d.lead.id, text: 'messaged', object: ws.name, quote: t.slice(0, 280), data: { from: d.lead.id, to: ws.agentId, workspaceId: ws.id, line: firstLine(t) } })
      // Its updates still go to the chat that handed it off, so say so rather than leave this chat waiting (KERNEL-105).
      const from = ws?.leadChatId && d.chatId && !mine(ws) ? d.chatTitle?.(ws.leadChatId) : undefined
      return text(from ? `${r.note} This workspace was handed off in the Lead chat "${from}", so its updates go there, not here.` : r.note)
    }),
    tool('archive_workspace', 'Archive workspaces whose work is done. Skips the Lead\'s own workspace, any with an agent still working, an open PR or uncommitted changes. The user can restore them from History.', {
      workspace_ids: z.array(z.string()).min(1).describe('Workspace ids from list_workspaces')
    }, async ({ workspace_ids }) => {
      const lines: string[] = []
      // One id at a time, so a skip or a failed archive doesn't stop the rest (D-090).
      for (const id of workspace_ids) {
        const ws = d.workspaces().find((w) => w.id === id && w.status !== 'archived')
        if (!ws) { lines.push(`Skipped ${id}: not an open workspace in this room.`); continue }
        const reason = await archiveSkip(ws, {
          // Only the Lead's own workspace. One handed to the Lead when an agent retired can go.
          isOwnLead: (w) => isLeadWorkspace(w, d.lead?.id),
          isRunning: d.isRunning, latestPr, unsaved: d.unsaved
        })
        if (reason) { lines.push(`Skipped ${ws.name}: ${reason}.`); continue }
        try {
          await d.archiveWorkspace(ws.id)
          lines.push(`Archived ${ws.name}.`)
        } catch (e) {
          const why = firstLine(e instanceof Error ? e.message : String(e))
          lines.push(`Skipped ${ws.name}: ${/[.!?…]$/.test(why) ? why : why + '.'}`)
        }
      }
      return text(lines.join('\n'))
    }),
    tool('merge_workspace', "Merge workspaces' pull requests, only when the user's own message asks. A review's id merges the PR it reviewed. Each merge needs what Settings, Pull requests asks for, such as passing checks and the reviewer's approval, and a PR that can't merge is skipped with the reason.", {
      workspace_ids: z.array(z.string()).min(1).describe('Workspace ids from list_workspaces')
    }, async ({ workspace_ids }) => {
      // Both gates hold here: mcp__kernel__* tools are auto-allowed, and the Lead's tools are built once per session (D-008).
      if (!d.mergeWorkspace || !d.leadMerge?.()) return { ...text(MERGE_OFF), isError: true }
      if (!d.userTurn?.()) return { ...text(MERGE_NOT_ASKED), isError: true }
      const lines: string[] = []
      // One id at a time, so a skip or a failed merge doesn't stop the rest, as archive_workspace does.
      for (const id of workspace_ids) {
        const asked = d.workspaces().find((w) => w.id === id && w.status !== 'archived')
        if (!asked) { lines.push(`Skipped ${id}: not an open workspace in this room.`); continue }
        // A review has no PR of its own: merging it means merging the work it reviewed.
        const target = asked.reviewOf ? d.workspaces().find((w) => w.id === asked.reviewOf) : asked
        if (!target || target.status === 'archived') { lines.push(`Skipped ${asked.name}: the work it reviewed is no longer open.`); continue }
        if (isLeadWorkspace(target, d.lead?.id)) { lines.push(`Skipped ${target.name}: it is your own workspace.`); continue }
        // A merge just before changes every other PR's base, so the saved state may be stale (KERNEL-283).
        const ws = await latestPr(target)
        const pr = ws.prNumber ? `#${ws.prNumber}` : ws.name
        const not = NOT_MERGEABLE[ws.prState]
        if (not) { lines.push(`Skipped ${pr}: ${not}.`); continue }
        try {
          const after = await d.mergeWorkspace(ws.id)
          const title = after.prTitle ?? ws.prTitle
          lines.push(`Merged ${pr}${title ? ` (${title})` : ''}.`)
        } catch (e) {
          // mergeBlock's reason is a finished sentence that names the reviewer and the setting, so it goes whole (KERNEL-349).
          // A failed merge's error is gh output, of which the first line is enough.
          const why = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0].trim().slice(0, 240)
          lines.push(`Skipped ${pr}: ${/[.!?…]$/.test(why) ? why : why + '.'}`)
        }
      }
      return text(lines.join('\n'))
    }),
    tool('read_plans', 'Read the plans approved in every tab of this chat, newest first: the tab, when it was approved and the plan.', {}, async () => {
      const plans = d.plans?.() ?? []
      if (!plans.length) return text('No plan has been approved in this chat yet.')
      return text(plans.map((p) => `Approved in the tab "${p.tab}" at ${new Date(p.at).toISOString()}:\n${p.plan}`).join('\n\n'))
    }),
    tool('say', 'Post one short status line. It shows on your card in the sidebar.', { text: z.string().max(140) }, async ({ text: t }) => {
      if (d.lead) bus.push({ type: 'agent.status', roomId: d.roomId, agentId: d.lead.id, status: 'working', activity: t })
      bus.activity({ kind: 'agent.say', roomId: d.roomId, agentId: d.lead?.id, text: t })
      return text('ok')
    }),
    tool('hire_agent', 'Propose a new agent file for .claude/agents. The user approves before it is saved.', {
      id: z.string().regex(/^[a-z][a-z0-9-]*$/), description: z.string(), prompt: z.string(),
      model: z.string().optional(), tools: z.array(z.string()).optional(), role: z.string().optional()
    }, async (a) => {
      // A name the team or Kernel's own agents use is refused before the user sees a card (KERNEL-397).
      if (RESERVED_AGENT_IDS.includes(a.id) || (await d.agents()).some((x) => x.id === a.id)) return { ...text(`Not proposed: ${a.id} is taken. Pick another id.`), isError: true }
      const agentFile = { path: `.claude/agents/${a.id}.md`, text: renderAgentFile({ ...a, tools: a.tools }) }
      const decision = await d.askUser({ kind: 'agent', title: `Add ${a.id} to the team`, detail: a.description, agentFile })
      if (!decision || decision.behavior !== 'allow') return text('The user did not approve this agent.')
      try {
        const file = await d.hireAgent(a)
        return text(`Saved ${file}. ${a.id} joins the team.`)
      } catch (e) { return { ...text(`Not saved: ${(e as Error).message}`), isError: true } }
    })
  ]
}
