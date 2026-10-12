import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, McpServer } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { withStatus } from '../src/main/services/mcp'
import { probeClaudeMcp } from '../src/main/services/providers/claude'
import { saveRepoSettings } from '../src/main/services/settings'
import { tempRepo } from './helpers'

// KERNEL-464: Kernel checks a room's MCP servers with the SDK's mcpServerStatus() and keeps what every session reports.
// The SDK is scripted: each query() records its options, and its reads of mcpServerStatus() walk through `lists`.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; reads: number }[], lists: [] as unknown[][] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: any }) => {
    const call = { options, reads: 0 }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      supportedCommands: async () => [],
      mcpServerStatus: async () => sdk.lists[Math.min(call.reads++, sdk.lists.length - 1)]
    }
  }
}))

const server = (name: string, status: string, source: string, more: object = {}) => ({ name, status, scope: source === 'plugin' ? 'dynamic' : source, source, ...more })

async function until<T>(check: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

afterEach(() => { sdk.calls = []; sdk.lists = []; bus.removeAllListeners('push') })

describe('the MCP probe', () => {
  it("reads until two lists agree and none is pending, with the user's settings and no hooks, then stops Claude Code", async () => {
    const linear = server('linear', 'connected', 'user')
    sdk.lists = [
      [server('linear', 'pending', 'user'), server('plugin:github:github', 'pending', 'plugin')],
      [linear, server('claude.ai Gmail', 'pending', 'claudeai')],
      [linear, server('claude.ai Gmail', 'connected', 'claudeai')]
    ]
    const list = await probeClaudeMcp('/repo', { env: { PATH: '/bin' }, executable: '/bin/claude', denied: ['figma', 'figma'], every: 1 })
    expect(list).toEqual(sdk.lists[2])
    const [{ options, reads }] = sdk.calls
    expect(reads).toBe(4)
    expect(options).toMatchObject({ cwd: '/repo', settingSources: ['user', 'project', 'local'], persistSession: false, env: { PATH: '/bin' }, pathToClaudeCodeExecutable: '/bin/claude' })
    // No SessionStart hook of the user's, nor Kernel's own, fires for a check, and the room's switched-off servers never start.
    expect(options.settings).toEqual({ disableAllHooks: true, deniedMcpServers: [{ serverName: 'figma' }] })
    expect(options.abortController.signal.aborted).toBe(true)
  })

  it('gives the list as it stands once the time is up', async () => {
    sdk.lists = [[server('neon', 'pending', 'user')]]
    expect(await probeClaudeMcp('/repo', { env: {}, ms: 30, every: 5 })).toEqual([server('neon', 'pending', 'user')])
    expect(sdk.calls[0].options.settings).toEqual({ disableAllHooks: true })
  })
})

describe("a room's MCP servers", () => {
  it("puts each report on the server it names, by its name or its tools', and adds what only a report knows", () => {
    const found: McpServer[] = [{ name: 'linear', source: 'user', enabled: true }, { name: 'claude.ai Notion', source: 'user', enabled: true }, { name: 'linear', source: 'user', provider: 'codex', enabled: true }]
    const reports = [
      { name: 'linear', status: 'failed' as const, error: 'ENOENT', source: 'user' }, { name: 'claude_ai_Notion', status: 'connected' as const },
      { name: 'kernel', status: 'connected' as const, source: 'sdk' }, { name: 'claude.ai Gmail', status: 'needs-auth' as const, source: 'claudeai' },
      { name: 'acme', status: 'connected' as const, source: 'enterprise' }, { name: 'tmp', status: 'connected' as const, source: 'dynamic' }
    ]
    expect(withStatus(found, reports, ['claude.ai Gmail'])).toEqual([
      { name: 'linear', source: 'user', enabled: true, status: 'failed', error: 'ENOENT' }, { name: 'claude.ai Notion', source: 'user', enabled: true, status: 'connected' },
      { name: 'claude.ai Gmail', source: 'claudeai', enabled: false, status: 'needs-auth' }, { name: 'acme', source: 'managed', enabled: true, status: 'connected' }
    ])
    expect(withStatus(found, [{ name: 'linear', status: 'connected' }, { name: 'jira', status: 'pending' }], [], 'codex')).toEqual([
      { name: 'linear', source: 'user', provider: 'codex', enabled: true, status: 'connected' }, { name: 'jira', source: 'user', provider: 'codex', enabled: true, status: 'pending' }
    ])
  })

  async function room() {
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const repo = await tempRepo({ 'README.md': '# demo\n', '.mcp.json': JSON.stringify({ mcpServers: { figma: {} } }) })
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { linear: {}, neon: {} } }))
    await mkdir(join(home, '.codex'))
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.linear]\ncommand = "linear-mcp"\n')
    await saveRepoSettings(repo, { disabled: { mcp: ['figma'] } })
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home, claudeSettingsFile: join(home, 'claude-settings.json') })
    await k.start()
    k.store.saveRoom({ id: 'room', name: 'Invoices', path: repo, createdAt: 1 } as never)
    const pushes: Extract<PushEvent, { type: 'mcp' }>[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'mcp') pushes.push(e) })
    return { k, h: k.handlers(), repo, pushes }
  }

  const noor = { id: 'noor', name: 'Noor', role: 'Backend', description: 'APIs.', lead: false, prompt: '', file: '/r/noor.md', tools: ['Read', 'mcp__linear', 'mcp__claude_ai_Linear', 'mcp__neon', 'mcp__figma', 'mcp__slack', 'mcp__gmail'] } as AgentDef

  it('checks a room the first time its servers are listed, keeps what sessions report, and warns about what an agent lacks', async () => {
    const { k, h, pushes } = await room()
    sdk.lists = [[
      server('linear', 'connected', 'user'), server('neon', 'failed', 'user', { error: 'spawn neon ENOENT' }),
      server('claude.ai Linear', 'needs-auth', 'claudeai'), server('plugin:github:github', 'connected', 'plugin')
    ]]
    // Until a probe lists Claude's servers, a server no file names may be a claude.ai connector, so none is called missing.
    expect(await k.mcp.warnings('room', noor)).toEqual([{ kind: 'mcp-off', detail: 'figma' }])
    expect(await h['mcp.list']({ roomId: 'room' })).toEqual([
      { name: 'figma', source: 'project', enabled: false }, { name: 'linear', source: 'user', enabled: true }, { name: 'neon', source: 'user', enabled: true }
    ])
    const push = await until(() => pushes[0])
    const checked = [
      { name: 'figma', source: 'project', enabled: false }, { name: 'linear', source: 'user', enabled: true, status: 'connected' },
      { name: 'neon', source: 'user', enabled: true, status: 'failed', error: 'spawn neon ENOENT' }, { name: 'claude.ai Linear', source: 'claudeai', enabled: true, status: 'needs-auth' },
      { name: 'plugin:github:github', source: 'plugin', enabled: true, status: 'connected' }
    ]
    expect(push).toEqual({ type: 'mcp', roomId: 'room', provider: 'claude', servers: checked })
    expect(sdk.calls).toHaveLength(1)
    expect(sdk.calls[0].options).toMatchObject({ cwd: k.store.room('room')!.path, settings: { disableAllHooks: true, deniedMcpServers: [{ serverName: 'figma' }] } })
    // Listing again doesn't check again.
    expect(await h['mcp.list']({ roomId: 'room' })).toEqual(checked)
    expect(sdk.calls).toHaveLength(1)
    expect(await h['mcp.list']({ roomId: 'room', provider: 'codex' })).toEqual([{ name: 'linear', source: 'user', provider: 'codex', enabled: true }])

    // A session's report adds to what the room knows and takes nothing away. The same report again changes nothing.
    k.mcp.reported('room', 'claude', [{ name: 'neon', status: 'connected', source: 'user' }, { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }])
    k.mcp.reported('room', 'claude', [{ name: 'neon', status: 'connected', source: 'user' }])
    await until(() => pushes.length === 2)
    await new Promise((r) => setTimeout(r, 30))
    expect(pushes).toHaveLength(2)
    expect(pushes[1].servers.map((s) => [s.name, s.status])).toEqual([['figma', undefined], ['linear', 'connected'], ['neon', 'connected'], ['claude.ai Linear', 'needs-auth'], ['plugin:github:github', 'connected'], ['claude.ai Gmail', 'connected']])

    // The list is whole now: a server nothing names is missing, with a connected one whose name contains it offered.
    expect(await k.mcp.warnings('room', noor)).toEqual([
      { kind: 'mcp-needs-auth', detail: 'claude.ai Linear' }, { kind: 'mcp-off', detail: 'figma' },
      { kind: 'mcp-missing', detail: 'slack' }, { kind: 'mcp-missing', detail: 'gmail', suggestion: 'claude_ai_Gmail' }
    ])
    // Once the user confirms the alias, the agent's file reaches the connector.
    await saveRepoSettings(k.store.room('room')!.path, { mcp: { aliases: { gmail: 'claude_ai_Gmail' } } })
    expect((await k.mcp.warnings('room', noor)).map((w) => w.detail)).toEqual(['claude.ai Linear', 'figma', 'slack'])

    // A probe asked for waits, and its list replaces Claude's: a server gone from every file goes.
    sdk.lists = [[server('linear', 'connected', 'user'), server('neon', 'connected', 'user')]]
    expect((await h['mcp.list']({ roomId: 'room', probe: true })).map((s) => s.name)).toEqual(['figma', 'linear', 'neon'])
    expect(sdk.calls).toHaveLength(2)
    await k.stop()
  })
})
