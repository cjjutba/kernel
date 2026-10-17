import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, McpAccount, McpAccountServer, McpServer } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { claudeAccountServers, withStatus } from '../src/main/services/mcp'
import { readMcpSaved } from '../src/main/services/mcpSaved'
import { MCP_LAUNCH_CHECK_MS, started, woke } from '../src/main/features/wiring'
import { probeClaudeMcp } from '../src/main/services/providers/claude'
import { saveRepoSettings } from '../src/main/services/settings'
import { tempRepo } from './helpers'

// KERNEL-464: Kernel checks a project's MCP servers with the SDK's mcpServerStatus() and keeps what every session reports.
// The SDK is scripted: each query() records its options, and its reads of mcpServerStatus() walk through `lists`.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; reads: number }[], lists: [] as unknown[][], hang: false }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: any }) => {
    const call = { options, reads: 0 }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      supportedCommands: async () => [],
      mcpServerStatus: () => (sdk.hang ? new Promise(() => undefined) : Promise.resolve(sdk.lists[Math.min(call.reads++, sdk.lists.length - 1)]))
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

afterEach(() => { sdk.calls = []; sdk.lists = []; sdk.hang = false; vi.useRealTimers(); bus.removeAllListeners('push') })

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
    // No SessionStart hook of the user's, nor Kernel's own, fires for a check, and the project's switched-off servers never start.
    expect(options.settings).toEqual({ disableAllHooks: true, deniedMcpServers: [{ serverName: 'figma' }] })
    expect(options.abortController.signal.aborted).toBe(true)
  })

  it('gives the list as it stands once the time is up', async () => {
    sdk.lists = [[server('neon', 'pending', 'user')]]
    expect(await probeClaudeMcp('/repo', { env: {}, ms: 30, every: 5 })).toEqual([server('neon', 'pending', 'user')])
    expect(sdk.calls[0].options.settings).toEqual({ disableAllHooks: true })
  })
})

