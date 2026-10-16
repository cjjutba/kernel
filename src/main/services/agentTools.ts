import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { TOOL_KINDS } from '@shared/telemetry'
import type { AgentReach, AgentWarning, LeadMode, McpAccountServer, McpStatus } from '@shared/types'
import { toolServerName } from './mcp'

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

/** What a read-only session never gets, whatever its file's tools line says: every tool that writes a file (KERNEL-549). */
const READ_ONLY_OFF = [...WRITERS, 'NotebookEdit']

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
  /** Why the chat's mode refuses the tool, rather than the agent file: Hand off doesn't edit (KERNEL-770). */
  modeRefuses(tool: string): string | undefined
  /**
   * How much of an MCP server the session may reach. Kernel's own is always all of it. With `unlisted`, a server the tools
   * line leaves out counts as named, as in Bypass permissions with `unlisted_tools = "ask"` (bypass-allows-unlisted-mcp).
   * disallowedTools still takes away what it names, and a server the line names in part keeps only those tools.
   */
  server(name: string, o?: { unlisted?: boolean }): ServerAccess
}

/** None of a server, all of it but `except`, or only `only`, by the tool's name on that server. */
export type ServerAccess = { on: false } | { on: true; only?: string[]; except?: string[] }

/** What a chat with Kernel in Hand off hears when it tries to edit a file (KERNEL-770). */
export const HANDOFF_NO_EDIT = "This chat is in Hand off, so you don't edit files. Hand the change to a teammate with mcp__kernel__create_workspace, or tell the user they can switch this chat to Build here."

/** A `.md` file right in Claude Code's plans folder, where plan mode writes its plan. */
const isPlanFile = (path: unknown, plans: string) => typeof path === 'string' && path.endsWith('.md') && dirname(resolve(path)) === plans && !!basename(path)

/**
 * The project's `[mcp.aliases]` as tool names: each name agent files use, and the server's name as its tools carry it. An
 * alias to or from Kernel's own server, or `*`, is left out (KERNEL-464).
 */
function aliasMap(aliases: Record<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const [from, to] of Object.entries(aliases ?? {})) {
    const a = toolServerName(from.trim())
    const b = toolServerName(to.trim())
    if (a && b && a !== b && ![a, b].some((n) => n === 'kernel' || n === '*' || /^_+$/.test(n))) out.set(a, b)
  }
  return out
}

/** A line's entries, each MCP one followed by the same entry on the server its name stands for in this project (KERNEL-464). */
function withAliases(entries: string[], aliases: Map<string, string>): string[] {
  return entries.flatMap((entry) => {
    const name = toolName(entry)
    const e = mcpEntry(name)
    const to = e && aliases.get(e.server)
    return to ? [name, e.tool ? `mcp__${to}__${e.tool}` : `mcp__${to}`] : [name]
  })
}

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
 * `aliases` is the project's `[mcp.aliases]`: an entry naming `linear` names the server it stands for as well, in both lines
 * (KERNEL-464). `allow` is the project's `[agents.<id>] allow`: MCP servers the user let this agent use though its tools line
 * doesn't name them, which count as named unless disallowedTools takes them away (KERNEL-537). `readOnly` is a review chat's
 * (KERNEL-549): Edit, Write and NotebookEdit are out whatever the lines say, a plan file included. Bash stays, for git and gh.
 * `lead` is a chat with Kernel's mode (KERNEL-770). In Hand off, Edit, Write and NotebookEdit are out whatever the tools line
 * says, but Write and Edit still reach a plan file (D-023). In Build here, Edit and Write are in whatever the tools line says,
 * and disallowedTools can still take them away.
 */
