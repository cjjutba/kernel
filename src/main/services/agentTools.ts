import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { TOOL_KINDS } from '@shared/telemetry'

// What an agent file's `tools:` line lets the agent do (KERNEL-397).

/** `Bash(git:*)` is Bash, and Claude Code's older names are the tools that replaced them. */
const ALIASES: Record<string, string> = { Task: 'Agent', MultiEdit: 'Edit', LS: 'Glob', NotebookRead: 'Read', TodoRead: 'TodoWrite' }

/** A tools entry as the tool it names. */
export const toolName = (entry: string): string => {
  const name = entry.trim().replace(/\(.*$/, '').trim()
  return ALIASES[name] ?? name
}

/**
 * Whether an agent with these tools can take a task through to a pull request: it edits files and runs git and gh. No
 * tools line means every tool.
 */
export function canOpenPr(tools: string[] | undefined): boolean {
  if (!tools) return true
  const names = new Set(tools.map(toolName))
  return names.has('Bash') && (names.has('Edit') || names.has('Write'))
}

/**
 * Claude Code's own tools Kernel takes out of a session whose agent file leaves them out, so the model never reaches for them.
 * Write and Edit stay in: plan mode writes its plan to `~/.claude/plans` before it asks for approval, and without that file
 * the plan comes up empty (D-023). The gate lets them reach that folder only.
 */
const HIDEABLE = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent']

/** The tools that write a file, which every agent may still use for its plan. */
const WRITERS = ['Write', 'Edit', 'MultiEdit']

/**
 * Tools every agent keeps, whatever its file lists: plan mode and its approval, questions to the user, finding deferred
 * tools such as Kernel's own, skills, and the agent's task list. Kernel's `mcp__kernel__` tools are always allowed too.
 */
export const ALWAYS = ['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ToolSearch', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskOutput', 'TaskStop']

/** Tools that only reach a command Bash started. */
const BASH_COMPANIONS = ['BashOutput', 'KillShell', 'KillBash']

/** What an agent file's tools line lets a session use (KERNEL-397). */
export interface ToolPolicy {
  /** Built-in tools to leave out of the session. */
  hidden: string[]
  /** `input` is the call's input, which says where a write goes. */
  allows(tool: string, input?: unknown): boolean
}

/** A `.md` file right in Claude Code's plans folder, where plan mode writes its plan. */
const isPlanFile = (path: unknown, plans: string) => typeof path === 'string' && path.endsWith('.md') && dirname(resolve(path)) === plans && !!basename(path)

/**
 * The tools line as Claude Code reads it for a subagent: the tools it names, `Bash(git:*)` as Bash, `mcp__linear` or
 * `mcp__linear__*` for every tool of that server. Nothing for an agent with no tools line, which may use every tool.
 */
export function toolPolicy(tools: string[] | undefined, o: { plans?: string } = {}): ToolPolicy | undefined {
  if (!tools?.length) return undefined
  const plans = resolve(o.plans ?? join(homedir(), '.claude', 'plans'))
  const names = new Set(tools.map(toolName))
  const servers = new Set([...names].map((n) => n.split('__')).filter((p) => p[0] === 'mcp' && p[1] && (p.length === 2 || (p.length === 3 && p[2] === '*'))).map((p) => p[1]))
  // A background command's output and its stop belong to Bash.
  const listed = (tool: string) => tool.startsWith('mcp__kernel__') || ALWAYS.includes(tool) || names.has(toolName(tool))
    || (BASH_COMPANIONS.includes(tool) && names.has('Bash')) || (tool.startsWith('mcp__') && servers.has(tool.split('__')[1]))
  const allows = (tool: string, input?: unknown) => listed(tool) || (WRITERS.includes(tool) && isPlanFile((input as { file_path?: unknown } | undefined)?.file_path, plans))
  return { hidden: HIDEABLE.filter((t) => !listed(t)), allows }
}

/** A server the tools line names that the session doesn't have, and a connected one whose name contains it. */
export interface MissingServer { server: string; entry: string; suggestion?: string }

/**
 * The MCP servers a tools line names (`mcp__linear`, `mcp__linear__*`, `mcp__linear__get_issue`) that aren't among the
 * session's connected servers. Kernel's own server is always there. A server that failed or needs auth still counts as
 * connected: its name matches, so the gate lets its tools through and the problem is elsewhere.
 */
export function missingServers(tools: string[] | undefined, connected: string[]): MissingServer[] {
  const have = new Set(connected)
  const missing = new Map<string, MissingServer>()
  for (const entry of tools ?? []) {
    const p = toolName(entry).split('__')
    const server = p[0] === 'mcp' && p.length <= 3 ? p[1] : undefined
    if (!server || server === 'kernel' || have.has(server) || missing.has(server)) continue
    const suggestion = connected.find((c) => c !== 'kernel' && c.toLowerCase().includes(server.toLowerCase()))
    missing.set(server, { server, entry: toolName(entry), ...(suggestion ? { suggestion } : {}) })
  }
  return [...missing.values()]
}

/** A tool as usage data names it: a built-in by name, any MCP tool as `mcp`, since server names are the user's own. */
export const toolKind = (tool: string): (typeof TOOL_KINDS)[number] => {
  const name = toolName(tool)
  return (TOOL_KINDS as readonly string[]).includes(name) ? name as (typeof TOOL_KINDS)[number] : tool.startsWith('mcp__') ? 'mcp' : 'other'
}