describe("a project's MCP servers", () => {
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
    expect(withStatus(found, [{ name: 'linear', status: 'connected' }, { name: 'sentry', status: 'pending' }], [], 'codex')).toEqual([
      { name: 'linear', source: 'user', provider: 'codex', enabled: true, status: 'connected' }, { name: 'sentry', source: 'user', provider: 'codex', enabled: true, status: 'pending' }
    ])
  })

  async function project() {
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const repo = await tempRepo({ 'README.md': '# demo\n', '.mcp.json': JSON.stringify({ mcpServers: { figma: {} } }) })
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { linear: {}, neon: {} } }))
    await mkdir(join(home, '.codex'))
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.linear]\ncommand = "linear-mcp"\n')
    await saveRepoSettings(repo, { disabled: { mcp: ['figma'] } })
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home, claudeSettingsFile: join(home, 'claude-settings.json') })
    await k.start()
    k.store.saveProject({ id: 'project', name: 'Invoices', path: repo, createdAt: 1 } as never)
    const pushes: Extract<PushEvent, { type: 'mcp' }>[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'mcp') pushes.push(e) })
    return { k, h: k.handlers(), repo, pushes }
  }

  const sean = { id: 'sean', name: 'Sean', role: 'Backend', description: 'APIs.', lead: false, prompt: '', file: '/r/sean.md', tools: ['Read', 'mcp__linear', 'mcp__claude_ai_Linear', 'mcp__neon', 'mcp__figma', 'mcp__slack', 'mcp__gmail'] } as AgentDef

  it('checks a project the first time its servers are listed, keeps what sessions report, and warns about what an agent lacks', async () => {
    const { k, h, pushes } = await project()
    sdk.lists = [[
      server('linear', 'connected', 'user'), server('neon', 'failed', 'user', { error: 'spawn neon ENOENT' }),
      server('claude.ai Linear', 'needs-auth', 'claudeai'), server('plugin:github:github', 'connected', 'plugin')
    ]]
    // Until a probe lists Claude's servers, a server no file names may be a claude.ai connector, so none is called missing.
    expect(await k.mcp.warnings('project', sean)).toEqual([{ kind: 'mcp-off', detail: 'figma' }])
    expect(await h['mcp.list']({ projectId: 'project' })).toEqual([
      { name: 'figma', source: 'project', enabled: false }, { name: 'linear', source: 'user', enabled: true }, { name: 'neon', source: 'user', enabled: true }
    ])
    const push = await until(() => pushes[0])
    const checked = [
      { name: 'figma', source: 'project', enabled: false }, { name: 'linear', source: 'user', enabled: true, status: 'connected' },
      { name: 'neon', source: 'user', enabled: true, status: 'failed', error: 'spawn neon ENOENT' }, { name: 'claude.ai Linear', source: 'claudeai', enabled: true, status: 'needs-auth' },
      { name: 'plugin:github:github', source: 'plugin', enabled: true, status: 'connected' }
    ]
    expect(push).toEqual({ type: 'mcp', projectId: 'project', provider: 'claude', servers: checked })
    expect(sdk.calls).toHaveLength(1)
    expect(sdk.calls[0].options).toMatchObject({ cwd: k.store.project('project')!.path, settings: { disableAllHooks: true, deniedMcpServers: [{ serverName: 'figma' }] } })
    // Listing again doesn't check again.
    expect(await h['mcp.list']({ projectId: 'project' })).toEqual(checked)
    expect(sdk.calls).toHaveLength(1)
    expect(await h['mcp.list']({ projectId: 'project', provider: 'codex' })).toEqual([{ name: 'linear', source: 'user', provider: 'codex', enabled: true }])

    // A session's report adds to what the project knows and takes nothing away. The same report again changes nothing.
    k.mcp.reported('project', 'claude', [{ name: 'neon', status: 'connected', source: 'user' }, { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }])
    k.mcp.reported('project', 'claude', [{ name: 'neon', status: 'connected', source: 'user' }])
    await until(() => pushes.length === 2)
    await new Promise((r) => setTimeout(r, 30))
    expect(pushes).toHaveLength(2)
    expect(pushes[1].servers.map((s) => [s.name, s.status])).toEqual([['figma', undefined], ['linear', 'connected'], ['neon', 'connected'], ['claude.ai Linear', 'needs-auth'], ['plugin:github:github', 'connected'], ['claude.ai Gmail', 'connected']])

    // The list is whole now: a server nothing names is missing, with a connected one whose name contains it offered.
    expect(await k.mcp.warnings('project', sean)).toEqual([
      { kind: 'mcp-needs-auth', detail: 'claude.ai Linear' }, { kind: 'mcp-off', detail: 'figma' },
      { kind: 'mcp-missing', detail: 'slack' }, { kind: 'mcp-missing', detail: 'gmail', suggestion: 'claude_ai_Gmail' }
    ])
    // Once the user confirms the alias, the agent's file reaches the connector.
    await saveRepoSettings(k.store.project('project')!.path, { mcp: { aliases: { gmail: 'claude_ai_Gmail' } } })
    expect((await k.mcp.warnings('project', sean)).map((w) => w.detail)).toEqual(['claude.ai Linear', 'figma', 'slack'])

    // A probe asked for waits, and its list replaces Claude's: a server gone from every file goes.
    sdk.lists = [[server('linear', 'connected', 'user'), server('neon', 'connected', 'user')]]
    expect((await h['mcp.list']({ projectId: 'project', probe: true })).map((s) => s.name)).toEqual(['figma', 'linear', 'neon'])
    expect(sdk.calls).toHaveLength(2)
    await k.stop()
  })
})