export function toolPolicy(tools: string[] | undefined, o: { disallowed?: string[]; plans?: string; aliases?: Record<string, string>; allow?: string[]; readOnly?: boolean; lead?: LeadMode } = {}): ToolPolicy | undefined {
  if (!tools && !o.disallowed?.length && !o.readOnly && o.lead !== 'handoff') return undefined
  const allowed = new Set(withAliases((o.allow ?? []).map((s) => `mcp__${s}`), aliasMap(o.aliases)).map((e) => e.split('__')[1]))
  const plans = resolve(o.plans ?? join(homedir(), '.claude', 'plans'))
  const aliases = aliasMap(o.aliases)
  const line = tools && readLine(withAliases(tools, aliases))
  const off = readLine(withAliases(o.disallowed ?? [], aliases))
  const offAll = off.servers.has('*')
  const own = (tool: string) => tool.startsWith('mcp__kernel__') || ALWAYS.includes(tool)
  // A background command's output and its stop belong to Bash.
  // Build here grants the tools that write a file, which the Lead's tools line may leave out (KERNEL-770).
  const listed = (tool: string): boolean => !line || line.names.has(toolName(tool)) || (BASH_COMPANIONS.includes(tool) && listed('Bash')) || (o.lead === 'build' && WRITERS.includes(toolName(tool)))
    || (tool.startsWith('mcp__') && (line.servers.has(tool.split('__')[1]) || allowed.has(tool.split('__')[1])))
  const disallows = (tool: string): boolean => !own(tool) && ((!!o.readOnly && READ_ONLY_OFF.includes(toolName(tool))) || off.names.has(toolName(tool)) || (BASH_COMPANIONS.includes(tool) && disallows('Bash'))
    || (tool.startsWith('mcp__') && (offAll || off.servers.has(tool.split('__')[1]))))
  // Hand off only reaches a plan file, through `allows` below (KERNEL-770).
  const handoff = (tool: string) => o.lead === 'handoff' && READ_ONLY_OFF.includes(toolName(tool))
  const usable = (tool: string) => own(tool) || (listed(tool) && !disallows(tool) && !handoff(tool))
  const allows = (tool: string, input?: unknown) => usable(tool) || (!o.readOnly && WRITERS.includes(tool) && isPlanFile((input as { file_path?: unknown } | undefined)?.file_path, plans))
  const server = (name: string, so: { unlisted?: boolean } = {}): ServerAccess => {
    if (name === 'kernel') return { on: true }
    if (offAll || off.servers.has(name)) return { on: false }
    const except = off.tools.filter((t) => t.server === name).map((t) => t.tool)
    if (line && !line.servers.has(name) && !allowed.has(name)) {
      const only = line.tools.filter((t) => t.server === name && !except.includes(t.tool)).map((t) => t.tool)
      if (only.length) return { on: true, only }
      if (!so.unlisted) return { on: false }
    }
    return except.length ? { on: true, except } : { on: true }
  }
  // `mcp__*` can't go in the session's list: it would take Kernel's own server too. The gate refuses those calls instead.
  const named = [...[...off.servers].filter((s) => s !== '*' && s !== 'kernel').map((s) => `mcp__${s}`), ...off.tools.filter((t) => t.server !== 'kernel').map((t) => `mcp__${t.server}__${t.tool}`)]
  // A read-only session's writers go from its list too, so the model never reaches for them.
  const modeRefuses = (tool: string) => (handoff(tool) && !own(tool) ? HANDOFF_NO_EDIT : undefined)
  return { hidden: [...new Set([...HIDEABLE.filter((t) => !usable(t)), ...(o.readOnly ? READ_ONLY_OFF : []), ...named])], allows, disallows, modeRefuses, server }
}

/**
 * A server the tools line names that the session can't use. With no `status`, no server by its name, or by the name it
 * stands for in this project, is there, and `suggestion` is a usable one whose name contains it, as its tools name it.
 * Otherwise `name` is the server that is there and `status` why it can't be used: it `failed`, `needs-auth`, Claude Code or
 * Codex has it `disabled`, or the project switched it `off` (KERNEL-464).
 */
export interface MissingServer { server: string; entry: string; status?: 'failed' | 'needs-auth' | 'disabled' | 'off'; name?: string; suggestion?: string }

/** A server as `missingServers` reads it: its name, what its provider said, and whether the project has it on. */
export type KnownServer = { name: string; status?: McpStatus | string; enabled?: boolean }

/** Why a server can't be used, or undefined when it can. Pending and unknown servers count as there. */
const unusable = (s: KnownServer): MissingServer['status'] =>
  s.enabled === false ? 'off' : s.status === 'failed' || s.status === 'needs-auth' || s.status === 'disabled' ? s.status : undefined

/**
 * The MCP servers a tools line names (`mcp__linear`, `mcp__linear__*`, `mcp__linear__get_issue`) that the session can't
 * use. `servers` are the ones it knows of, by their names or their tools', a later entry for the same server winning.
 * Kernel's own server is always there. A server that failed, needs sign-in or is switched off no longer counts as there,
 * since its tools fail in the same way a missing one's do (amends KERNEL-397). `aliases` is the project's `[mcp.aliases]`.
 */
export function missingServers(tools: string[] | undefined, servers: KnownServer[], aliases?: Record<string, string>): MissingServer[] {
  const known = new Map(servers.map((s) => [toolServerName(s.name), s]))
  const alias = aliasMap(aliases)
  const missing = new Map<string, MissingServer>()
  for (const entry of tools ?? []) {
    const server = mcpEntry(toolName(entry))?.server
    // `mcp__*` names no server in a tools line.
    if (!server || server === '*' || server === 'kernel' || missing.has(server)) continue
    const there = [server, alias.get(server)].flatMap((n) => (n && known.get(n)) || [])
    if (there.some((s) => !unusable(s))) continue
    if (there.length) { missing.set(server, { server, entry: toolName(entry), status: unusable(there[0]), name: there[0].name }); continue }
    const suggestion = [...known.entries()].find(([n, s]) => n !== 'kernel' && !unusable(s) && n.toLowerCase().includes(server.toLowerCase()))?.[0]
    missing.set(server, { server, entry: toolName(entry), ...(suggestion ? { suggestion } : {}) })
  }
  return [...missing.values()]
}

