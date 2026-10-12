import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { McpServer, McpStatus, Provider } from '@shared/types'

// Which MCP servers a room's agents can reach, and whether each is working (KERNEL-464). Kernel only reads the files.

/** A server's name as its tools carry it, made the way Claude Code 2.1.292 makes it: `claude.ai Linear` is `claude_ai_Linear`. */
export function toolServerName(name: string): string {
  const out = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return name.startsWith('claude.ai ') ? out.replace(/_+/g, '_').replace(/^_|_$/g, '') : out
}

/** One server as a provider reported it. `source` is Claude Code's `source`, or its `scope` where a report has no source. */
export interface McpReport {
  name: string
  status: McpStatus
  error?: string
  source?: string
}

const STATUSES: readonly string[] = ['connected', 'pending', 'failed', 'needs-auth', 'disabled']

/** A status as Claude Code writes it, or undefined for one Kernel doesn't know. */
export const mcpStatus = (status: unknown): McpStatus | undefined => (typeof status === 'string' && STATUSES.includes(status) ? status as McpStatus : undefined)

/**
 * A Codex server's startup state as a status. `reauthenticationRequired` means the user has to sign in again. A cancelled
 * start says nothing about the server, so it is undefined.
 */
export function codexStatus(state: string, failureReason?: string | null): McpStatus | undefined {
  if (state === 'ready') return 'connected'
  if (state === 'starting') return 'pending'
  if (state === 'failed') return failureReason === 'reauthenticationRequired' ? 'needs-auth' : 'failed'
  return undefined
}

/** The names of an object's keys, or none when it isn't one. */
const keysOf = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [])

/**
 * The user's own servers for the repo in `~/.claude.json`, `projects[<path>].mcpServers`, which `claude mcp add` writes by
 * default. Claude Code keys a project by its folder, so the room's path is tried as given and with its links resolved.
 */
async function localServers(json: any, root: string): Promise<string[]> {
  const projects = json?.projects
  if (!projects || typeof projects !== 'object') return []
  const paths = [...new Set([root, resolve(root), await realpath(root).catch(() => root)])]
  for (const path of paths) if (projects[path]) return keysOf(projects[path].mcpServers)
  return []
}

/**
 * MCP servers a session in the room would load (KERNEL-464). For Claude Code: the user's entries for this repo in
 * `~/.claude.json`, the repo's `.mcp.json`, then the user's own list, the first one to name a server winning, as in Claude
 * Code. For Codex: `[mcp_servers]` in `config.toml` in `codexHome` (`~/.codex` unless Kernel runs an account's own home),
 * where `enabled = false` is a server Codex leaves off. Off ones come from the room's settings. A file that is missing or
 * doesn't parse adds nothing. Claude.ai connectors and plugin servers are in no file, so only a status report finds them.
 */
export async function discoverMcp(root: string, home: string, disabled: string[], o: { codexHome?: string } = {}): Promise<McpServer[]> {
  const json = async (path: string): Promise<any> => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }
  const [user, project] = await Promise.all([json(join(home, '.claude.json')), json(join(root, '.mcp.json'))])
  const out = new Map<string, McpServer>()
  const add = (names: string[], source: McpServer['source']) => { for (const name of names) if (!out.has(name)) out.set(name, { name, source, enabled: !disabled.includes(name) }) }
  add(await localServers(user, root), 'local')
  add(keysOf(project?.mcpServers), 'project')
  add(keysOf(user?.mcpServers), 'user')
  const codex = await codexServers(o.codexHome ?? join(home, '.codex'))
  return [...out.values(), ...codex.map(({ name, on }): McpServer => ({ name, source: 'user', provider: 'codex', enabled: !disabled.includes(name), ...(on ? {} : { status: 'disabled' }) }))]
}

/** `[mcp_servers]` in Codex's `config.toml`, each with whether Codex starts it. */
async function codexServers(codexHome: string): Promise<{ name: string; on: boolean }[]> {
  let table: unknown
  try { table = (parseToml(await readFile(join(codexHome, 'config.toml'), 'utf8')) as Record<string, unknown>).mcp_servers } catch { return [] }
  return keysOf(table).map((name) => ({ name, on: (table as Record<string, { enabled?: unknown }>)[name]?.enabled !== false }))
}

/** Where a server only a report names is defined. Kernel's own server (`sdk`) and ones a session adds itself are left out. */
function reportedSource(source: string | undefined): McpServer['source'] | undefined {
  if (source === 'enterprise') return 'managed'
  return source === 'user' || source === 'project' || source === 'local' || source === 'claudeai' || source === 'plugin' || source === 'managed' ? source : undefined
}

/**
 * The room's servers for one provider with what it last reported (KERNEL-464). A report matches a server by name, or by
 * the name its tools carry. Codex's `enabled = false` stays `disabled` until Codex says otherwise. A server only a report
 * names joins the list where its source is one a user can see: claude.ai's connectors, a plugin's servers, managed ones,
 * and any Codex reports.
 */
export function withStatus(found: McpServer[], reports: McpReport[], disabled: string[], provider: Provider = 'claude'): McpServer[] {
  const left = new Map(reports.filter((r) => r.name !== 'kernel').map((r) => [r.name, r]))
  const match = (name: string) => left.get(name) ?? [...left.values()].find((r) => toolServerName(r.name) === toolServerName(name))
  const out = found.filter((s) => (s.provider ?? 'claude') === provider).map((s) => {
    const r = match(s.name)
    if (!r) return s
    left.delete(r.name)
    return { ...s, status: r.status, ...(r.error ? { error: r.error } : {}) }
  })
  for (const r of left.values()) {
    // Codex says nothing of where a server comes from.
    const source = provider === 'codex' ? 'user' : reportedSource(r.source)
    if (!source) continue
    out.push({ name: r.name, source, ...(provider === 'codex' ? { provider } : {}), enabled: !disabled.includes(r.name), status: r.status, ...(r.error ? { error: r.error } : {}) })
  }
  return out
}
