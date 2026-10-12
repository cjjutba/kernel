import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { query, type AgentInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef } from '@shared/types'
import { agentFromFile, unreadableAgent } from './agents'
import { packagedClaude } from './providers/binary'
import { InputQueue, sessionEnv } from './providers/claude'

// Plugin agents (KERNEL-463). Claude Code names each one `<plugin>:<agent>` and lists it among its subagents, with a name, a
// description and a model. The prompt and tools are in the agent's file in the plugin's install folder, so Kernel reads
// that file. It never writes one.

/**
 * Claude Code's subagents as `supportedAgents()` lists them. Claude Code starts in `home` with only the user's settings,
 * where plugins are turned on, lists them and stops. No hook runs, no MCP server starts and no message is sent.
 */
export async function claudeAgents(home: string): Promise<AgentInfo[]> {
  const input = new InputQueue<SDKUserMessage>()
  const abort = new AbortController()
  try {
    const q = query({
      prompt: input,
      options: {
        cwd: home, settingSources: ['user'], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, persistSession: false,
        abortController: abort, env: sessionEnv(process.env, {}), pathToClaudeCodeExecutable: packagedClaude()
      }
    })
    return await within(q.supportedAgents(), 30_000)
  } finally {
    input.close()
    abort.abort()
  }
}

/**
 * Kernel's agent for each plugin agent in Claude Code's list, read from its file and marked `plugin`. One whose file Kernel
 * can't find or read is flagged on Team like any file Kernel can't read (KERNEL-451). Claude Code's own agents (Explore,
 * Plan) and personal and project agents have no colon in their names, so they are left out.
 */
export async function loadPluginAgents(list: AgentInfo[], home: string): Promise<AgentDef[]> {
  const installed = await installedPlugins(home)
  const read = new Map<string, Promise<AgentDef[]>>()
  return Promise.all(list.filter((a) => a.name.includes(':')).map(async (info): Promise<AgentDef> => {
    const plugin = info.name.slice(0, info.name.indexOf(':'))
    const short = info.name.slice(plugin.length + 1)
    const root = installed.get(plugin)
    if (!read.has(plugin)) read.set(plugin, root ? pluginFiles(root) : Promise.resolve([]))
    const def = (await read.get(plugin)!).find((a) => a.id === short) ?? { ...unreadableAgent(`${short}.md`, `Kernel couldn't find its file in the ${plugin} plugin`), file: '' }
    return { ...def, id: info.name, origin: 'plugin' }
  }))
}

/**
 * Each installed plugin's folder, by the plugin's name, from Claude Code's `installed_plugins.json`. An install for the user
 * wins over one for a single project, since the list comes from the user's settings.
 */
async function installedPlugins(home: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let data: { plugins?: Record<string, unknown> }
  try { data = JSON.parse(await readFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) } catch { return out }
  for (const [id, value] of Object.entries(data.plugins ?? {})) {
    const installs = (Array.isArray(value) ? value : [value]) as { scope?: unknown; installPath?: unknown }[]
    const pick = installs.find((i) => i?.scope === 'user' && typeof i.installPath === 'string') ?? installs.find((i) => typeof i?.installPath === 'string')
    const name = id.split('@')[0]
    if (pick && (!out.has(name) || pick.scope === 'user')) out.set(name, pick.installPath as string)
  }
  return out
}

/** The agent files in a plugin: its `agents` folder, and the files or folders its `plugin.json` lists under `agents`. */
async function pluginFiles(root: string): Promise<AgentDef[]> {
  const manifest = await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8').then((t) => JSON.parse(t) as { agents?: unknown }, () => ({ agents: undefined }))
  const listed = typeof manifest.agents === 'string' ? [manifest.agents] : Array.isArray(manifest.agents) ? manifest.agents.filter((p): p is string => typeof p === 'string') : []
  const files = new Set<string>()
  for (const path of [join(root, 'agents'), ...listed.map((p) => resolve(root, p))]) {
    // A path that leaves the plugin's folder isn't the plugin's file.
    if (!path.startsWith(root + sep)) continue
    if (path.endsWith('.md')) files.add(path)
    else for (const n of await readdir(path).catch(() => [] as string[])) if (n.endsWith('.md')) files.add(join(path, n))
  }
  const defs = await Promise.all([...files].map((file) => readFile(file, 'utf8').then((src) => agentFromFile(file, src), () => undefined)))
  return defs.filter((a): a is AgentDef => !!a)
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude Code didn't list its agents within ${ms / 1000} seconds.`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}
