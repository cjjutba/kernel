import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentDef, Decision, PrState, Workspace, WorkspaceMode } from '@shared/types'
import { bus } from '../bus'
import { renderAgentFile } from './agents'
import { HANDOFF_NOW } from './handoff'
import { firstLine } from './text'

export interface KernelToolDeps {
  roomId: string
  lead: AgentDef | undefined
  /** The Lead chat these tools belong to. Workspaces it hands off report back to it (KERNEL-105). */
  chatId?: string
  chatTitle?: (chatId: string) => string | undefined
  agents: () => Promise<AgentDef[]>
  workspaces: () => Workspace[]
  createWorkspace: (o: { prompt: string; agentId: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string }) => Promise<Workspace>
  messageWorkspace: (workspaceId: string, text: string) => Promise<void>
  /** `steps` and `agentFile` shape plan and hire cards; the hand-off links come from `onWorkspace`. */
  askUser: (o: { kind: 'plan' | 'question' | 'agent'; title: string; detail?: string; options?: string[]; steps?: string[]; agentFile?: { path: string; text: string } }) => Promise<Decision | null>
  hireAgent: (o: { id: string; description: string; prompt: string; model?: string; tools?: string[]; role?: string }) => Promise<string>
  /** Archives with the user's Settings for the branch, as the sidebar does (KERNEL-93). */
  archiveWorkspace: (workspaceId: string) => Promise<void>
  /** Reads the PR from GitHub and saves its state, so a merge Kernel missed doesn't block archive (KERNEL-109). Left out, the saved state decides. */
  refreshPr?: (workspaceId: string) => Promise<Workspace>
  /** Whether any of the workspace's chats is running a turn. */
  isRunning: (workspaceId: string) => boolean
  /** Whether archiving would lose uncommitted work: 'dirty', 'unknown' when git can't tell, or false. */
  unsaved: (workspaceId: string) => Promise<'dirty' | 'unknown' | false>

