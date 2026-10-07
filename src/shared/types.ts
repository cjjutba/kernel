// Domain types shared by the main process, preload and renderer.

export type AgentStatus = 'working' | 'planning' | 'walking' | 'needs' | 'idle' | 'blocked' | 'offline' | 'paused'

export interface AgentDef {
  /** File stem in .claude/agents, also the Claude Code subagent name. */
  id: string
  /** Display name, for example "Kai". */
  name: string
  /** Short role, for example "Frontend". */
  role: string
  description: string
  model?: string
  tools?: string[]
  skills?: string[]
  /** True for the agent that plans and hands out work. */
  lead: boolean
  /** Body of the markdown file, used as appended system prompt. */
  prompt: string
  file: string
}

export interface Room {
  id: string
  name: string
  /** Absolute path of the main checkout. */
  path: string
  /** owner/repo when the folder has a GitHub remote. */
  repo?: string
  defaultBranch: string
  paused: boolean
  createdAt: number
}

export type WorkspaceMode = 'worktree' | 'current'
export type WorkspaceStatus = 'setup' | 'ready' | 'failed' | 'archived'
export type PrState = 'none' | 'draft' | 'open' | 'checks' | 'cifail' | 'changes' | 'conflict' | 'ready' | 'merged' | 'closed'

export interface Workspace {
  id: string
  roomId: string
  name: string
  branch: string
  baseRef: string
  path: string
  mode: WorkspaceMode
  agentId: string
  port: number
  status: WorkspaceStatus
  /** For current-branch workspaces: the commit that captures pre-existing changes. */
  baselineRef?: string
  prNumber?: number
  prUrl?: string
  prState: PrState
  createdAt: number
}

export type ModelId = 'claude-fable-5-1' | 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-4-5-20251001'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

export const MODELS: { id: ModelId; label: string }[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
]

export interface Chat {
  id: string
  workspaceId: string
  title: string
  kind: 'chat' | 'terminal'
  /** Claude Code session id, used to resume. */
  sessionId?: string
  model: ModelId
  effort: Effort
  plan: boolean
  createdAt: number
}

/** One rendered row in a chat transcript. Mirrors the kinds drawn on the canvas. */
export type ChatItem =
  | { kind: 'user'; id: string; ts: number; parts: ChatPart[] }
  | { kind: 'text'; id: string; ts: number; text: string }
  | { kind: 'thinking'; id: string; ts: number; text: string }
  | { kind: 'tool'; id: string; ts: number; toolUseId: string; name: string; label: string; detail: string; status: 'running' | 'done' | 'failed'; output?: string; durationMs?: number }
  | { kind: 'result'; id: string; ts: number; durationMs: number; ok: boolean; error?: string }
  | { kind: 'note'; id: string; ts: number; text: string; link?: { label: string; href: string } }
  | { kind: 'interrupted'; id: string; ts: number }

/** Composer parts. Pasted long text becomes a file part carrying its text; images carry a data URL. */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'file'; name: string; path?: string; lines?: number; text?: string }
  | { type: 'image'; name: string; dataUrl?: string }

export type ApprovalKind = 'tool' | 'plan' | 'question'

export interface Approval {
  id: string
  kind: ApprovalKind
  source: 'sdk' | 'hook'
  roomId?: string
  workspaceId?: string
  agentId?: string
  toolName?: string
  input?: unknown
  title: string
  detail?: string
  options?: string[]
  status: 'pending' | 'allowed' | 'denied' | 'answered' | 'expired'
  answer?: string
  createdAt: number
}

export type Decision =
  | { behavior: 'allow'; always?: boolean }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'answer'; text: string }

/** A line in the room logs and the source of every floor animation. */
export interface ActivityEvent {
  id: string
  ts: number
  roomId?: string
  workspaceId?: string
  agentId?: string
  sessionId?: string
  kind:
    | 'session.start' | 'session.end' | 'prompt' | 'tool.start' | 'tool.end' | 'tool.failed'
    | 'turn.done' | 'approval.requested' | 'approval.decided' | 'task.created' | 'task.completed'
    | 'workspace.created' | 'workspace.archived' | 'pr.changed' | 'agent.status' | 'agent.say' | 'limit' | 'note'
  text: string
  object?: string
  data?: Record<string, unknown>
}

export interface RateLimit {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'
  status: 'allowed' | 'allowed_warning' | 'rejected'
  utilization?: number
  resetsAt?: number
}

export interface ChangedFile {
  path: string
  status: 'A' | 'M' | 'D' | 'R' | '?'
  added: number
  removed: number
}

export interface PreflightCheck {
  id: 'claude' | 'auth' | 'gh' | 'hooks'
  ok: boolean
  title: string
  detail: string
  fix?: { command?: string; action?: string }
}