/**
 * What an agent's tools line needs from the project's MCP servers that it doesn't have, as warnings for Team (KERNEL-464). A
 * missing server's `detail` is the name its file uses, else the server's own name. `complete` says the list holds every
 * server the agent could reach, so one it lacks is missing. Claude's isn't until a probe or a session has reported, since
 * claude.ai's connectors are in no file.
 */
export function mcpWarnings(tools: string[] | undefined, servers: KnownServer[], o: { aliases?: Record<string, string>; complete?: boolean } = {}): AgentWarning[] {
  const kind = { failed: 'mcp-failed', 'needs-auth': 'mcp-needs-auth', disabled: 'mcp-off', off: 'mcp-off' } as const
  return missingServers(tools, servers, o.aliases).flatMap((m): AgentWarning[] => {
    if (m.status) return [{ kind: kind[m.status], detail: m.name }]
    return o.complete ? [{ kind: 'mcp-missing', detail: m.server, ...(m.suggestion ? { suggestion: m.suggestion } : {}) }] : []
  })
}

/**
 * The servers an agent's tools line names that an account can't give it yet, as `mcp.accounts` has them (KERNEL-939): one
 * that needs a sign-in there, or that Kernel is still checking. A server is matched by its name or its tools', and through
 * the project's `[mcp.aliases]`. One that is ready under either name counts as there, and one the account doesn't list says
 * nothing, since the project's warnings cover it.
 */
export function accountSignIns(tools: string[] | undefined, servers: McpAccountServer[], aliases?: Record<string, string>): AccountSignIn[] {
  const known = new Map(servers.map((s) => [toolServerName(s.name), s]))
  const alias = aliasMap(aliases)
  const out = new Map<string, AccountSignIn>()
  for (const entry of tools ?? []) {
    const server = mcpEntry(toolName(entry))?.server
    if (!server || server === '*' || server === 'kernel') continue
    const there = [server, alias.get(server)].flatMap((n) => (n && known.get(n)) || [])
    if (there.some((s) => s.state === 'ready')) continue
    const waiting = there.find((s) => s.state === 'needs-sign-in' || s.state === 'checking')
    if (waiting && !out.has(waiting.name)) out.set(waiting.name, { name: waiting.name, state: waiting.state as AccountSignIn['state'] })
  }
  return [...out.values()]
}

/** A server an account can't give an agent yet (`accountSignIns`). */
export interface AccountSignIn { name: string; state: 'needs-sign-in' | 'checking' }

/**
 * The MCP servers an agent's tools line and disallowedTools reach in the project, and the ones the line names that it can't
 * use, for the new agent card and create_agent's result (KERNEL-476). A server is reached when the agent may use any of its tools
 * and nothing says it can't be used, so pending and unreported servers count, as in `missingServers`. A missing server is
 * only named once `complete` says the list is whole, as in `mcpWarnings`. Kernel's own server is never listed.
 */
export function serverReach(tools: string[] | undefined, servers: KnownServer[], o: { disallowed?: string[]; aliases?: Record<string, string>; complete?: boolean } = {}): AgentReach {
  const policy = toolPolicy(tools, { disallowed: o.disallowed, aliases: o.aliases })
  // One entry per server, a later one winning, as `missingServers` reads them.
  const known = new Map(servers.map((s) => [toolServerName(s.name), s]))
  const reach = [...known.entries()].filter(([n, s]) => n !== 'kernel' && !unusable(s) && (policy?.server(n).on ?? true)).map(([, s]) => s.name)
  const blocked = missingServers(tools, servers, o.aliases).flatMap((m): AgentReach['blocked'] => {
    if (m.status) return [{ name: m.name ?? m.server, why: m.status }]
    return o.complete ? [{ name: m.server, why: 'missing', ...(m.suggestion ? { suggestion: m.suggestion } : {}) }] : []
  })
  return { reach, blocked }
}

/** A tool as usage data names it: a built-in by name, any MCP tool as `mcp`, since server names are the user's own. */
export const toolKind = (tool: string): (typeof TOOL_KINDS)[number] => {
  const name = toolName(tool)
  return (TOOL_KINDS as readonly string[]).includes(name) ? name as (typeof TOOL_KINDS)[number] : tool.startsWith('mcp__') ? 'mcp' : 'other'
}
