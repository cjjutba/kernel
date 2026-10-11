import type { Effort } from './chats'

export type AgentStatus = 'working' | 'planning' | 'walking' | 'needs' | 'idle' | 'blocked' | 'offline' | 'paused'

/** How a person is drawn on the floor (Main.dc.html roster). Kernel picks one when the file has none. */
export interface AgentLook {
  shirt: string
  skin: string
  hair: string
}

export interface AgentDef {
  /** File stem in .claude/agents, also the Claude Code subagent name. */
  id: string
  /** Display name, for example "Kai". */
  name: string
  /** Short role, for example "Frontend". */
  role: string
  description: string
  model?: string
  /** Default effort for this agent's chats. Falls back to Settings > Models. */
  effort?: Effort
  tools?: string[]
  skills?: string[]
  /** True for the agent that plans and hands out work. */
  lead: boolean
  /** Body of the markdown file, used as appended system prompt. */
  prompt: string
  file: string
  look?: AgentLook
  /** When the file first appeared in the room. Drives "Joined today" and the new hire moment. */
  joinedAt?: number
  /** Retired agents live in .claude/retired-agents (D-003) and stay listable so they can come back. */
  retired?: boolean
}

/** The editable part of an agent file: AgentProfile and the New agent review step. */
export interface AgentEdit {
  name?: string
  role?: string
  description?: string
  model?: string
  effort?: Effort
  tools?: string[]
  skills?: string[]
  prompt?: string
}

/** New agent flow: Describe produces a draft file, Review edits it, Create saves it (NewAgent*.png). */
export interface AgentDraft {
  id: string
  name: string
  description: string
  model: string
  tools: string[]
  /** The whole file as it will be written, frontmatter included. */
  text: string
  file: string
}

/** Team templates offered on an empty floor (FloorEmpty.png). */
export type TeamTemplate = { kind: 'starter' } | { kind: 'pair' } | { kind: 'copy'; fromRoomId: string }
