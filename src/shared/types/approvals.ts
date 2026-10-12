import type { AgentReach } from './agents'

export type ApprovalKind = 'tool' | 'plan' | 'question' | 'agent'

/** One line of a plan card. `taskId` and `agentId` are set when the Lead plans a hand-off. */
export interface PlanStep {
  title: string
  taskId?: string
  agentId?: string
  /** The workspace the Lead created for this step, set once the plan is approved and handed off. */
  workspaceId?: string
}

/** One question of an AskUserQuestion call. A call can carry several. `recommended` marks the option the agent recommends (KERNEL-415). */
export interface AskedQuestion {
  question: string
  header?: string
  options: { label: string; description?: string; recommended?: boolean }[]
  multiSelect?: boolean
}

export interface Approval {
  id: string
  kind: ApprovalKind
  source: 'sdk' | 'hook'
  roomId?: string
  workspaceId?: string
  chatId?: string
  agentId?: string
  toolName?: string
  input?: unknown
  title: string
  detail?: string
  options?: string[]
  /** Question approvals: every question the agent asked. `title` and `options` stay the first one's. */
  questions?: AskedQuestion[]
  /** Question approvals: the answer to each question, keyed by its text. */
  answers?: Record<string, string>
  /** Plan approvals. */
  steps?: PlanStep[]
  /** Plan-mode plans: the copy Kernel keeps, relative to the workspace folder, for example `.kernel/plans/export-invoices.md`. */
  planFile?: string
  /**
   * Agent approvals: the file the Lead wants to write (WorkspaceHire.png), and the MCP servers it would reach
   * (WorkspaceHireServers.png, KERNEL-476).
   */
  agentFile?: { path: string; text: string; servers?: AgentReach }
  /**
   * Tool approvals for a tool the agent's file doesn't list, which Kernel asks about instead of blocking (KERNEL-432).
   * `server` is set for an MCP server's tool.
   */
  gate?: { tool: string; server?: string; agentId: string }
  /** Why Kernel asked, for the card's reason line: the classifier's reason, the blocked path, or that Codex runs it outside its sandbox (KERNEL-432). */
  reason?: string
  status: 'pending' | 'allowed' | 'denied' | 'answered' | 'expired'
  answer?: string
  createdAt: number
}

export type Decision =
  | { behavior: 'allow'; always?: boolean }
  /** `images` go with a plan's change request: main saves each one in the workspace and names its path in `message` (D-134). */
  | { behavior: 'deny'; message?: string; images?: { name: string; dataUrl: string }[] }
  /** `answers` maps each question's text to its answer; `text` is them joined for display. A text-only answer goes to the first question. */
  | { behavior: 'answer'; text: string; answers?: Record<string, string> }
