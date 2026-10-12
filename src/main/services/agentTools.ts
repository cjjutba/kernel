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
 * tools line means every tool but those `disallowed` takes away.
 */
export function canOpenPr(tools: string[] | undefined, disallowed?: string[]): boolean {
  const has = (tool: string) => (!tools || tools.some((t) => toolName(t) === tool)) && !disallowed?.some((t) => toolName(t) === tool)
  return has('Bash') && (has('Edit') || has('Write'))
}

/** An entry's MCP server and tool. `mcp__linear` and `mcp__linear__*` name the whole server, which has no `tool`. */
const mcpEntry = (name: string): { server: string; tool?: string } | undefined => {
  const [prefix, server, ...rest] = name.split('__')
  if (prefix !== 'mcp' || !server) return undefined
  const tool = rest.join('__')
  return tool && tool !== '*' ? { server, tool } : { server }
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

/** What an agent file's tools line and disallowedTools let a session use (KERNEL-397, KERNEL-451). */
export interface ToolPolicy {
  /** Tools to leave out of the session: built-ins the file doesn't allow, and the MCP servers and tools it takes away by name. */
  hidden: string[]
  /** `input` is the call's input, which says where a write goes. */
  allows(tool: string, input?: unknown): boolean
  /** Whether the file's disallowedTools takes the tool away, rather than its tools line leaving it out. */
  disallows(tool: string): boolean
  /** How much of an MCP server the session may reach. Kernel's own is always all of it. */
  server(name: string): ServerAccess
}

/** None of a server, all of it but `except`, or only `only`, by the tool's name on that server. */
export type ServerAccess = { on: false } | { on: true; only?: string[]; except?: string[] }

/** A `.md` file right in Claude Code's plans folder, where plan mode writes its plan. */
const isPlanFile = (path: unknown, plans: string) => typeof path === 'string' && path.endsWith('.md') && dirname(resolve(path)) === plans && !!basename(path)

/** A tools or disallowedTools line as the tools it names, the servers it names whole, and the MCP tools it names one by one. */
function readLine(entries: string[]) {
  const names = new Set(entries.map(toolName))
  const mcp = [...names].map(mcpEntry).filter((e) => !!e)
  return { names, servers: new Set(mcp.filter((e) => !e.tool).map((e) => e.server)), tools: mcp.filter((e) => !!e.tool) as { server: string; tool: string }[] }
}

/**
 * The file's tools as Claude Code resolves a subagent's (KERNEL-451). The tools line keeps the tools it names, `Bash(git:*)`
 * as Bash, and `mcp__linear` or `mcp__linear__*` for every tool of that server, where `mcp__*` names nothing. With no tools
 * line every tool is in. disallowedTools then takes away what it names, the same way, and there `mcp__*` takes every MCP
 * server. Kernel's own tools and the session's stay whatever the file says. Nothing for a file that limits nothing.
 */
export function toolPolicy(tools: string[] | undefined, o: { disallowed?: string[]; plans?: string } = {}): ToolPolicy | undefined {
  if (!tools && !o.disallowed?.length) return undefined
  const plans = resolve(o.plans ?? join(homedir(), '.claude', 'plans'))
  const line = tools && readLine(tools)
  const off = readLine(o.disallowed ?? [])
  const offAll = off.servers.has('*')
  const own = (tool: string) => tool.startsWith('mcp__kernel__') || ALWAYS.includes(tool)
  // A background command's output and its stop belong to Bash.
  const listed = (tool: string): boolean => !line || line.names.has(toolName(tool)) || (BASH_COMPANIONS.includes(tool) && listed('Bash'))
    || (tool.startsWith('mcp__') && line.servers.has(tool.split('__')[1]))
  const disallows = (tool: string): boolean => !own(tool) && (off.names.has(toolName(tool)) || (BASH_COMPANIONS.includes(tool) && disallows('Bash'))
    || (tool.startsWith('mcp__') && (offAll || off.servers.has(tool.split('__')[1]))))
  const usable = (tool: string) => own(tool) || (listed(tool) && !disallows(tool))
  const allows = (tool: string, input?: unknown) => usable(tool) || (WRITERS.includes(tool) && isPlanFile((input as { file_path?: unknown } | undefined)?.file_path, plans))
  const server = (name: string): ServerAccess => {
    if (name === 'kernel') return { on: true }
    if (offAll || off.servers.has(name)) return { on: false }
    const except = off.tools.filter((t) => t.server === name).map((t) => t.tool)
    if (line && !line.servers.has(name)) {
      const only = line.tools.filter((t) => t.server === name && !except.includes(t.tool)).map((t) => t.tool)
      return only.length ? { on: true, only } : { on: false }
    }
    return except.length ? { on: true, except } : { on: true }
  }
  // `mcp__*` can't go in the session's list: it would take Kernel's own server too. The gate refuses those calls instead.
  const named = [...[...off.servers].filter((s) => s !== '*' && s !== 'kernel').map((s) => `mcp__${s}`), ...off.tools.filter((t) => t.server !== 'kernel').map((t) => `mcp__${t.server}__${t.tool}`)]
  return { hidden: [...HIDEABLE.filter((t) => !usable(t)), ...named], allows, disallows, server }
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
    const server = mcpEntry(toolName(entry))?.server
    // `mcp__*` names no server in a tools line.
    if (!server || server === '*' || server === 'kernel' || have.has(server) || missing.has(server)) continue
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
