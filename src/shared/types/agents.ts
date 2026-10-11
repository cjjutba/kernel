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
  /**
   * Kernel's own Lead or reviewer, run from the app's bundled file because the repo has none, or `[team]` picks it
   * (KERNEL-397). Its `file` is ''. Nothing is written to the repo until the user customizes it.
   */
  builtIn?: 'lead' | 'reviewer'
  /** The room's reviewer. Left out on agents Kernel didn't resolve, so read it with `isReviewer` (`@shared/team`). */
  reviewer?: boolean
  /** Whether the Lead can hand this agent a task. Left out on agents Kernel didn't resolve, so read it with `takesTasks`. */
  member?: boolean
  /** What Team and Room setup flag about the file. */
  warnings?: AgentWarning[]
}

/**
 * Why Kernel flags an agent file (KERNEL-397):
 * - `no-description`: the Lead can't tell what to hand it.
 * - `cant-open-pr`: its tools line has no Bash, or no Edit or Write, so it doesn't take tasks.
 * - `second-lead`: another agent is marked Lead too, and won.
 * - `setting-missing`: `[team]` names an agent that isn't on the team. `detail` is the setting.
 * - `reserved-id`: the file uses an id Kernel's own agents use, so Kernel skips it.
 * - `duplicate-id`: another file has the same `name:`, so Kernel skips this one. `detail` is the file kept.
 * - `looks-like-lead`: its description says it leads, but nothing marks it Lead.
 */
export type AgentWarningKind = 'no-description' | 'cant-open-pr' | 'second-lead' | 'setting-missing' | 'reserved-id' | 'duplicate-id' | 'looks-like-lead'

export interface AgentWarning {
  kind: AgentWarningKind
  /** Shown on Team. Never sent anywhere. */
  detail?: string
}

/**
 * The `[team]` table in .kernel/settings.toml (KERNEL-397). Each key overrides what Kernel works out from the agent files,
 * so a room without one needs nothing written.
 */
export interface TeamConfig {
  /** An agent id, or `kernel-lead` for Kernel's Rowan. */
  lead?: string
  /** An agent id, `kernel-reviewer` for Kernel's Theo, or `none` for no reviewer. */
  reviewer?: string
  /** Agents that take tasks even though their tools can't open a PR. */
  members?: string[]
  /** Agents that never take tasks. */
  helpers?: string[]
}

/** A change to `[team]`. `null` removes the key, so Kernel works it out from the files again. */
export type TeamPatch = { [K in keyof TeamConfig]?: TeamConfig[K] | null }

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