  /** The user approved a plan, and a workspace was created. Together they hold the Lead to the hand-off (KERNEL-67). */
  planApproved?: () => void
  handedOff?: () => void
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** PR states the Lead may archive over. Every other state is a PR still in flight. */
const CLOSED_PR = new Set<PrState>(['none', 'merged', 'closed'])

/**
 * Tools exposed to the Lead as mcp__kernel__*. They are how a plan turns into workspaces on the floor:
 * Rowan proposes a plan, waits for the user to approve it, then creates one workspace per task.
 */
export function kernelMcpServer(d: KernelToolDeps) {
  return createSdkMcpServer({
    name: 'kernel',
    version: '0.1.0',
    instructions: 'You lead a team of agents in Kernel. Plan first, in plan mode or with request_plan_approval. Once the user approves, hand each task to one agent with create_workspace in the same turn. Use say for a short status line people see on your card in the sidebar. When the user asks, archive finished workspaces with archive_workspace; it skips any that are still in use.',
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
  return [
    tool('list_agents', 'List the agents in this room with their roles.', {}, async () => {
      const agents = await d.agents()
      return text(agents.map((a) => `${a.id}: ${a.name}, ${a.role}. ${a.description}`).join('\n') || 'No agents in .claude/agents yet.')
    }),
    tool('list_workspaces', 'List open workspaces in this room: id, agent, branch, PR state, and "yours" for the ones you handed off in this chat.', {}, async () => {
      const list = d.workspaces().filter((w) => w.status !== 'archived')
      return text(list.map((w) => `${w.id} · ${w.agentId} · ${w.branch} · PR ${w.prState}${w.prNumber ? ' #' + w.prNumber : ''}${owner(w)}`).join('\n') || 'No open workspaces.')
    }),
    tool('request_plan_approval', 'Show a plan to the user and wait for approval. Returns "approved" with what to do next, or the requested changes.', {
      title: z.string().describe('Short plan title, for example "T-15 Export invoices as PDF"'),
      steps: z.array(z.string()).min(1).describe('One line per task, ideally "<task> · <agent name>"')
    }, async ({ title, steps }) => {
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
    tool('create_workspace', 'Create a workspace for one task and hand it to an agent. Starts the agent right away.', {
      agent: z.string().describe('Agent id from list_agents, for example "kai"'),
      title: z.string().describe('Task title, used to name the branch'),
      brief: z.string().describe('Everything the agent needs: goal, files, acceptance criteria'),
      mode: z.enum(['worktree', 'current']).optional(),
      base_ref: z.string().optional(),
      branch: z.string().optional().describe("Branch name for the work, when the repo names branches after its issues (for example Linear's gitBranchName). Left out, Kernel names it from the title")
    }, async ({ agent, title, brief, mode, base_ref, branch }) => {
      const ws = await d.createWorkspace({ prompt: brief, agentId: agent, mode, baseRef: base_ref, title, branch })
      bus.activity({ kind: 'workspace.created', roomId: d.roomId, workspaceId: ws.id, agentId: d.lead?.id, text: `assigned ${title} to`, object: agent, data: { assignee: agent } })
      d.handedOff?.()
      return text(`Created ${ws.id} on ${ws.branch} for ${agent}.`)
    }),
    tool('message_agent', 'Send a follow-up message into an existing workspace chat.', {
      workspace_id: z.string(), text: z.string()
    }, async ({ workspace_id, text: t }) => {
      await d.messageWorkspace(workspace_id, t)
      const ws = d.workspaces().find((w) => w.id === workspace_id)
      // The speaker walks to the listener's desk and says the first line (KERNEL-24).
      if (ws && d.lead) bus.activity({ kind: 'agent.talk', roomId: d.roomId, workspaceId: ws.id, agentId: d.lead.id, text: 'messaged', object: ws.name, quote: t.slice(0, 280), data: { from: d.lead.id, to: ws.agentId, workspaceId: ws.id, line: firstLine(t) } })
      // Its updates still go to the chat that handed it off, so say so rather than leave this chat waiting (KERNEL-105).
      const from = ws?.leadChatId && d.chatId && ws.leadChatId !== d.chatId ? d.chatTitle?.(ws.leadChatId) : undefined
      return text(from ? `Sent. This workspace was handed off in the Lead chat "${from}", so its updates go there, not here.` : 'Sent.')
    }),
    tool('archive_workspace', 'Archive workspaces whose work is done. Skips the Lead\'s own workspace, any with an agent still working, an open PR or uncommitted changes. The user can restore them from History.', {
      workspace_ids: z.array(z.string()).min(1).describe('Workspace ids from list_workspaces')
    }, async ({ workspace_ids }) => {
      const lines: string[] = []
      // One id at a time, so a skip or a failed archive doesn't stop the rest (D-090).
      for (const id of workspace_ids) {
        const ws = d.workspaces().find((w) => w.id === id && w.status !== 'archived')
        const first = !ws ? 'not an open workspace in this room'
          // Only the Lead's current-branch workspace. One handed to the Lead when an agent retired can go.
          : ws.mode === 'current' && !!d.lead && ws.agentId === d.lead.id ? 'it is your own workspace'
          : d.isRunning(ws.id) ? 'its agent is still working'
          : undefined
        const pr = ws && !first ? await latestPr(ws) : undefined
        const prOpen = pr && !CLOSED_PR.has(pr.prState) ? `its PR${pr.prNumber ? ' #' + pr.prNumber : ''} is open and not merged` : undefined
        const skip = first ?? prOpen
        // Archive removes the worktree with --force, and Restore can't bring back what was never committed.
        // Unpushed commits stay on the kept branch (KERNEL-70), so only uncommitted work blocks, as in the sidebar.
        const unsaved = !ws || skip ? false : await d.unsaved(ws.id)
        const reason = skip ?? (unsaved === 'dirty' ? 'it has uncommitted changes' : unsaved === 'unknown' ? 'its git status could not be read' : undefined)
        if (!ws || reason) { lines.push(`Skipped ${ws?.name ?? id}: ${reason}.`); continue }
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
