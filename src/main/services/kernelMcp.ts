import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentDef, Decision, Workspace, WorkspaceMode } from '@shared/types'
import { bus } from '../bus'
import { renderAgentFile } from './agents'
import { HANDOFF_NOW } from './handoff'
import { firstLine } from './text'
import { archiveSkip, CLOSED_PR } from './archiveGuard'
import { isMerged, joinLabels, waitLabel, waitRefusal, waitTargets } from './waits'

export interface KernelToolDeps {
  roomId: string
  lead: AgentDef | undefined
  /** The Lead chat these tools belong to. Workspaces it hands off report back to it (KERNEL-105). */
  chatId?: string
  chatTitle?: (chatId: string) => string | undefined
  agents: () => Promise<AgentDef[]>
  workspaces: () => Workspace[]
  /** `setupFailed` says how setup failed, when it did ("exit code 1"), so the result can tell the Lead the teammate hasn't started. */
  createWorkspace: (o: { prompt: string; agentId: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string; reviewOf?: string; issue?: string; waitFor?: string[] }) => Promise<Workspace & { setupFailed?: string }>
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
  /** The user approved a plan, and a workspace was created. Together they hold the Lead to the hand-off (KERNEL-67). */
  planApproved?: () => void
  handedOff?: () => void
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** request_plan_approval's refusal in a chat that isn't in plan mode (KERNEL-176). */
export const PLAN_MODE_OFF = 'Not asked: plan mode is off in this chat, so there is no plan to approve. Answer in the chat, suggest what you would hand off and to whom, and ask the user before calling create_workspace. If their message already says to go ahead, hand it off now.'

/**
 * The agent `asked` names: its exact id, else the one whose id or name matches ignoring case. A miss or a name two
 * agents share comes back as the tool's refusal, listing the team, so the Lead can try again with a real id (KERNEL-119).
 */
export function pickAgent(team: AgentDef[], asked: string): AgentDef | string {
  const exact = team.find((a) => a.id === asked)
  if (exact) return exact
  const want = asked.trim().toLowerCase()
  const found = team.filter((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want)
  if (found.length === 1) return found[0]
  const list = team.filter((a) => !a.lead).map((a) => `${a.id} (${a.name}, ${a.role})`).join(', ')
  if (found.length > 1) return `Not created: "${asked}" matches more than one agent (${found.map((a) => a.id).join(', ')}). Use the id from list_agents.`
  return list
    ? `Not created: no agent "${asked}" on this team. Use an id from list_agents: ${list}.`
    : `Not created: this team has no teammates yet. Propose one with hire_agent.`
}

/**
 * Tools exposed to the Lead as mcp__kernel__*. They are how a plan turns into workspaces:
 * Rowan proposes a plan, waits for the user to approve it, then creates one workspace per task.
 */
export function kernelMcpServer(d: KernelToolDeps) {
  return createSdkMcpServer({
    name: 'kernel',
    version: '0.1.0',
    instructions: 'You lead a team of agents in Kernel. While the chat is in plan mode, plan first and ask for approval with ExitPlanMode or request_plan_approval. Once the user approves, hand each task to one teammate with create_workspace in the same turn. With plan mode off, don\'t ask for plan approval. Answer in the chat, suggest what you would hand off and to whom, and ask the user before calling create_workspace, unless their message already says to go ahead. A task that needs another task\'s PR merged first takes wait_for, and wait_for_merge sets or ends a wait later. Follow up with message_agent. Use say for a short status line people see on your card in the sidebar. When the user asks, archive finished workspaces with archive_workspace; it skips any that are still in use.',
    // Asks the CLI to load these with the prompt. A resumed session still deferred them in the first live run (KERNEL-67),
    // so the hand-off doesn't depend on it.
    alwaysLoad: true,
    tools: kernelTools(d)
  })
}

/** The Lead's tools, apart from the server so tests can call them. */
export function kernelTools(d: KernelToolDeps) {
  /** Which Lead chat a workspace reports to, as list_workspaces shows it. Nothing for work no Lead chat handed off. */
  const owner = (w: Workspace) => {
    if (!w.leadChatId || !d.chatId) return ''
    if (w.leadChatId === d.chatId) return ' · yours'
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
  return [
    tool('list_agents', 'List the agents in this room with their roles.', {}, async () => {
      const agents = await d.agents()
      return text(agents.map((a) => `${a.id}: ${a.name}, ${a.role}. ${a.description}`).join('\n') || 'No agents in .claude/agents yet.')
    }),
    tool('list_workspaces', 'List open workspaces in this room: id, agent, branch, PR state, and "yours" for the ones you handed off in this chat.', {}, async () => {
      const all = d.workspaces()
      const list = all.filter((w) => w.status !== 'archived')
      return text(list.map((w) => `${w.id} · ${w.agentId} · ${w.branch} · PR ${w.prState}${w.prNumber ? ' #' + w.prNumber : ''}${waits(w, all)}${owner(w)}`).join('\n') || 'No open workspaces.')
    }),
    tool('request_plan_approval', 'Show a plan to the user and wait for approval. Only while the chat is in plan mode. With plan mode off it refuses, and you ask in the chat before handing off. Returns "approved" with what to do next, or the requested changes.', {
      title: z.string().describe('Short plan title, for example "T-15 Export invoices as PDF"'),
      steps: z.array(z.string()).min(1).describe('One line per task, ideally "<task> · <agent name>"')
    }, async ({ title, steps }) => {
      // The chat's plan toggle decides, so a plan never shows with Copy and Approve in a chat that isn't planning (KERNEL-176).
      if (!d.planMode?.()) return { ...text(PLAN_MODE_OFF), isError: true }
      bus.activity({ kind: 'approval.requested', roomId: d.roomId, agentId: d.lead?.id, text: 'asked you to review', object: title })
      const decision = await d.askUser({ kind: 'plan', title, detail: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), steps })
      if (!decision) return text('No answer yet. Wait and ask again later.')
      if (decision.behavior === 'allow') { d.planApproved?.(); return text(`approved. ${HANDOFF_NOW}`) }
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
    }, async ({ agent, title, brief, mode, base_ref, branch, issue, review_of, wait_for }) => {
      // An agent the team doesn't have used to fall back to the Lead, whose work never reports back (KERNEL-119).
      const team = await d.agents()
      const pick = pickAgent(team, agent)
      if (typeof pick === 'string') return { ...text(pick), isError: true }
      if (pick.lead) return { ...text('Not created: hand tasks to a teammate, not to yourself. Call list_agents for the team.'), isError: true }
      const refuse = (why: string) => ({ ...text(`Not created: ${why}`), isError: true })
      // A Lead that carries on after a quit may call this again for a task it already handed off (KERNEL-287). The same
      // issue anywhere in the room, or the same agent and title from this chat, is that task while its PR is still open.
      if (!review_of) {
        const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
        const open = d.workspaces().find((w) => w.status !== 'archived' && !w.reviewOf && w.prState !== 'merged' && w.prState !== 'closed' && (issue
          ? w.source?.kind === 'issue' && same(w.source.id, issue)
          : !!d.chatId && w.leadChatId === d.chatId && w.agentId === pick.id && !!w.title && same(w.title, title)))
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
      const ws = await d.createWorkspace({ prompt: brief, agentId: pick.id, mode, baseRef: base_ref, title, branch, ...(issue ? { issue } : {}), ...(review_of ? { reviewOf: review_of } : {}), ...(targets.length ? { waitFor: targets.map((t) => t.id) } : {}) })
      bus.activity({ kind: 'workspace.created', roomId: d.roomId, workspaceId: ws.id, agentId: d.lead?.id, text: `assigned ${title} to`, object: pick.id, data: { assignee: pick.id } })
      d.handedOff?.()
      // Kernel's backfill reads the "Created <id> on" prefix (kernel.ts backfillLeadChats), so it stays first.
      const failed = ws.status === 'failed' ? ` Setup failed (${ws.setupFailed ?? 'it did not pass'}), so ${pick.name} hasn't started. The brief waits until the user fixes setup and clicks Run again in that workspace.` : ''
      const waiting = ws.waitsFor?.on.length ? ` ${pick.name} waits for ${labels(targets.filter((t) => ws.waitsFor!.on.includes(t.id)), team)} to merge, and Kernel sends the brief then. Tell the user that merging it starts ${pick.name}.` : ''
      return text(`Created ${ws.id} on ${ws.branch} for ${pick.id}.${failed}${waiting}`)
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
      const from = ws?.leadChatId && d.chatId && ws.leadChatId !== d.chatId ? d.chatTitle?.(ws.leadChatId) : undefined
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
          // Only the Lead's current-branch workspace. One handed to the Lead when an agent retired can go.
          isOwnLead: (w) => w.mode === 'current' && !!d.lead && w.agentId === d.lead.id,
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
    tool('say', 'Post one short status line. It shows on your card in the sidebar.', { text: z.string().max(140) }, async ({ text: t }) => {
      if (d.lead) bus.push({ type: 'agent.status', roomId: d.roomId, agentId: d.lead.id, status: 'working', activity: t })
      bus.activity({ kind: 'agent.say', roomId: d.roomId, agentId: d.lead?.id, text: t })
      return text('ok')
    }),
    tool('hire_agent', 'Propose a new agent file for .claude/agents. The user approves before it is saved.', {
      id: z.string().regex(/^[a-z][a-z0-9-]*$/), description: z.string(), prompt: z.string(),
      model: z.string().optional(), tools: z.array(z.string()).optional(), role: z.string().optional()
    }, async (a) => {
      const agentFile = { path: `.claude/agents/${a.id}.md`, text: renderAgentFile({ ...a, tools: a.tools }) }
      const decision = await d.askUser({ kind: 'agent', title: `Add ${a.id} to the team`, detail: a.description, agentFile })
      if (!decision || decision.behavior !== 'allow') return text('The user did not approve this agent.')
      const file = await d.hireAgent(a)
      return text(`Saved ${file}. ${a.id} joins the team.`)
    })
  ]
}