// KERNEL-936: each account's last check is saved, `mcp.accounts` answers at once with it, and each check is pushed as it ends.
describe("every account's MCP servers, saved and checked in the background", () => {
  const account = (id: string, provider: 'claude' | 'codex' = 'claude') => ({ provider, id, label: id, auth: 'subscription', signedIn: true }) as never
  const ready = (name: string) => ({ name, kind: 'user', connector: false, state: 'ready' }) as McpAccountServer
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /**
   * A Kernel that isn't started, with `rows` as its signed-in accounts and a fake check: each account's servers after its own
   * delay. `saved` is written to `mcp-accounts.json` first.
   */
  async function accounts(rows: string[], o: { saved?: string; checkMcp?: boolean; probe?: (id: string) => Promise<McpAccountServer[]> } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    if (o.saved !== undefined) await writeFile(join(dataDir, 'mcp-accounts.json'), o.saved)
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), ...(o.checkMcp ? { checkMcp: true } : {}) })
    vi.spyOn(k.providers, 'list').mockImplementation(async () => rows.map((id) => account(id)))
    const checks = vi.spyOn(k.providers, 'mcpServersOn').mockImplementation(async (_p, id) => (o.probe ? o.probe(id) : [ready('linear')]))
    const pushes: { at: number; accounts: McpAccount[] }[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'mcp.accounts') pushes.push({ at: Date.now(), accounts: e.accounts }) })
    const file = async () => JSON.parse(await readFile(join(dataDir, 'mcp-accounts.json'), 'utf8'))
    return { k, h: k.handlers(), checks, pushes, file, dataDir }
  }

  it('answers at once with the saved checks, marked checking, then pushes each account as its check ends, and saves no token', async () => {
    const saved = { version: 1, accounts: [{ provider: 'claude', accountId: 'cli', checkedAt: 1000, servers: [{ ...ready('linear'), state: 'needs-sign-in' }] }] }
    const { k, h, pushes, file } = await accounts(['cli', 'side'], { saved: JSON.stringify(saved), probe: async (id) => { await sleep(id === 'cli' ? 300 : 600); return [ready('linear')] } })
    const start = Date.now()
    const first = await h['mcp.accounts'](undefined)
    expect(Date.now() - start).toBeLessThan(100)
    expect(first.map((a) => [a.accountId, a.checking, a.checkedAt, a.servers.map((s) => s.state)])).toEqual([['cli', true, 1000, ['needs-sign-in']], ['side', true, undefined, []]])
    // One push for the start, then one per account as its own check ends.
    await until(() => pushes.length === 3)
    const [, cli, side] = pushes.map((p) => p.accounts)
    expect(cli.map((a) => [a.accountId, a.checking, a.servers.map((s) => s.state)])).toEqual([['cli', undefined, ['ready']], ['side', true, []]])
    expect(side.map((a) => [a.accountId, a.checking, a.servers.map((s) => s.state)])).toEqual([['cli', undefined, ['ready']], ['side', undefined, ['ready']]])
    await k.mcp.saved()
    const written = await file()
    expect(written.version).toBe(1)
    expect(written.accounts.map((a: { accountId: string; servers: unknown[] }) => [a.accountId, a.servers])).toEqual([['cli', [ready('linear')]], ['side', [ready('linear')]]])
    // Opening the page again checks nothing.
    expect((await h['mcp.accounts'](undefined)).every((a) => !a.checking)).toBe(true)
    await k.stop({ budgetMs: 0 })
  })

  it('pushes an account whose check takes a second without waiting for one that takes five', async () => {
    const { k, h, pushes } = await accounts(['fast', 'slow'], { probe: async (id) => { await sleep(id === 'fast' ? 1000 : 5000); return [ready('linear')] } })
    const start = Date.now()
    await h['mcp.accounts'](undefined)
    const pushed = await until(() => pushes.find((p) => p.accounts.find((a) => a.accountId === 'fast')?.checkedAt))
    expect(pushed.at - start).toBeGreaterThanOrEqual(950)
    expect(pushed.at - start).toBeLessThan(2500)
    expect(pushed.accounts.find((a) => a.accountId === 'slow')?.checking).toBe(true)
    await k.stop({ budgetMs: 0 })
  })

  it('checks a Ready account again on focus once its last check is 5 minutes old, and not before', async () => {
    const { k, h, checks } = await accounts(['cli'])
    const now = Date.now()
    expect((await k.mcp.accounts({ wait: true }))[0]).toMatchObject({ ready: 1, needsYou: 0 })
    checks.mockClear()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 4 * 60_000)
    await h['mcp.recheck'](undefined)
    expect(checks).not.toHaveBeenCalled()
    clock.mockReturnValue(now + 5 * 60_000 + 1000)
    const back = await k.mcp.recheck({ wait: true })
    expect(checks.mock.calls).toEqual([['claude', 'cli']])
    expect(back[0].checkedAt).toBe(now + 5 * 60_000 + 1000)
    clock.mockRestore()
    await k.stop({ budgetMs: 0 })
  })

  it('counts a saved check older than 5 minutes as due on focus', async () => {
    const saved = { version: 1, accounts: [{ provider: 'claude', accountId: 'cli', checkedAt: Date.now() - 6 * 60_000, servers: [ready('linear')] }] }
    const { k, checks } = await accounts(['cli'], { saved: JSON.stringify(saved) })
    await k.mcp.recheck({ wait: true })
    expect(checks.mock.calls).toEqual([['claude', 'cli']])
    await k.stop({ budgetMs: 0 })
  })

  it('ignores a saved file that is corrupt or of another format version', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-data-')), 'mcp-accounts.json')
    for (const text of ['{"version":1,"accounts":[', JSON.stringify({ version: 2, accounts: [{ provider: 'claude', accountId: 'cli', servers: [] }] }), JSON.stringify({ accounts: [] }), 'null']) {
      await writeFile(file, text)
      expect(readMcpSaved(file)).toEqual([])
    }
    expect(readMcpSaved(join(tmpdir(), 'no-such-folder', 'mcp-accounts.json'))).toEqual([])
    const { k, h } = await accounts(['cli'], { saved: '{not json' })
    expect((await h['mcp.accounts'](undefined)).map((a) => [a.accountId, a.checkedAt, a.checking])).toEqual([['cli', undefined, true]])
    await k.stop({ budgetMs: 0 })
  })

  // KERNEL-939: a session's own report corrects the account it runs on, which a hand-off then reads.
  it('takes what a session on an account says at once, saved and pushed, and a check that started before does not undo it', async () => {
    let release = () => {}
    let held: Promise<void> | undefined
    const saved = { version: 1, accounts: [{ provider: 'claude', accountId: 'cli', checkedAt: 1000, servers: [ready('porkbun')] }, { provider: 'claude', accountId: 'side', checkedAt: 1000, servers: [ready('linear'), ready('porkbun')] }] }
    const { k, pushes, file } = await accounts(['cli', 'side'], { saved: JSON.stringify(saved), probe: async () => { await held; return [ready('linear'), { ...ready('porkbun'), state: 'needs-sign-in' }] } })
    const states = (list: McpAccount[], id: string) => list.find((a) => a.accountId === id)?.servers.map((s) => [s.name, s.state])
    k.mcp.reported('project', 'claude', [
      { name: 'porkbun', status: 'needs-auth', source: 'user' }, { name: 'kernel', status: 'connected', source: 'sdk' }, { name: 'neon', status: 'failed', source: 'user' }
    ], { account: 'side' })
    const pushed = await until(() => pushes[0])
    expect(states(pushed.accounts, 'side')).toEqual([['linear', 'ready'], ['porkbun', 'needs-sign-in']])
    // Every account lists every server of its provider, so cli shows linear, which it never had, as not set up.
    expect(states(pushed.accounts, 'cli')).toEqual([['linear', 'not-set-up'], ['porkbun', 'ready']])
    await k.mcp.saved()
    expect((await file()).accounts.find((a: { accountId: string }) => a.accountId === 'side').servers.map((s: McpAccountServer) => s.state)).toEqual(['ready', 'needs-sign-in'])
    // The same report again changes nothing, so nothing is pushed.
    k.mcp.reported('project', 'claude', [{ name: 'porkbun', status: 'needs-auth', source: 'user' }], { account: 'side' })
    await sleep(30)
    expect(pushes).toHaveLength(1)

    // A check starts, a session says porkbun is connected while it runs, and the check's older answer doesn't win.
    held = new Promise<void>((r) => { release = r })
    const checked = k.mcp.checkAccount('claude', 'side')
    await sleep(5)
    k.mcp.reported('project', 'claude', [{ name: 'porkbun', status: 'connected', source: 'user' }], { account: 'side' })
    release()
    await checked
    expect(states(await k.mcp.accounts(), 'side')).toEqual([['linear', 'ready'], ['porkbun', 'ready']])
    // The next check stands on its own.
    await k.mcp.checkAccount('claude', 'side')
    expect(states(await k.mcp.accounts(), 'side')).toEqual([['linear', 'ready'], ['porkbun', 'needs-sign-in']])

    // A session on the CLI's own login reports with no account id.
    k.mcp.reported('project', 'claude', [{ name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' }], { account: undefined })
    const cli = await until(() => pushes.find((p) => p.accounts.find((a) => a.accountId === 'cli')?.servers.some((s) => s.name === 'claude.ai Gmail'))?.accounts.find((a) => a.accountId === 'cli'))
    expect(cli.servers.find((s) => s.name === 'claude.ai Gmail')).toMatchObject({ kind: 'connector', connector: true, state: 'needs-sign-in' })
    await k.stop({ budgetMs: 0 })
  })

  it("names the servers an agent's tools line needs that its account can't give it yet, through the project's aliases", async () => {
    const saved = { version: 1, accounts: [{ provider: 'claude', accountId: 'cli', checkedAt: 1000, servers: [{ ...ready('porkbun'), state: 'needs-sign-in' }, ready('linear'), { ...ready('claude.ai Gmail'), kind: 'connector', connector: true, state: 'needs-sign-in' }, { ...ready('neon'), state: 'failed', error: 'ENOENT' }] }] }
    const { k } = await accounts(['cli'], { saved: JSON.stringify(saved) })
    // This Kernel isn't started, so it has no Settings, Models to pick the agent's provider from.
    vi.spyOn(k.team, 'pickFor').mockReturnValue({ provider: 'claude' } as never)
    const repo = await tempRepo({ 'README.md': '# demo\n' })
    await saveRepoSettings(repo, { mcp: { aliases: { gmail: 'claude_ai_Gmail' } } })
    k.store.saveProject({ id: 'project', name: 'Invoices', path: repo, createdAt: 1 } as never)
    const agent = (tools: string[]) => ({ id: 'sean', name: 'Sean', role: 'Backend', description: '', lead: false, prompt: '', file: '/r/sean.md', tools }) as AgentDef
    expect(await k.mcp.signInsFor('project', agent(['Read', 'mcp__porkbun__*', 'mcp__linear', 'mcp__gmail', 'mcp__neon', 'mcp__kernel']))).toEqual({
      account: 'Claude Code’s own login', servers: [{ name: 'porkbun', state: 'needs-sign-in' }, { name: 'claude.ai Gmail', state: 'needs-sign-in' }]
    })
    expect(await k.mcp.signInsFor('project', agent(['Read', 'mcp__linear']))).toBeUndefined()
    // A session saying porkbun works clears it.
    k.mcp.reported('project', 'claude', [{ name: 'porkbun', status: 'connected', source: 'user' }], { account: undefined })
    expect((await k.mcp.signInsFor('project', agent(['mcp__porkbun'])))).toBeUndefined()
    await k.stop({ budgetMs: 0 })
  })

  it('leaves a removed account out of the saved file, and a check running at the removal does not write it back', async () => {
    let release = () => {}
    const held = new Promise<void>((r) => { release = r })
    let ended = false
    const saved = { version: 1, accounts: [{ provider: 'claude', accountId: 'old', checkedAt: 1000, servers: [ready('linear')] }] }
    const { k, h, pushes, file } = await accounts(['cli', 'side'], { saved: JSON.stringify(saved), probe: async (id) => { if (id === 'side') { await held; ended = true } return [ready('linear')] } })
    await h['mcp.accounts'](undefined)
    await until(() => pushes.some((p) => p.accounts.find((a) => a.accountId === 'cli')?.checkedAt))
    // old was saved before it left, and side leaves while its check runs.
    k.mcp.forget('claude', 'old')
    k.mcp.forget('claude', 'side')
    release()
    await until(() => ended)
    await sleep(20)
    await k.mcp.saved()
    expect((await file()).accounts.map((a: { accountId: string }) => a.accountId)).toEqual(['cli'])
    await k.stop({ budgetMs: 0 })
  })

  // KERNEL-940: the edge cases, walked end to end.
  const agent = (tools: string[]) => ({ id: 'sean', name: 'Sean', role: 'Backend', description: '', lead: false, prompt: '', file: '/r/sean.md', tools }) as AgentDef
  const withProject = async (k: Kernel) => {
    vi.spyOn(k.team, 'pickFor').mockReturnValue({ provider: 'claude' } as never)
    k.store.saveProject({ id: 'project', name: 'Invoices', path: await tempRepo({ 'README.md': '# demo\n' }), createdAt: 1 } as never)
  }

  it('reads a sign-in that expired as needing one at the next focus check, and one done in a terminal as ready at the next, inside 5 minutes', async () => {
    let state: McpAccountServer['state'] = 'ready'
    const { k, checks } = await accounts(['cli'], { probe: async () => [{ ...ready('porkbun'), state }] })
    const at = Date.now()
    expect((await k.mcp.accounts({ wait: true }))[0]).toMatchObject({ ready: 1, needsYou: 0 })
    // Overnight the token died. The window comes back 6 minutes later.
    state = 'needs-sign-in'
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 6 * 60_000)
    expect((await k.mcp.recheck({ wait: true }))[0]).toMatchObject({ ready: 0, needsYou: 1 })
    // The user runs /mcp in a terminal. An account with something pending is checked on the next focus, and not before the 10 second throttle.
    state = 'ready'
    clock.mockReturnValue(at + 6 * 60_000 + 5_000)
    expect((await k.mcp.recheck({ wait: true }))[0]).toMatchObject({ ready: 0, needsYou: 1 })
    clock.mockReturnValue(at + 6 * 60_000 + 11_000)
    expect((await k.mcp.recheck({ wait: true }))[0]).toMatchObject({ ready: 1, needsYou: 0 })
    expect(checks).toHaveBeenCalledTimes(3)
    clock.mockRestore()
    await k.stop({ budgetMs: 0 })
  })

  // KERNEL-940 finding: a check that fails drops the account's servers and its checkedAt (checkAccount sets servers: [] and no
  // checkedAt), so Settings, MCP servers can't "show the servers from the last check" that the McpServersOffline fixture draws.
  // Remove `.fails` once the failed check keeps the last good result.
  it.fails('keeps the servers and the age of the last good check when a later check fails, as it does with the Mac offline', async () => {
    let offline = false
    const { k } = await accounts(['cli'], { probe: async () => { if (offline) throw new Error('Claude Code did not answer'); return [ready('linear')] } })
    const first = (await k.mcp.accounts({ wait: true }))[0]
    offline = true
    await k.mcp.checkAccount('claude', 'cli', { fresh: true })
    const after = (await k.mcp.accounts())[0]
    expect(after.error).toBe('Claude Code did not answer')
    expect(after.servers.map((x) => [x.name, x.state])).toEqual([['linear', 'ready']])
    expect(after.checkedAt).toBe(first.checkedAt)
    await k.stop({ budgetMs: 0 })
  })

  it('gives up on a Claude Code that never answers, as when a Keychain prompt waits, and never reads the account as Ready', async () => {
    vi.useFakeTimers()
    sdk.hang = true
    const read = probeClaudeMcp('/repo', { env: {}, every: 1 })
    const failed = expect(read).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
    expect(sdk.calls[0].options.abortController.signal.aborted).toBe(true)
    vi.useRealTimers()
    const { k } = await accounts(['cli'], { probe: async () => { throw new Error('Timed out after 15000ms') } })
    expect((await k.mcp.accounts({ wait: true }))[0]).toMatchObject({ error: 'Timed out after 15000ms', ready: 0, servers: [] })
    await k.stop({ budgetMs: 0 })
  })

  it('checks every account at launch and when the Mac wakes, and does neither in a Kernel that did not turn it on', async () => {
    const on = await accounts(['cli', 'side'], { checkMcp: true })
    vi.spyOn(on.k.prs, 'pollSoon').mockImplementation(() => undefined)
    vi.spyOn(on.k.account, 'checkLimits').mockResolvedValue(undefined as never)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    started(on.k)
    vi.advanceTimersByTime(MCP_LAUNCH_CHECK_MS - 1)
    expect(on.checks).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    await until(() => on.checks.mock.calls.length === 2)
    expect(on.checks.mock.calls).toEqual([['claude', 'cli'], ['claude', 'side']])
    // The Mac slept for hours and woke: Ready accounts are checked again.
    on.checks.mockClear()
    await woke(on.k)
    await until(() => on.checks.mock.calls.length === 2)
    await on.k.stop({ budgetMs: 0 })

    const off = await accounts(['cli'])
    vi.spyOn(off.k.prs, 'pollSoon').mockImplementation(() => undefined)
    vi.spyOn(off.k.account, 'checkLimits').mockResolvedValue(undefined as never)
    await woke(off.k)
    await sleep(30)
    expect(off.checks).not.toHaveBeenCalled()
    await off.k.stop({ budgetMs: 0 })
  })

  it('reads a server that is down or slow as failed and a missing sign-in as needing one, and a hand-off only names the second', async () => {
    const list = claudeAccountServers([
      { name: 'neon', status: 'failed', error: 'spawn neon ENOENT\n    at ChildProcess', source: 'user' }, { name: 'slow', status: 'pending', source: 'user' },
      { name: 'porkbun', status: 'needs-auth', source: 'user' }, { name: 'linear', status: 'connected', source: 'user' }, { name: 'figma', status: 'disabled', source: 'user' }
    ])
    expect(list.map((x) => [x.name, x.state])).toEqual([['neon', 'failed'], ['slow', 'failed'], ['porkbun', 'needs-sign-in'], ['linear', 'ready']])
    expect(list[0].error).toMatch(/^spawn neon ENOENT/)
    expect(list[0].error).not.toContain('\n')
    expect(list[1].error).toBe('It was still starting after 30 seconds.')
    const { k } = await accounts(['cli'], { probe: async () => list })
    await withProject(k)
    await k.mcp.accounts({ wait: true })
    expect(await k.mcp.signInsFor('project', agent(['mcp__neon', 'mcp__slow', 'mcp__porkbun']))).toEqual({ account: 'Claude Code’s own login', servers: [{ name: 'porkbun', state: 'needs-sign-in' }] })
    await k.stop({ budgetMs: 0 })
  })

  it('follows the account an agent runs on: one signed in to a server and one not, a switch by usage limits, and a key account on the CLI login', async () => {
    const states: Record<string, McpAccountServer['state']> = { cli: 'needs-sign-in', side: 'ready' }
    const { k } = await accounts(['cli', 'side'], { probe: async (id) => [{ ...ready('porkbun'), state: states[id] }] })
    await withProject(k)
    await k.mcp.accounts({ wait: true })
    const on = vi.spyOn(k.placement, 'accountFor')
    const auth = vi.spyOn(k.providers, 'auth').mockImplementation((_p, id) => (id === 'key' ? 'apiKey' : 'subscription'))
    const tools = agent(['mcp__porkbun'])
    on.mockReturnValue(undefined)
    expect((await k.mcp.signInsFor('project', tools))?.servers).toEqual([{ name: 'porkbun', state: 'needs-sign-in' }])
    // Usage limits move the agent to the account that is signed in.
    on.mockReturnValue('side')
    expect(await k.mcp.signInsFor('project', tools)).toBeUndefined()
    // An API key account has no login of its own, so its agents run on the CLI's sign-ins.
    on.mockReturnValue('key')
    expect((await k.mcp.signInsFor('project', tools))?.account).toBe('Claude Code’s own login')
    k.mcp.reported('project', 'claude', [{ name: 'porkbun', status: 'connected', source: 'user' }], { account: 'key' })
    expect(await k.mcp.signInsFor('project', tools)).toBeUndefined()
    expect((await k.mcp.accounts()).map((a) => [a.accountId, a.servers[0].state])).toEqual([['cli', 'ready'], ['side', 'ready']])
    auth.mockRestore()
    await k.stop({ budgetMs: 0 })
  })

  it('drops a renamed or removed server at the next check even with its sign-in still in the Keychain, and shows no row for it', async () => {
    const saved = { version: 1, accounts: [{ provider: 'claude', accountId: 'cli', checkedAt: 1000, servers: [ready('linear-old'), ready('neon')] }] }
    const { k, file } = await accounts(['cli'], { saved: JSON.stringify(saved), probe: async () => [ready('linear'), ready('neon')] })
    // A copied sign-in for the old name is still landed on the login.
    vi.spyOn(k.providers, 'mcpCheckingOn').mockReturnValue(['linear-old'])
    const states = (list: McpAccount[]) => list[0].servers.map((x) => [x.name, x.state])
    expect(states(await k.mcp.accounts({ wait: true }))).toEqual([['linear', 'ready'], ['neon', 'ready']])
    await k.mcp.saved()
    expect((await file()).accounts[0].servers.map((x: McpAccountServer) => x.name)).toEqual(['linear', 'neon'])
    await k.stop({ budgetMs: 0 })
  })

  it('keeps a claude.ai connector and a user server of the same name apart', async () => {
    const connector = (state: McpAccountServer['state']) => ({ ...ready('claude.ai Linear'), kind: 'connector', connector: true, state }) as McpAccountServer
    const { k } = await accounts(['cli'], { probe: async () => [{ ...ready('linear'), state: 'needs-sign-in' }, connector('ready')] })
    await withProject(k)
    await k.mcp.accounts({ wait: true })
    const states = async () => (await k.mcp.accounts())[0].servers.map((x) => [x.name, x.state])
    // The tools line names the user server or the connector, never both.
    expect(await k.mcp.signInsFor('project', agent(['mcp__linear']))).toMatchObject({ servers: [{ name: 'linear', state: 'needs-sign-in' }] })
    expect(await k.mcp.signInsFor('project', agent(['mcp__claude_ai_Linear']))).toBeUndefined()
    k.mcp.reported('project', 'claude', [{ name: 'claude.ai Linear', status: 'needs-auth', source: 'claudeai' }], { account: undefined })
    expect(await states()).toEqual([['claude.ai Linear', 'needs-sign-in'], ['linear', 'needs-sign-in']])
    k.mcp.reported('project', 'claude', [{ name: 'linear', status: 'connected', source: 'user' }], { account: undefined })
    expect(await states()).toEqual([['claude.ai Linear', 'needs-sign-in'], ['linear', 'ready']])
    expect(await k.mcp.signInsFor('project', agent(['mcp__claude_ai_Linear']))).toMatchObject({ servers: [{ name: 'claude.ai Linear', state: 'needs-sign-in' }] })
    await k.stop({ budgetMs: 0 })
  })

  it('reads the good accounts of a saved file with bad entries in it, and keeps no token a server entry carries', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-data-')), 'mcp-accounts.json')
    await writeFile(file, JSON.stringify({ version: 1, accounts: [
      { provider: 'claude', accountId: 'cli', checkedAt: 'yesterday', servers: [{ ...ready('linear'), accessToken: 'secret-token' }, { name: 'bad' }, 7, null] },
      { provider: 'gemini', accountId: 'x', servers: [] }, { provider: 'claude', servers: [] }, { provider: 'codex', accountId: 'cli', servers: 'none' }, null, 'x',
      { provider: 'codex', accountId: 'cli', checkedAt: 5, error: 'down', servers: [] }
    ] }))
    expect(readMcpSaved(file)).toEqual([{ provider: 'claude', accountId: 'cli', servers: [ready('linear')] }, { provider: 'codex', accountId: 'cli', checkedAt: 5, error: 'down', servers: [] }])
    expect(JSON.stringify(readMcpSaved(file))).not.toContain('secret-token')
  })
})
