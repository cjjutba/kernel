import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { McpAccount, McpAccountServer, McpServer, McpServerKind, McpStatus, Provider } from '@shared/types'

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
export async function codexServers(codexHome: string): Promise<{ name: string; on: boolean }[]> {
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

/** claude.ai's connector settings, where the account's owner adds a connector (KERNEL-646). */
export const CONNECT_URL = 'https://claude.ai/settings/connectors'

/** The longest reason `mcp.accounts` carries. */
const REASON_MAX = 160

/**
 * A provider's reason in one line (KERNEL-646): terminal codes out, the first line with something on it, spaces collapsed,
 * and cut at REASON_MAX characters. Undefined when nothing is left.
 */
export function oneLine(text: string | null | undefined): string | undefined {
  // Terminal codes go the way `plainText` (claudeToken.ts) takes them out, without loading the pty that file needs.
  const plain = (text ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '')
  const line = plain.split(/\r\n|\n|\r/).map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean)
  if (!line) return undefined
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1).trimEnd()}\u2026` : line
}

/** Where a Claude server comes from, by its name or the source Claude Code reports (KERNEL-646). */
export function claudeKind(name: string, source?: string): McpServerKind {
  if (name.startsWith('claude.ai ') || source === 'claudeai') return 'connector'
  if (name.startsWith('plugin:') || source === 'plugin') return 'plugin'
  return 'user'
}

const server = (name: string, kind: McpServerKind, rest: Omit<McpAccountServer, 'name' | 'kind' | 'connector'>): McpAccountServer => ({ name, kind, connector: kind === 'connector', ...rest })

/**
 * A Claude login's servers as `mcp.accounts` reports them (KERNEL-626), from a probe on it (`probeClaudeMcp`). A server
 * still starting when the probe gave up failed to start. A switched-off one is left out. A reason is one line (KERNEL-646).
 */
export function claudeAccountServers(list: { name: string; status: string; error?: string; scope?: string; source?: string }[]): McpAccountServer[] {
  return list.flatMap((s): McpAccountServer[] => {
    const kind = claudeKind(s.name, s.source ?? s.scope)
    if (s.status === 'connected') return [server(s.name, kind, { state: 'ready' })]
    if (s.status === 'needs-auth') return [server(s.name, kind, { state: 'needs-sign-in' })]
    if (s.status === 'failed') return [server(s.name, kind, { state: 'failed', error: oneLine(s.error) ?? 'It failed to start, and Claude Code gave no reason.' })]
    if (s.status === 'pending') return [server(s.name, kind, { state: 'failed', error: 'It was still starting after 30 seconds.' })]
    return []
  })
}

/** "vercel" for Codex's plugin id "vercel@claude-plugins-official". */
const pluginName = (id: string) => id.split('@')[0]

/**
 * A Codex home's servers as `mcp.accounts` reports them (KERNEL-626), from `mcpServerStatus/list` and, for one with no tools,
 * how its start went on a thread (`startup`, KERNEL-646). `notLoggedIn`, or a start that needs a new sign-in, is a server
 * waiting on its OAuth sign-in. One that listed tools or started is ready. A failed one carries Codex's reason in one line,
 * or what Kernel saw when Codex gave none. A server `config.toml` switches off (`off`) is not set up, and says so. Codex has
 * no claude.ai connectors, and a server from a plugin has a `pluginId`.
 */
export function codexAccountServers(list: { name: string; authStatus: string; runtimeStatus: string | null; pluginId?: string | null; tools: Record<string, unknown> | null }[], off: string[], startup: Record<string, { status: string; error?: string }> = {}): McpAccountServer[] {
  const out = list.map((s): McpAccountServer => {
    const kind: McpServerKind = s.pluginId ? 'plugin' : 'user'
    const started = startup[s.name]
    if (off.includes(s.name) || s.runtimeStatus === 'disabled') return server(s.name, kind, { state: 'not-set-up', note: 'Switched off in Codex\u2019s config.toml.' })
    if (s.authStatus === 'notLoggedIn' || s.runtimeStatus === 'authenticationRequired' || /\bcodex mcp login\b/.test(started?.error ?? '')) return server(s.name, kind, { state: 'needs-sign-in' })
    if (Object.keys(s.tools ?? {}).length || s.runtimeStatus === 'connected' || started?.status === 'ready') return server(s.name, kind, { state: 'ready' })
    const error = oneLine(started?.error)
      ?? (started?.status === 'starting' ? 'It was still starting after 30 seconds.' : undefined)
      ?? (started ? 'It failed to start, and Codex gave no reason.' : undefined)
      ?? (s.pluginId ? `Codex lists it from the ${pluginName(s.pluginId)} plugin but didn\u2019t start it.` : 'Codex listed no tools for it and didn\u2019t start it.')
    return server(s.name, kind, { state: 'failed', error })
  })
  const listed = new Set(list.map((s) => s.name))
  for (const name of off) if (!listed.has(name)) out.push(server(name, 'user', { state: 'not-set-up', note: 'Switched off in Codex\u2019s config.toml.' }))
  return out
}

/** A server's name with only its letters and digits, lowercased, so `plugin:vercel:vercel` meets `claude.ai Vercel`. */
const bare = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The claude.ai connector ready on an account that stands in for a plugin's server there, by name: Claude Code leaves out a
 * plugin's server that points where a connector of the account does (KERNEL-646.md). Undefined when none matches.
 */
function coveringConnector(plugin: string, on: McpAccountServer[]): string | undefined {
  const own = bare(plugin.split(':').at(-1) ?? plugin)
  return on.find((s) => s.kind === 'connector' && s.state === 'ready' && bare(s.name.slice('claude.ai '.length)) === own)?.name
}

/**
 * Every server any checked account of a provider has goes on each other checked account of it (KERNEL-626, KERNEL-646), so
 * no account lacks a row:
 * - a claude.ai connector is `not-set-up` with claude.ai's connector settings (`connectUrl`), since only the account's owner
 *   adds one there;
 * - a plugin's server that a ready connector of the account covers is `ready`, with a note naming it, and otherwise `not-set-up`;
 * - a server the user added is `not-set-up` until the next check, since Kernel shares it with every account.
 * Servers are sorted by name.
 */
export function withMissing(accounts: McpAccount[]): McpAccount[] {
  const seen = new Map<Provider, Map<string, McpServerKind>>()
  for (const a of accounts) for (const s of a.servers) {
    const kinds = seen.get(a.provider) ?? new Map<string, McpServerKind>()
    if (!kinds.has(s.name)) kinds.set(s.name, s.kind)
    seen.set(a.provider, kinds)
  }
  const tool = (p: Provider) => (p === 'claude' ? 'Claude Code' : 'Codex')
  return accounts.map((a) => {
    if (a.checkedAt === undefined) return a
    const has = new Set(a.servers.map((s) => s.name))
    const missing = [...seen.get(a.provider) ?? []].filter(([name]) => !has.has(name)).map(([name, kind]): McpAccountServer => {
      if (kind === 'connector') return server(name, kind, { state: 'not-set-up', note: 'claude.ai connectors are set up on claude.ai, for each account.', connectUrl: CONNECT_URL })
      if (kind === 'plugin') {
        const by = coveringConnector(name, a.servers)
        if (by) return server(name, kind, { state: 'ready', note: `Covered by ${by} on this account.` })
        return server(name, kind, { state: 'not-set-up', note: `${tool(a.provider)} didn\u2019t load its plugin on this account.` })
      }
      return server(name, kind, { state: 'not-set-up', note: 'Not on this account yet. Kernel shares it, so check again to pick it up.' })
    })
    return { ...a, servers: [...a.servers, ...missing].sort((x, y) => x.name.localeCompare(y.name)) }
  })
}
