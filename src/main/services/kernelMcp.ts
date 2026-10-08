import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentDef, Decision, Workspace, WorkspaceMode } from '@shared/types'
import { bus } from '../bus'
import { renderAgentFile } from './agents'
import { HANDOFF_NOW } from './handoff'

export interface KernelToolDeps {
  roomId: string
  lead: AgentDef | undefined
  agents: () => Promise<AgentDef[]>
  workspaces: () => Workspace[]
  createWorkspace: (o: { prompt: string; agentId: string; mode?: WorkspaceMode; baseRef?: string; title?: string }) => Promise<Workspace>
  messageWorkspace: (workspaceId: string, text: string) => Promise<void>
  /** `steps` and `agentFile` shape plan and hire cards; the hand-off links come from `onWorkspace`. */
  askUser: (o: { kind: 'plan' | 'question' | 'agent'; title: string; detail?: string; options?: string[]; steps?: string[]; agentFile?: { path: string; text: string } }) => Promise<Decision | null>
  hireAgent: (o: { id: string; description: string; prompt: string; model?: string; tools?: string[]; role?: string }) => Promise<string>
  /** The user approved a plan, and a workspace was created. Together they hold the Lead to the hand-off (KERNEL-67). */
  planApproved?: () => void
  handedOff?: () => void
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/**
 * Tools exposed to the Lead as mcp__kernel__*. They are how a plan turns into workspaces on the floor:
 * Rowan proposes a plan, waits for the user to approve it, then creates one workspace per task.
 */
export function kernelMcpServer(d: KernelToolDeps) {
  return createSdkMcpServer({
    name: 'kernel',
    version: '0.1.0',
    instructions: 'You lead a team of agents in Kernel. Plan first, in plan mode or with request_plan_approval. Once the user approves, hand each task to one agent with create_workspace in the same turn. Use say for short updates people see on the floor.',
    // Handing out work is the Lead's job, so these load with the prompt instead of waiting behind tool search.
    alwaysLoad: true,
    tools: kernelTools(d)
  })
}

/** The Lead's tools, apart from the server so tests can call them. */
export function kernelTools(d: KernelToolDeps) {
  return [
    tool('list_agents', 'List the agents in this room with their roles.', {}, async () => {
      const agents = await d.agents()
      return text(agents.map((a) => `${a.id}: ${a.name}, ${a.role}. ${a.description}`).join('\n') || 'No agents in .claude/agents yet.')
    }),
    tool('list_workspaces', 'List open workspaces in this room: id, agent, branch, PR state.', {}, async () => {
      const list = d.workspaces().filter((w) => w.status !== 'archived')
      return text(list.map((w) => `${w.id} · ${w.agentId} · ${w.branch} · PR ${w.prState}${w.prNumber ? ' #' + w.prNumber : ''}`).join('\n') || 'No open workspaces.')
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
      base_ref: z.string().optional()
    }, async ({ agent, title, brief, mode, base_ref }) => {
      const ws = await d.createWorkspace({ prompt: brief, agentId: agent, mode, baseRef: base_ref, title })
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
      return text('Sent.')
    }),
    tool('say', 'Say one short line out loud on the floor, like a speech bubble.', { text: z.string().max(140) }, async ({ text: t }) => {
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
      return text(`Saved ${file}. ${a.id} joins the floor.`)
    })
  ]
}

/** The first sentence of a message, short enough for a speech bubble. */
export function firstLine(t: string, max = 90): string {
  const one = t.trim().replace(/\s+/g, ' ')
  const end = one.search(/[.!?](\s|$)/)
  const line = end >= 0 ? one.slice(0, end + 1) : one
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
