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

/** Claude Code's own tools Kernel takes out of a session whose agent file leaves them out, so the model never reaches for them. */
const HIDEABLE = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent']

/**
 * Tools every agent keeps, whatever its file lists: plan mode and its approval, questions to the user, finding deferred
 * tools such as Kernel's own, skills, and the agent's task list. Kernel's `mcp__kernel__` tools are always allowed too.
 */
export const ALWAYS = ['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ToolSearch', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskOutput', 'TaskStop']

/** What an agent file's tools line lets a session use (KERNEL-397). */
export interface ToolPolicy {
  /** Built-in tools to leave out of the session. */
  hidden: string[]
  allows(tool: string): boolean
}

/**
 * The tools line as Claude Code reads it for a subagent: the tools it names, `Bash(git:*)` as Bash, `mcp__linear` or
 * `mcp__linear__*` for every tool of that server. Nothing for an agent with no tools line, which may use every tool.
 */
export function toolPolicy(tools: string[] | undefined): ToolPolicy | undefined {
  if (!tools?.length) return undefined
  const names = new Set(tools.map(toolName))
  const servers = new Set([...names].map((n) => n.split('__')).filter((p) => p[0] === 'mcp' && p[1] && (p.length === 2 || (p.length === 3 && p[2] === '*'))).map((p) => p[1]))
  const allows = (tool: string) => tool.startsWith('mcp__kernel__') || ALWAYS.includes(tool) || names.has(toolName(tool)) || (tool.startsWith('mcp__') && servers.has(tool.split('__')[1]))
  return { hidden: HIDEABLE.filter((t) => !allows(t)), allows }
}

/** A tool as usage data names it: a built-in by name, any MCP tool as `mcp`, since server names are the user's own. */
export const toolKind = (tool: string): (typeof TOOL_KINDS)[number] => {
  const name = toolName(tool)
  return (TOOL_KINDS as readonly string[]).includes(name) ? name as (typeof TOOL_KINDS)[number] : tool.startsWith('mcp__') ? 'mcp' : 'other'
}
