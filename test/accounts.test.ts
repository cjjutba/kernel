import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountAddStep, AccountProfile, Chat, McpAccount, McpConnect, McpNeeded, McpSignInAll, McpSignInStep, RateLimit, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { limitProvider } from '@shared/providers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import type { KernelOptions } from '../src/main/features/options'
import { sessionEnv } from '../src/main/services/providers/claude'
import { USAGE_AFTER_TURN_MS } from '../src/main/features/providers'
import { sessionDeps } from '../src/main/features/sessionDeps'
import { credentialsItem } from '../src/main/services/providers/claudeHome'
import { joinLabels } from '@shared/waits'
import { fakeCodex } from './helpers/fakeCodex'
import { fakeClaude, LINK, MCP_LINK } from './helpers/fakeClaude'
import { fakeKeychain } from './helpers/fakeKeychain'
import { tempRepo } from './helpers'

// Claude Code's usage call, answered by the account each short session runs on: its CLAUDE_CONFIG_DIR, '' for the CLI's own
// login (KERNEL-567). `usage` holds each account's 5-hour use in percent. `mcp` holds the MCP servers each account lists
// (KERNEL-616), `*` for any added login not named. No Claude Code process starts.
const sdk = vi.hoisted(() => ({ usage: {} as Record<string, number>, mcp: {} as Record<string, { name: string; status: string; scope?: string }[]>, probes: [] as { dir: string; token?: string }[], reads: [] as string[], hold: undefined as Promise<void> | undefined }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: { env?: Record<string, string> } }) => {
    const dir = options.env?.CLAUDE_CONFIG_DIR ?? ''
    sdk.probes.push({ dir, ...(options.env?.CLAUDE_CODE_OAUTH_TOKEN ? { token: options.env.CLAUDE_CODE_OAUTH_TOKEN } : {}) })
    const window = (used: number) => ({ utilization: used, resets_at: new Date(Date.now() + 3600_000).toISOString() })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => {},
      mcpServerStatus: async () => sdk.mcp[dir] ?? (dir ? sdk.mcp['*'] : undefined) ?? [],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        sdk.reads.push(dir)
        await sdk.hold
        const used = sdk.usage[dir]
        if (used === undefined) throw new Error('not supported')
        return { rate_limits: { five_hour: window(used), seven_day: window(used / 2) } }
      }
    }
  }
}))

/** Encrypts by reversing, so a test can tell a stored token from the plain one. */
const cipher = { encrypt: (t: string) => `enc:${[...t].reverse().join('')}`, decrypt: (d: string) => [...d.slice(4)].reverse().join('') }

/** The starter agents the app ships, for Kernel's own Rowan. */
const STARTERS = join(__dirname, '..', 'docs', 'starter-agents')

async function until<T>(check: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let fake: Awaited<ReturnType<typeof fakeCodex>>
const saved = { log: process.env.FAKE_CODEX_LOG, codexHome: process.env.CODEX_HOME, claudeDir: process.env.CLAUDE_CONFIG_DIR }
beforeEach(async () => { fake = await fakeCodex(); process.env.FAKE_CODEX_LOG = fake.log; delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR; sdk.usage = {}; sdk.mcp = {}; sdk.probes = []; sdk.reads = []; sdk.hold = undefined })
afterEach(() => {
  // Assigning undefined would leave the string "undefined", and a read still running would log to a file of that name.
  if (saved.log === undefined) delete process.env.FAKE_CODEX_LOG; else process.env.FAKE_CODEX_LOG = saved.log
  if (saved.codexHome) process.env.CODEX_HOME = saved.codexHome
  if (saved.claudeDir) process.env.CLAUDE_CONFIG_DIR = saved.claudeDir
  bus.removeAllListeners('push')
})

async function kernel(o: Partial<KernelOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  const root = join(home, '.codex')
  await mkdir(join(root, 'skills', 'impeccable'), { recursive: true })
  await writeFile(join(root, 'config.toml'), 'model = "gpt-6-astra"\n')
  await writeFile(join(root, 'auth.json'), '{"cli":true}')
  const opened: string[] = []
  const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home, cipher, openExternal: async (url) => { opened.push(url) }, ...o })
  await k.start()
  await k.providers.setPath('codex', { path: fake.bin })
  return { k, home, root, opened }
}

describe('Codex accounts (KERNEL-406)', () => {
  it("gives an account a home of its own with only auth.json apart, and the rest linked to ~/.codex", async () => {
    const { k, root } = await kernel()
    const home = join(await mkdtemp(join(tmpdir(), 'kernel-acct-')), 'acct')
    await k.providers.linkCodexHome(home)
    expect((await lstat(join(home, 'config.toml'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(home, 'config.toml'))).toBe(join(root, 'config.toml'))
    expect(await readlink(join(home, 'skills'))).toBe(join(root, 'skills'))
    // Chat history, rules and plugins are shared even when ~/.codex had none yet.
    for (const dir of ['sessions', 'rules', 'plugins']) expect(await readlink(join(home, dir))).toBe(join(root, dir))
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    // What ~/.codex gains later is linked the next time.
    await writeFile(join(root, 'AGENTS.md'), '# me')
    await k.providers.linkCodexHome(home)
    expect(await readlink(join(home, 'AGENTS.md'))).toBe(join(root, 'AGENTS.md'))
    await k.stop()
  })

  it('adds an account with a ChatGPT sign-in in the browser, named by its email, and leaves the CLI login active until the user switches', async () => {
    const { k, opened } = await kernel()
    const steps: AccountAddStep[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.add') steps.push(e.add) })
    const added = await k.handlers()['accounts.add']({ provider: 'codex' })
    expect(added).toMatchObject({ provider: 'codex', label: 'chatgpt@example.com', email: 'chatgpt@example.com', plan: 'ChatGPT Plus', cli: false, active: false, signedIn: true })
    expect(opened).toEqual(['https://auth.openai.com/oauth/authorize?fake=1'])
    expect(steps.map((s) => s.step)).toEqual(['browser', 'done'])
    expect(existsSync(join(k.providers.codexHome(added.id)!, 'auth.json'))).toBe(true)
    const list = await k.handlers()['accounts.list']()
    expect(list.filter((a) => a.provider === 'codex').map((a) => [a.label, a.cli, a.active])).toEqual([['cj@example.com', true, true], ['chatgpt@example.com', false, false]])
    expect(k.providers.codexHome()).toBeUndefined()
    // The CLI's own row reads ~/.codex, whichever account is in use.
    await k.handlers()['accounts.switch']({ provider: 'codex', accountId: added.id })
    await rm(join(k.providers.codexHome(added.id)!, 'auth.json'))
    const after = (await k.handlers()['accounts.list']()).filter((a) => a.provider === 'codex')
    expect(after.map((a) => [a.cli, a.signedIn])).toEqual([[true, true], [false, false]])
    await k.stop()
  })

  it('runs Codex chats on the account switched to from their next start, keeping the thread', async () => {
    const { k } = await kernel()
    const added = await k.handlers()['accounts.add']({ provider: 'codex' })
    const repo = await tempRepo()
    const room = await k.addRoom(repo)
    const ws: Workspace = { id: 'ws', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'kernel-lead', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    k.store.saveWorkspace(ws)
    const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'c', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'low', plan: false, createdAt: 1 }
    k.store.saveChat(chat)
    await k.sessions.send('chat', [{ type: 'text', text: 'hi' }])
    await until(() => k.store.chat('chat')?.sessionId && !k.sessions.isRunning('chat'))
    const cwd = await realpath(repo)
    const started = async () => (await fake.messages()).filter((m) => 'started' in m && m.cwd === cwd).map((m) => m.started)
    expect(await started()).toEqual([null])
    await k.handlers()['accounts.switch']({ provider: 'codex', accountId: added.id })
    expect(k.providers.active('codex')).toBe(added.id)
    await k.sessions.send('chat', [{ type: 'text', text: 'again' }])
    await until(async () => (await started()).length === 2 && !k.sessions.isRunning('chat'))
    expect((await started())[1]).toBe(k.providers.codexHome(added.id))
    expect((await fake.messages()).filter((m) => m.method === 'thread/resume').map((m) => m.params.threadId)).toEqual(['thread-1'])
    await k.stop()
  })

  it('signs an added account out, and removes it back to the CLI login', async () => {
    const { k } = await kernel()
    const added = await k.handlers()['accounts.add']({ provider: 'codex' })
    await k.handlers()['accounts.switch']({ provider: 'codex', accountId: added.id })
    const out = await k.handlers()['accounts.signOut']({ provider: 'codex', accountId: added.id })
    expect(out.find((a) => a.id === added.id)).toMatchObject({ signedIn: false, active: true })
    const home = k.providers.codexHome(added.id)!
    const after = await k.handlers()['accounts.remove']({ provider: 'codex', accountId: added.id })
    expect(after.filter((a) => a.provider === 'codex').map((a) => a.id)).toEqual(['cli'])
    expect(k.providers.active('codex')).toBeUndefined()
    expect(existsSync(home)).toBe(false)
    await expect(k.handlers()['accounts.remove']({ provider: 'codex', accountId: 'cli' })).rejects.toThrow("can't be removed")
    await k.stop()
  })
})

describe('Claude accounts (KERNEL-567)', () => {
  const keys = ['FAKE_CODE_FILE', 'FAKE_EMAIL', 'FAKE_PLAN', 'FAKE_LOGIN_FAIL', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })

  /** A Kernel whose Claude is a fake CLI with its own login on Max, and a `~/.claude` and `~/.claude.json` as that login has them. */
  async function claudeKernel() {
    const t = await kernel()
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    const claude = await fakeClaude()
    await t.k.providers.setPath('claude', { path: claude.bin })
    await mkdir(join(t.home, '.claude', 'projects', '-repo'), { recursive: true })
    await writeFile(join(t.home, '.claude', 'settings.json'), '{"hooks":{}}')
    await writeFile(join(t.home, '.claude.json'), JSON.stringify({ mcpServers: { neon: { command: 'neon' } }, projects: { '/repo': {} }, oauthAccount: { emailAddress: 'cj@example.com' } }))
    const steps: AccountAddStep[] = []
    const pushed: AccountProfile[][] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.add') steps.push(e.add); if (e.type === 'accounts') pushed.push(e.accounts) })
    return { ...t, claude, h: t.k.handlers(), steps, pushed, dataDir: t.k.o.dataDir }
  }

  const claudeRows = async (h: ReturnType<Kernel['handlers']>) => (await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude')

  it('adds an account with only the browser sign-in, named by its email, with the plan read from it, which the defaults follow', async () => {
    const { k, h, steps, claude, home } = await claudeKernel()
    // A token the Mac exports never signs in for the account.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-from-the-mac'
    const added = await h['accounts.add']({ provider: 'claude' })
    expect(added).toEqual({ id: added.id, provider: 'claude', label: 'side@example.com', email: 'side@example.com', plan: 'Claude Pro', cli: false, auth: 'subscription', active: false, signedIn: true })
    expect(steps.map((s) => s.step)).toEqual(['browser', 'code', 'done'])
    expect(steps[0].url).toBe(LINK)
    const folder = k.providers.claudeHome(added.id)
    expect(await claude.logins()).toEqual({ cli: { email: 'cj@example.com', plan: 'max' }, [folder]: { email: 'side@example.com', plan: 'pro' } })
    const calls = await claude.calls()
    expect(calls.filter((c) => c.args === 'auth login').map((c) => c.dir)).toEqual([folder])
    expect(calls.filter((c) => c.dir === folder).some((c) => c.token)).toBe(false)
    // Linked right after the login, with the CLI login's MCP servers and its own login kept.
    expect(await readlink(join(folder, 'settings.json'))).toBe(join(home, '.claude', 'settings.json'))
    expect(await readlink(join(folder, 'projects'))).toBe(join(home, '.claude', 'projects'))
    expect(JSON.parse(await readFile(join(folder, '.claude.json'), 'utf8'))).toMatchObject({ oauthAccount: { emailAddress: 'side@example.com' }, mcpServers: { neon: { command: 'neon' } }, projects: { '/repo': {} } })
    // On the CLI's own login, the plan is the CLI's. Switched, the defaults follow the account's.
    await h['account.get'](undefined)
    expect(k.settings.plan).toBe('max')
    await h['accounts.switch']({ provider: 'claude', accountId: added.id })
    expect(await h['account.get'](undefined)).toMatchObject({ signedIn: true, name: 'side@example.com', email: 'side@example.com', plan: 'Claude Pro' })
    expect(k.settings.plan).toBe('pro')
    expect(await k.providers.status('claude')).toMatchObject({ signedIn: true, loginMethod: 'Claude account', plan: 'Claude Pro', email: 'side@example.com' })
    // An upgrade on claude.ai shows at the next read, and the defaults follow it.
    await claude.setLogin(folder, { email: 'side@example.com', plan: 'max' })
    await h['account.get'](undefined)
    expect(k.settings.plan).toBe('max')
    expect((await claudeRows(h)).find((a) => a.id === added.id)).toMatchObject({ plan: 'Claude Max' })
    await k.stop()
  })

  it('says why a sign-in failed, adds nothing, leaves no folder, and can be tried again', async () => {
    const { k, h, steps, dataDir } = await claudeKernel()
    process.env.FAKE_LOGIN_FAIL = '1'
    await expect(h['accounts.add']({ provider: 'claude' })).rejects.toThrow('Claude Code said: OAuth error: Request failed with status code 400')
    expect(steps.at(-1)).toMatchObject({ step: 'failed', error: 'Claude Code said: OAuth error: Request failed with status code 400' })
    expect(await claudeRows(h)).toHaveLength(1)
    expect(await readdir(join(dataDir, 'claude-homes'))).toEqual([])
    delete process.env.FAKE_LOGIN_FAIL
    expect(await h['accounts.add']({ provider: 'claude' })).toMatchObject({ label: 'side@example.com', plan: 'Claude Pro' })
    await k.stop()
  })

  it("runs the account's processes on its own folder, readied before each, and never on a token from the Mac", async () => {
    const { k, h, home } = await claudeKernel()
    const added = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(added.id)
    const deps = (k.sessions as unknown as { d: { claudeEnv: () => Record<string, string> } }).d
    expect(deps.claudeEnv()).toEqual({})
    await h['accounts.switch']({ provider: 'claude', accountId: added.id })
    // What ~/.claude gained since is linked, and the MCP servers are copied again.
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# me')
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { fal: { command: 'fal' } } }))
    expect(deps.claudeEnv()).toEqual({ CLAUDE_CONFIG_DIR: folder })
    expect(await readlink(join(folder, 'CLAUDE.md'))).toBe(join(home, '.claude', 'CLAUDE.md'))
    expect(JSON.parse(await readFile(join(folder, '.claude.json'), 'utf8'))).toEqual({ oauthAccount: { emailAddress: 'side@example.com' }, userID: 'u1', mcpServers: { fal: { command: 'fal' } } })
    const env = sessionEnv({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-mac', ANTHROPIC_API_KEY: 'sk-ant-api03-mac' }, deps.claudeEnv())
    expect(env).toMatchObject({ PATH: '/bin', CLAUDE_CONFIG_DIR: folder })
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    // A usage probe runs on the folder too.
    sdk.usage = { [folder]: 12 }
    await k.providers.readUsage({ force: true })
    expect(sdk.probes).toContainEqual({ dir: folder })
    await k.stop()
  })

  it("signs an added account out of its own folder only, signs it in again on its row, and removes it without touching ~/.claude", async () => {
    const { k, h, claude, home } = await claudeKernel()
    const added = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(added.id)
    await h['accounts.switch']({ provider: 'claude', accountId: added.id })
    await h['accounts.switch']({ provider: 'claude', accountId: 'cli' })
    const out = await h['accounts.signOut']({ provider: 'claude', accountId: added.id })
    expect(out.find((a) => a.id === added.id)).toMatchObject({ signedIn: false, active: false })
    expect(out.find((a) => a.cli && a.provider === 'claude')).toMatchObject({ signedIn: true })
    expect(await claude.logins()).toEqual({ cli: { email: 'cj@example.com', plan: 'max' } })
    // The user signed it out, so the Inbox doesn't say so.
    expect(k.notifications.list().filter((n) => n.title.endsWith('is signed out'))).toEqual([])
    await h['providers.signIn']({ provider: 'claude', accountId: added.id })
    expect((await claudeRows(h)).find((a) => a.id === added.id)).toMatchObject({ signedIn: true, active: false })
    const before = (await readdir(join(home, '.claude'), { recursive: true })).sort()
    await h['accounts.remove']({ provider: 'claude', accountId: added.id })
    expect(existsSync(folder)).toBe(false)
    expect((await readdir(join(home, '.claude'), { recursive: true })).sort()).toEqual(before)
    expect(await claude.logins()).toEqual({ cli: { email: 'cj@example.com', plan: 'max' } })
    // Every logout named the account's folder, so the CLI's own login was never signed out.
    expect((await claude.calls()).filter((c) => c.args === 'auth logout').map((c) => c.dir)).toEqual([folder, folder])
    await k.stop()
  })

  it('renames every account on both providers, the CLI logins included, keeps the names after a restart, and an empty name goes back to the email', async () => {
    const { k, h, claude, home, dataDir } = await claudeKernel()
    const side = await h['accounts.add']({ provider: 'claude' })
    const chatgpt = await h['accounts.add']({ provider: 'codex' })
    const p = k.providers as unknown as { load: () => { claude: { accounts: { id: string; label: string; auth?: 'apiKey'; createdAt: number }[] } }; save: () => Promise<void> }
    p.load().claude.accounts.push({ id: 'key', label: 'Work key', auth: 'apiKey', createdAt: 1 })
    await p.save()
    await h['accounts.rename']({ provider: 'claude', accountId: 'cli', label: ' Work ' })
    await h['accounts.rename']({ provider: 'claude', accountId: side.id, label: 'Personal' })
    await h['accounts.rename']({ provider: 'claude', accountId: 'key', label: 'Billing key' })
    await h['accounts.rename']({ provider: 'codex', accountId: 'cli', label: 'Codex work' })
    const renamed = await h['accounts.rename']({ provider: 'codex', accountId: chatgpt.id, label: 'Side' })
    const labels = (rows: AccountProfile[]) => rows.map((a) => `${a.provider}:${a.label}`)
    expect(labels(renamed)).toEqual(['claude:Work', 'claude:Personal', 'claude:Billing key', 'codex:Codex work', 'codex:Side'])
    await k.stop()
    const again = new Kernel({ dataDir, home, cipher })
    await again.start()
    await again.providers.setPath('claude', { path: claude.bin })
    await again.providers.setPath('codex', { path: fake.bin })
    const ha = again.handlers()
    expect(labels(await ha['accounts.list'](undefined))).toEqual(labels(renamed))
    await ha['accounts.rename']({ provider: 'claude', accountId: side.id, label: '  ' })
    const back = await ha['accounts.rename']({ provider: 'claude', accountId: 'cli', label: '' })
    expect(labels(back).slice(0, 2)).toEqual(['claude:cj@example.com', 'claude:side@example.com'])
    await again.stop()
  })

  it('reads the usage of every signed-in account without a turn, each on its own login, and holds only on the account in use', async () => {
    const { k, h, claude } = await claudeKernel()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    // Adding reads the new account's provider in the background.
    await until(() => new Set(sdk.probes.map((x) => x.dir)).size === 2)
    const chatgpt = await h['accounts.add']({ provider: 'codex' })
    const p = k.providers as unknown as { load: () => { claude: { accounts: { id: string; label: string; createdAt: number }[] } }; save: () => Promise<void> }
    p.load().claude.accounts.push({ id: 'legacy', label: 'Old', createdAt: 1 })
    await p.save()
    sdk.usage = { '': 30, [folder]: 95 }
    sdk.probes = []
    const limits = await k.providers.readUsage({ force: true })
    const hour = (provider: string) => limits.filter((l) => l.type === 'five_hour' && limitProvider(l) === provider).map((l) => [l.accountId ?? 'cli', l.utilization]).sort()
    expect(hour('claude')).toEqual([['cli', 0.3], [side.id, 0.95]].sort())
    expect(hour('codex')).toEqual([['cli', 0.4], [chatgpt.id, 0.4]].sort())
    // A legacy token account isn't read: its meters come from its turns.
    expect(sdk.probes.map((x) => x.dir).sort()).toEqual(['', folder])
    // The account in use is the CLI login, so the added account's 95% holds nothing.
    await k.config.setSettings({ usage: { pauseNearLimit: true } })
    expect(k.account.nearLimit('claude')).toBeUndefined()
    // Read in the last minute, so opening the account menu again reads nothing new.
    sdk.probes = []
    await h['usage.get'](undefined)
    expect(sdk.probes).toEqual([])
    // A signed-out account isn't asked.
    await claude.setLogin(folder, null)
    await k.providers.readUsage({ force: true })
    expect(sdk.probes.map((x) => x.dir)).toEqual([''])
    await k.stop()
  })

  it("answers usage.get with the windows it has at once, and pushes each account's fresh numbers when they arrive", async () => {
    const { k, h } = await claudeKernel()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    await until(() => new Set(sdk.probes.map((x) => x.dir)).size === 2)
    sdk.usage = { '': 30, [folder]: 10 }
    await k.providers.readUsage({ force: true })
    const hour = (limits: RateLimit[]) => limits.filter((l) => l.type === 'five_hour' && limitProvider(l) === 'claude').map((l) => [l.accountId ?? 'cli', l.utilization]).sort()
    // Claude Code takes its time answering, and nothing was read in the last minute.
    let release!: () => void
    sdk.hold = new Promise((resolve) => { release = resolve })
    sdk.usage = { '': 50, [folder]: 60 }
    sdk.probes = []
    ;(k.providers as unknown as { usageReadAt: Map<string, number> }).usageReadAt.clear()
    const pushed: RateLimit[][] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'usage') pushed.push(e.limits) })
    expect(hour(await h['usage.get'](undefined))).toEqual([['cli', 0.3], [side.id, 0.1]].sort())
    await until(() => sdk.probes.length === 2)
    expect(pushed).toEqual([])
    release()
    await until(() => pushed.length && JSON.stringify(hour(pushed.at(-1)!)) === JSON.stringify([['cli', 0.5], [side.id, 0.6]].sort()))
    await k.stop()
  })

  it('reads every account at once when the account in use nears its limit', async () => {
    const { k, h } = await claudeKernel()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    await until(() => sdk.probes.some((x) => x.dir === folder))
    sdk.usage = { '': 92, [folder]: 20 }
    sdk.probes = []
    const s = k.sessions as unknown as { mergeLimits: (l: Partial<RateLimit>[]) => void }
    s.mergeLimits([{ type: 'five_hour', utilization: 0.92, resetsAt: Math.round(Date.now() / 1000) + 3600 }])
    await until(() => sdk.probes.some((x) => x.dir === folder))
    // Once per crossing.
    s.mergeLimits([{ type: 'five_hour', utilization: 0.93, resetsAt: Math.round(Date.now() / 1000) + 3600 }])
    await new Promise((r) => setTimeout(r, 50))
    expect(sdk.probes.filter((x) => x.dir === folder)).toHaveLength(1)
    await k.stop()
  })

  /** A Claude chat in a room on a temp repo, whose turns `turnDone` finishes on `account` (KERNEL-673). */
  async function claudeChat(k: Kernel) {
    const room = await k.addRoom(await tempRepo())
    const ws: Workspace = { id: 'ws', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: room.path, mode: 'worktree', agentId: 'kernel-lead', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    k.store.saveWorkspace(ws)
    const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'c', kind: 'chat', provider: 'claude', model: 'opus', effort: 'low', plan: false, createdAt: 1 }
    k.store.saveChat(chat)
    return (account?: string) => sessionDeps(k).onTurnDone!(ws, chat, { ok: true, interrupted: false, by: 'user', account })
  }

  it('reads the usage of the account a turn ran on once for the turns that finish within a minute, and pushes it (KERNEL-673)', async () => {
    const { k, h } = await claudeKernel()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    await until(() => new Set(sdk.reads).size === 2)
    const turnDone = await claudeChat(k)
    sdk.usage = { '': 30, [folder]: 40 }
    sdk.reads = []
    // Adding the account read it a moment ago, which a minute's wait would leave behind.
    ;(k.providers as unknown as { usageReadAt: Map<string, number> }).usageReadAt.clear()
    const pushed: RateLimit[][] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'usage') pushed.push(e.limits) })
    // The read starts on a real tick, so the timers it sets aren't the fake ones.
    const read = k.providers.readUsage.bind(k.providers)
    const asked = vi.spyOn(k.providers, 'readUsage').mockImplementation((o) => new Promise((r) => setImmediate(r)).then(() => read(o)))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      for (let i = 0; i < 10; i++) { turnDone(side.id); vi.advanceTimersByTime(USAGE_AFTER_TURN_MS / 20) }
      vi.advanceTimersByTime(USAGE_AFTER_TURN_MS / 2 - 1)
      expect(asked).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
    } finally { vi.useRealTimers() }
    const mine = (limits: RateLimit[]) => limits.find((l) => l.type === 'five_hour' && limitProvider(l) === 'claude' && l.accountId === side.id)?.utilization
    await until(() => pushed.some((l) => mine(l) === 0.4))
    // Ten turns, one read, and only of the account they ran on.
    expect(asked.mock.calls).toEqual([[{ provider: 'claude', account: side.id }]])
    expect(sdk.reads).toEqual([folder])
    await k.stop()
  })

  it('keeps the last numbers when the read after a turn fails, and the turn ends as usual (KERNEL-673)', async () => {
    const { k } = await claudeKernel()
    const turnDone = await claudeChat(k)
    sdk.usage = { '': 30 }
    await k.providers.readUsage({ force: true })
    // Claude Code refuses the usage call for the CLI's own login.
    sdk.usage = {}
    sdk.reads = []
    ;(k.providers as unknown as { usageReadAt: Map<string, number> }).usageReadAt.clear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      expect(() => turnDone(undefined)).not.toThrow()
      vi.advanceTimersByTime(USAGE_AFTER_TURN_MS)
    } finally { vi.useRealTimers() }
    await until(() => sdk.reads.length)
    const hour = (await k.providers.readUsage()).filter((l) => l.type === 'five_hour' && limitProvider(l) === 'claude').map((l) => [l.accountId ?? 'cli', l.utilization])
    expect(hour).toEqual([['cli', 0.3]])
    expect(k.store.chat('chat')?.unreadAt).toBeTruthy()
    await k.stop()
  })

  it('saves one Inbox notice when an account signs out, and none again after a restart', async () => {
    const { k, h, claude, home, dataDir } = await claudeKernel()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    await h['accounts.rename']({ provider: 'claude', accountId: side.id, label: 'Personal' })
    await k.providers.readUsage({ force: true })
    const notices = (kk: Kernel) => kk.notifications.list().filter((n) => n.title.endsWith('is signed out'))
    expect(notices(k)).toEqual([])
    // Signed out on another Mac.
    await claude.setLogin(folder, null)
    await k.providers.readUsage({ force: true })
    expect((await claudeRows(h)).find((a) => a.id === side.id)?.signedIn).toBe(false)
    expect(notices(k)).toMatchObject([{ title: 'Personal is signed out', sub: 'Sign in again in Settings, Providers.', body: 'Personal is signed out. Sign in again in Settings, Providers.' }])
    await k.providers.readUsage({ force: true })
    expect(notices(k)).toHaveLength(1)
    await k.stop()
    const again = new Kernel({ dataDir, home, cipher })
    await again.start()
    await again.providers.setPath('claude', { path: claude.bin })
    await again.providers.setPath('codex', { path: fake.bin })
    await again.providers.readUsage({ force: true })
    expect(notices(again)).toHaveLength(1)
    // Signed in again in a terminal: the next read has it.
    await claude.setLogin(folder, { email: 'side@example.com', plan: 'pro' })
    await again.providers.readUsage({ force: true })
    expect((await claudeRows(again.handlers())).find((a) => a.id === side.id)?.signedIn).toBe(true)
    // Codex's do too.
    const chatgpt = await again.handlers()['accounts.add']({ provider: 'codex' })
    await again.handlers()['accounts.rename']({ provider: 'codex', accountId: chatgpt.id, label: 'Side' })
    await rm(join(again.providers.codexHome(chatgpt.id)!, 'auth.json'))
    await again.providers.readUsage({ force: true })
    expect(notices(again).map((n) => n.title)).toContain('Side is signed out')
    await again.stop()
  })

  it('signs the account in use out when a session is refused, lifts the hold once a read finds it signed in, and says so once a day', async () => {
    const { k, h } = await claudeKernel()
    const side = await h['accounts.add']({ provider: 'claude' })
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    const notices = () => k.notifications.list().filter((n) => n.title === 'side@example.com is signed out')
    k.account.signedOut('claude')
    await until(() => notices().length === 1)
    expect((await claudeRows(h)).find((a) => a.id === side.id)?.signedIn).toBe(false)
    expect(k.sessions.heldFor('claude')).toContain('auth')
    // Claude Code still reads the folder as signed in, so the next read lifts the hold.
    expect(await h['account.get'](undefined)).toMatchObject({ signedIn: true })
    expect(k.sessions.heldFor('claude')).not.toContain('auth')
    expect((await claudeRows(h)).find((a) => a.id === side.id)?.signedIn).toBe(true)
    // Refused again the same day: still the one notice.
    k.account.signedOut('claude')
    await until(async () => (await claudeRows(h)).find((a) => a.id === side.id)?.signedIn === false)
    expect(notices()).toHaveLength(1)
    await k.stop()
  })

  it('keeps a legacy token account running, and moves it to a full login on Sign in again with its id and nickname', async () => {
    const { k, h, claude } = await claudeKernel()
    const p = k.providers as unknown as { load: () => { claude: { accounts: object[] } }; save: () => Promise<void>; saveToken: (id: string, t?: string) => Promise<void>; tokensFile: string }
    p.load().claude.accounts.push({ id: 'old', label: 'Personal', plan: 'Claude Team', claudePlan: 'team', createdAt: 1 })
    await p.save()
    await p.saveToken('old', 'sk-ant-oat01-old')
    expect((await claudeRows(h)).find((a) => a.id === 'old')).toMatchObject({ label: 'Personal', plan: 'Claude Team', signedIn: true, usageFromTurns: true, legacyToken: true })
    await h['accounts.switch']({ provider: 'claude', accountId: 'old' })
    expect(k.providers.claudeEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-old' })
    expect(k.settings.plan).toBe('team')
    expect(k.providers.usageReads({ provider: 'claude' }).map((r) => r.accountId)).toEqual([undefined])
    process.env.FAKE_EMAIL = 'personal@example.com'
    process.env.FAKE_PLAN = 'max'
    await h['providers.signIn']({ provider: 'claude', accountId: 'old' })
    const row = (await claudeRows(h)).find((a) => a.id === 'old')
    expect(row).toEqual({ id: 'old', provider: 'claude', label: 'Personal', email: 'personal@example.com', plan: 'Claude Max', cli: false, auth: 'subscription', active: true, signedIn: true })
    expect(k.providers.claudeEnv()).toEqual({ CLAUDE_CONFIG_DIR: k.providers.claudeHome('old') })
    expect(JSON.parse(await readFile(p.tokensFile, 'utf8'))).toEqual({})
    expect(k.settings.plan).toBe('max')
    expect(k.providers.usageReads({ provider: 'claude' }).map((r) => r.accountId)).toEqual([undefined, 'old'])
    expect((await claude.logins()).cli).toEqual({ email: 'cj@example.com', plan: 'max' })
    await k.stop()
  })

  it('reads an account whose data folder moved as signed out, and Remove signs out the path it signed in with too', async () => {
    const { k, h, claude } = await claudeKernel()
    const old = '/Users/someone/old-data/claude-homes/moved'
    const p = k.providers as unknown as { load: () => { claude: { accounts: object[] } }; save: () => Promise<void> }
    p.load().claude.accounts.push({ id: 'moved', label: 'Personal', email: 'side@example.com', home: old, signedIn: true, createdAt: 1 })
    await p.save()
    await claude.setLogin(old, { email: 'side@example.com', plan: 'pro' })
    expect((await claudeRows(h)).find((a) => a.id === 'moved')?.signedIn).toBe(false)
    await h['accounts.remove']({ provider: 'claude', accountId: 'moved' })
    expect((await claude.calls()).filter((c) => c.args === 'auth logout').map((c) => c.dir)).toEqual([old, k.providers.claudeHome('moved')])
    expect(await claude.logins()).toEqual({ cli: { email: 'cj@example.com', plan: 'max' } })
    await k.stop()
  })

  it("reads the Claude account through Kernel's own executable, not the claude on the PATH (KERNEL-277)", async () => {
    const { k } = await kernel()
    const dir = await mkdtemp(join(tmpdir(), 'kernel-bin-'))
    const bin = join(dir, 'claude')
    await writeFile(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.292 (Claude Code)";; auth) echo '{"loggedIn":true,"email":"kernel@example.com","subscriptionType":"max"}';; esac\n`)
    await chmod(bin, 0o755)
    await k.providers.setPath('claude', { path: bin })
    expect(await k.readAccount()).toMatchObject({ signedIn: true, email: 'kernel@example.com', plan: 'Claude Max' })
    expect(await k.signedInReader()).toBe(true)
    await k.stop()
  })
})

describe('holds and limits per provider (KERNEL-406)', () => {
  async function twoChats() {
    const { k } = await kernel()
    const repo = await tempRepo({ '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const room = await k.addRoom(repo)
    await k.team.agents(room.id)
    const ws: Workspace = { id: 'ws', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'kai', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    k.store.saveWorkspace(ws)
    k.store.saveChat({ id: 'claude', workspaceId: 'ws', title: 'c', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    k.store.saveChat({ id: 'codex', workspaceId: 'ws', title: 'x', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'low', plan: false, createdAt: 2 })
    return { k, room }
  }

  it("holds only Claude's chats while Claude is signed out", async () => {
    const { k } = await twoChats()
    k.account.signedOut('claude')
    expect(k.sessions.heldFor()).toEqual(['auth'])
    expect(k.sessions.waitsFor('claude')).toBe('offline')
    expect(k.sessions.waitsFor('codex')).toBeUndefined()
    k.account.signedOut('codex')
    expect(k.sessions.waitsFor('codex')).toBe('offline')
    expect(k.sessions.heldFor('codex')).toEqual(['codex-auth'])
    // Offline holds everyone, whatever the provider.
    k.sessions.releaseAll('auth')
    k.sessions.releaseAll('codex-auth')
    k.sessions.holdAll('offline')
    expect([k.sessions.waitsFor('claude'), k.sessions.waitsFor('codex')]).toEqual(['offline', 'offline'])
    await k.stop()
  })

  it('pauses a room for a limit only when every provider its agents run on is limited', async () => {
    const { k, room } = await twoChats()
    const at = Math.round(Date.now() / 1000) + 3600
    const claude: RateLimit = { type: 'five_hour', status: 'rejected', resetsAt: at }
    const codex: RateLimit = { type: 'five_hour', provider: 'codex', status: 'rejected', resetsAt: at }
    // Every role on Claude: a Claude limit pauses the room, as it always did, and a Codex one doesn't.
    k.account.applyLimits([codex])
    expect(k.store.room(room.id)?.paused).toBeFalsy()
    k.account.applyLimits([claude])
    expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    k.account.applyLimits([])
    expect(k.store.room(room.id)?.paused).toBeFalsy()
    // Kai on Codex and the Lead on Claude: the room pauses only when both are limited.
    await k.config.setSettings({ models: { roles: { engineers: { provider: 'codex', model: 'gpt-6-astra', effort: 'low' } } } })
    k.account.applyLimits([claude])
    expect(k.store.room(room.id)?.paused).toBeFalsy()
    k.account.applyLimits([claude, codex])
    expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    await k.stop()
  })

  it("lets a Claude limit hold only Claude's chats, and only on the account it was hit on", async () => {
    const { k } = await twoChats()
    const s = k.sessions as unknown as { limitHolds: (c: Chat) => boolean; mergeLimits: (l: RateLimit[]) => void }
    s.mergeLimits([{ type: 'five_hour', status: 'rejected', resetsAt: Math.round(Date.now() / 1000) + 3600 }])
    expect(s.limitHolds(k.store.chat('claude')!)).toBe(true)
    expect(s.limitHolds(k.store.chat('codex')!)).toBe(false)
    // Switched to another Claude account, the limit on the CLI login no longer holds.
    const p = k.providers as unknown as { load: () => { claude: { accounts: { id: string; label: string; createdAt: number }[] } }; save: () => Promise<void> }
    p.load().claude.accounts.push({ id: 'work', label: 'Work', createdAt: 1 })
    await k.handlers()['accounts.switch']({ provider: 'claude', accountId: 'work' })
    expect(s.limitHolds(k.store.chat('claude')!)).toBe(false)
    await k.stop()
  })
})

describe('switching accounts at a limit (KERNEL-568)', () => {
  const S = (ms: number) => Math.round(ms / 1000)
  const used = process.env.FAKE_CODEX_USED
  const email = process.env.FAKE_EMAIL
  afterEach(() => {
    if (used === undefined) delete process.env.FAKE_CODEX_USED; else process.env.FAKE_CODEX_USED = used
    if (email === undefined) delete process.env.FAKE_EMAIL; else process.env.FAKE_EMAIL = email
  })

  /**
   * A Kernel with a fake Claude whose own login is renamed Work, Claude accounts added under `names`, and a room whose
   * agents all run on Claude, with a workspace and a chat in it that last ran on Work.
   */
  async function setUp(names: string[] = [], o: Partial<KernelOptions> = {}) {
    const t = await kernel(o)
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    const claude = await fakeClaude()
    await t.k.providers.setPath('claude', { path: claude.bin })
    const h = t.k.handlers()
    await h['accounts.rename']({ provider: 'claude', accountId: 'cli', label: 'Work' })
    const ids: Record<string, string> = {}
    for (const name of names) {
      // Each is its own login: the same one twice is refused (KERNEL-616).
      process.env.FAKE_EMAIL = `${name.toLowerCase()}@example.com`
      const a = await h['accounts.add']({ provider: 'claude' })
      await h['accounts.rename']({ provider: 'claude', accountId: a.id, label: name })
      ids[name] = a.id
    }
    // Adding reads each account in the background.
    if (names.length) await until(() => new Set(sdk.probes.map((p) => p.dir)).size === names.length + 1)
    const repo = await tempRepo()
    const room = await t.k.addRoom(repo)
    t.k.store.saveWorkspace({ id: 'ws', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'kernel-lead', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    t.k.store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'c', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, ranOn: 'cli', createdAt: 1 })
    const folder = (name: string) => t.k.providers.claudeHome(ids[name])
    // `switchTo` makes the account the one in use before it saves and resumes the rooms, so a test that checks what the
    // switch did waits for the switch itself, not for `active` (KERNEL-667).
    const switching = vi.spyOn(t.k.providers, 'switchTo')
    const switched = async () => { await until(() => switching.mock.results.length); await Promise.all(switching.mock.results.map((r) => r.value)) }
    return { ...t, h, ids, room, repo, folder, switched }
  }

  /** A rejection of the 5-hour window, as a session reports it: on Claude's CLI login unless `l` says otherwise. */
  const reject = (k: Kernel, l: Partial<RateLimit> = {}) => (k.sessions as unknown as { mergeLimits: (l: Partial<RateLimit>[]) => void }).mergeLimits([{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: S(Date.now() + 3600_000), ...l }])
  const moving = (k: Kernel) => [...(k.account as unknown as { moving: Map<string, { state: string }> }).moving.values()].map((m) => m.state)
  const notes = (k: Kernel, chatId = 'chat') => k.store.items(chatId).flatMap((i) => (i.kind === 'note' ? [i.text] : []))

  it('moves Claude to the signed-in account with the lowest 5-hour use, notes it in the chat, and stays there when the old account resets', async () => {
    const { k, ids, room, folder, switched } = await setUp(['Side', 'Personal'])
    sdk.usage = { '': 100, [folder('Side')]: 60, [folder('Personal')]: 20 }
    await k.config.setSettings({ accounts: { switchAtLimit: { claude: true } } })
    sdk.probes = []
    reject(k)
    await switched()
    expect(k.providers.active('claude')).toBe(ids.Personal)
    // Every account was read before Kernel picked, so it went by fresh numbers.
    expect(new Set(sdk.probes.map((p) => p.dir))).toEqual(new Set(['', folder('Side'), folder('Personal')]))
    expect(k.store.room(room.id)?.paused).toBeFalsy()
    await k.sessions.send('chat', [{ type: 'text', text: 'Go on' }])
    expect(notes(k)).toEqual(['Now on Personal (Work hit its 5-hour limit)'])
    expect(k.store.chat('chat')?.ranOn).toBe(ids.Personal)
    // Work's window resets. Kernel stays on Personal, and says once that the user can switch back.
    k.sessions.resetLimit('five_hour')
    k.account.applyLimits(k.store.meta<RateLimit[]>('limits') ?? [])
    expect(k.providers.active('claude')).toBe(ids.Personal)
    const resets = k.store.notifications().filter((n) => n.id.startsWith('n-reset-'))
    expect(resets).toHaveLength(1)
    expect(resets[0]).toMatchObject({ title: "Work's 5-hour limit reset", sub: 'You can switch back any time.', body: "Work's 5-hour limit reset. You can switch back any time." })
    await k.stop()
  })

  it('changes nothing with the switch off: the limit pauses the room and Kernel stays on the account', async () => {
    const { k, room, folder } = await setUp(['Personal'])
    sdk.usage = { '': 100, [folder('Personal')]: 10 }
    sdk.probes = []
    reject(k)
    expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    await new Promise((r) => setTimeout(r, 100))
    expect(k.providers.active('claude')).toBeUndefined()
    expect(moving(k)).toEqual([])
    expect(sdk.probes.filter((p) => p.dir === folder('Personal'))).toHaveLength(1)
    await k.stop()
  })

  it('never moves to an API key account, keeps the rooms paused while every other account is at its limit, and moves once one has room', async () => {
    const { k, ids, room, folder } = await setUp(['Personal'])
    const p = k.providers as unknown as { load: () => { claude: { accounts: { id: string; label: string; auth?: 'apiKey'; createdAt: number }[] } }; save: () => Promise<void> }
    p.load().claude.accounts.push({ id: 'key', label: 'Key', auth: 'apiKey', createdAt: 1 })
    await p.save()
    await k.config.setSettings({ accounts: { switchAtLimit: { claude: true } } })
    sdk.usage = { '': 100, [folder('Personal')]: 100 }
    reject(k, { accountId: ids.Personal })
    reject(k)
    await until(() => moving(k).includes('waiting'))
    expect(k.providers.active('claude')).toBeUndefined()
    expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    // The same rejection read again, its reset a second off, reads nothing new.
    sdk.probes = []
    const limits = k.store.meta<RateLimit[]>('limits') ?? []
    k.account.applyLimits(limits.map((l) => (l.accountId === undefined && l.type === 'five_hour' ? { ...l, resetsAt: l.resetsAt! + 1 } : l)))
    await new Promise((r) => setTimeout(r, 100))
    expect(sdk.probes).toEqual([])
    // Personal's window resets while Work's still stands: Kernel moves there, not to the key.
    k.sessions.resetLimit(`claude:${ids.Personal}:five_hour`)
    await until(() => k.providers.active('claude') === ids.Personal)
    await until(() => !k.store.room(room.id)?.paused)
    expect(moving(k)).toEqual(['done'])
    await k.stop()
  })

  it('moves Codex off a limit too, and the chat the limit cut off carries on on the new account with a note', async () => {
    const { k, h, repo } = await setUp()
    const added = await h['accounts.add']({ provider: 'codex' })
    await h['accounts.rename']({ provider: 'codex', accountId: 'cli', label: 'Work' })
    await h['accounts.rename']({ provider: 'codex', accountId: added.id, label: 'Personal' })
    k.store.saveChat({ id: 'codex', workspaceId: 'ws', title: 'x', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'low', plan: false, createdAt: 2 })
    await k.sessions.send('codex', [{ type: 'text', text: 'hi' }])
    await until(() => k.store.chat('codex')?.sessionId && !k.sessions.isRunning('codex'))
    // A chat's first turn says nothing.
    expect(notes(k, 'codex')).toEqual([])
    expect(k.store.chat('codex')?.ranOn).toBe('cli')
    await k.config.setSettings({ accounts: { switchAtLimit: { codex: true } } })
    // The limit cut the chat off mid-turn, and Codex's own login reads full. Its idle process, which would answer the read
    // with the numbers it started with, is gone.
    k.sessions.stop('codex')
    process.env.FAKE_CODEX_USED = JSON.stringify({ '': 100 })
    ;(k.sessions as unknown as { setCutOff: (id: string, r: 'limit') => void }).setCutOff('codex', 'limit')
    reject(k, { provider: 'codex' })
    await until(() => k.providers.active('codex') === added.id)
    await until(() => notes(k, 'codex').length && k.store.chat('codex')?.ranOn === added.id && !k.sessions.isRunning('codex'))
    expect(notes(k, 'codex')).toEqual(['Now on Personal (Work hit its 5-hour limit)'])
    const cwd = await realpath(repo)
    expect((await fake.messages()).filter((m) => 'started' in m && m.cwd === cwd).map((m) => m.started)).toEqual([null, k.providers.codexHome(added.id)])
    // Claude's chats stay where they are.
    expect(k.providers.active('claude')).toBeUndefined()
    await k.stop()
  })

  it("notes a switch the user made without a reason, and a switch from the limit banner with the account's limit", async () => {
    const { k, h, ids } = await setUp(['Personal'])
    await h['accounts.switch']({ provider: 'claude', accountId: ids.Personal })
    expect(k.providers.switchNote('claude', ids.Personal)).toBe('Now on Personal')
    reject(k, { accountId: ids.Personal })
    await h['accounts.switch']({ provider: 'claude', accountId: 'cli', reason: 'banner' })
    expect(k.providers.switchNote('claude', 'cli')).toBe('Now on Work (Personal hit its 5-hour limit)')
    // Personal's reset says so once, and asking with "Notify me" on the account in use still works per account.
    k.sessions.resetLimit(`claude:${ids.Personal}:five_hour`)
    expect(k.store.notifications().filter((n) => n.title === "Personal's 5-hour limit reset")).toHaveLength(1)
    await k.stop()
  })

  it("prefers an account that offers the models agents start on, and moves to one that doesn't only when no other has room (KERNEL-616)", async () => {
    // Every account is on Max, so the Lead stays on Opus 5.5 wherever it runs.
    const plan = process.env.FAKE_PLAN
    process.env.FAKE_PLAN = 'max'
    try {
      const { k, ids, room, folder } = await setUp(['Side', 'Personal'], { checkPins: true, starterDir: STARTERS })
      await k.team.agents(room.id)
      const lead = k.team.agentsSync(room.id).filter((a) => k.team.pickFor(a).model === 'claude-opus-5-5').map((a) => a.name)
      expect(lead.length).toBeGreaterThan(0)
      const read: string[] = []
      k.providers.readModels = async (_p, id) => { read.push(id); return id === ids.Side ? ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] : ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] }
      // Side has the most room, but no Opus.
      sdk.usage = { '': 100, [folder('Side')]: 10, [folder('Personal')]: 50 }
      await k.config.setSettings({ accounts: { switchAtLimit: { claude: true } } })
      reject(k)
      await until(() => k.providers.active('claude') === ids.Personal)
      expect(read).toEqual([ids.Side, ids.Personal])
      expect(k.store.notifications().filter((n) => n.id.startsWith('n-models-'))).toEqual([])
      // Personal hits its limit too, and only Side has room: Kernel moves there and says who can't run.
      sdk.usage[folder('Personal')] = 100
      reject(k, { accountId: ids.Personal })
      await until(() => k.providers.active('claude') === ids.Side)
      const warned = await until(() => k.store.notifications().find((n) => n.id.startsWith('n-models-')))
      expect(warned).toMatchObject({ title: "Side doesn't offer Opus 5.5", sub: `${joinLabels([...lead].sort())} can't run on it. Pick another model in Settings, Models.` })
      // Each account's models were read once.
      expect(read).toEqual([ids.Side, ids.Personal])
      await k.stop()
    } finally {
      if (plan === undefined) delete process.env.FAKE_PLAN; else process.env.FAKE_PLAN = plan
    }
  })
})

describe('MCP sign-ins, an account added twice, and models an account lacks (KERNEL-616)', () => {
  const keys = ['FAKE_EMAIL', 'FAKE_PLAN', 'FAKE_ORG', 'FAKE_MCP_FAIL', 'FAKE_CODEX_LOGIN_EMAIL'] as const
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })

  const HOUR = 3600_000
  const CLI = 'Claude Code-credentials'
  const signIn = (server: string, who: string, expiresAt: number) => ({ serverName: server, serverUrl: `https://${server}.example.com/mcp`, accessToken: `${who}-${server}-access`, refreshToken: `${who}-${server}-refresh`, expiresAt, clientId: `client-${server}` })
  const stub = (server: string) => ({ serverName: server, serverUrl: `https://${server}.example.com/mcp`, accessToken: '', discoveryState: {} })

  /** A Kernel whose Claude is a fake CLI with its own login on Max, and whose Keychain is in memory. */
  async function setUp(o: Partial<KernelOptions> = {}) {
    const kc = fakeKeychain()
    const t = await kernel({ keychain: kc.keychain, ...o })
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    const claude = await fakeClaude()
    await t.k.providers.setPath('claude', { path: claude.bin })
    const steps: AccountAddStep[] = []
    const mcpSteps: McpSignInStep[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.add') steps.push(e.add); if (e.type === 'account.mcpSignIn') mcpSteps.push(e.signIn) })
    const h = t.k.handlers()
    const rows = async (provider: 'claude' | 'codex' = 'claude') => (await h['accounts.list'](undefined)).filter((a) => a.provider === provider)
    /** Shares the sign-ins now, as the next Claude process on `accountId` would. */
    const share = (accountId?: string) => { (t.k.providers as unknown as { sharedAt: number }).sharedAt = 0; return t.k.providers.claudeEnv(accountId) }
    return { ...t, kc, claude, h, steps, mcpSteps, rows, share }
  }

  it("gives an added login the CLI login's MCP sign-ins before its processes start, and brings a token it refreshed back", async () => {
    const { k, h, kc, home, share } = await setUp()
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    const now = Date.now()
    kc.set(CLI, { claudeAiOauth: { accessToken: 'max-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR), 'claude.ai Gmail|ccc': { serverName: 'claude.ai Gmail', accessToken: 'cli-gmail-access' } } })
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    const SIDE = credentialsItem({ CLAUDE_CONFIG_DIR: folder })
    // Claude Code made the login's item when it signed in, and found linear needs a sign-in there.
    kc.set(SIDE, { claudeAiOauth: { accessToken: 'pro-login' }, mcpOAuth: { 'linear|aaa': stub('linear') } })
    await writeFile(join(folder, 'mcp-needs-auth-cache.json'), JSON.stringify({ linear: { timestamp: now } }))
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    expect(share()).toEqual({ CLAUDE_CONFIG_DIR: folder })
    expect(kc.json(SIDE)).toEqual({ claudeAiOauth: { accessToken: 'pro-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } })
    expect(JSON.parse(await readFile(join(folder, 'mcp-needs-auth-cache.json'), 'utf8'))).toEqual({})
    // A session on the account refreshes linear. The CLI's own login gets the new token before its next process.
    kc.set(SIDE, { claudeAiOauth: { accessToken: 'pro-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'side', now + 2 * HOUR) } })
    await h['accounts.switch']({ provider: 'claude', accountId: 'cli' })
    expect(share()).toEqual({})
    expect(kc.json(CLI)).toEqual({ claudeAiOauth: { accessToken: 'max-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'side', now + 2 * HOUR), 'claude.ai Gmail|ccc': { serverName: 'claude.ai Gmail', accessToken: 'cli-gmail-access' } } })
    // The connector stays the CLI login's own.
    expect(kc.json(SIDE).mcpOAuth['claude.ai Gmail|ccc']).toBeUndefined()
    // ~/.claude's needs-auth cache is the CLI login's, in the home folder Kernel was given.
    expect(existsSync(join(home, '.claude', 'mcp-needs-auth-cache.json'))).toBe(false)
    for (const spy of logs) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/-access|-refresh|-login/)
      spy.mockRestore()
    }
    await k.stop()
  })

  it('lists the servers that need a sign-in on each login, and signs one in on its folder, a claude.ai connector included', async () => {
    const { k, h, kc, claude, rows, mcpSteps } = await setUp()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    sdk.mcp = {
      [folder]: [{ name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'claude.ai Google Drive', status: 'needs-auth', scope: 'claudeai' }, { name: 'neon', status: 'connected', scope: 'user' }],
      '': [{ name: 'claude.ai Google Drive', status: 'connected', scope: 'claudeai' }, { name: 'linear', status: 'connected', scope: 'user' }]
    }
    expect((await rows()).map((a) => a.mcpSignIns)).toEqual([undefined, undefined])
    const checked = await h['accounts.checkMcp']({ provider: 'claude', accountId: side.id })
    expect(checked.find((a) => a.id === side.id)?.mcpSignIns).toEqual([{ server: 'linear', connector: false }, { server: 'claude.ai Google Drive', connector: true }])
    expect((await h['accounts.checkMcp']({ provider: 'claude', accountId: 'cli' })).find((a) => a.id === 'cli')?.mcpSignIns).toEqual([])
    // The check ran on each login.
    expect(sdk.probes.slice(-2).map((p) => p.dir)).toEqual([folder, ''])
    // linear signs in on the account's folder, and is off its list.
    const after = await h['accounts.mcpSignIn']({ provider: 'claude', accountId: side.id, server: 'linear' })
    expect(after.find((a) => a.id === side.id)?.mcpSignIns).toEqual([{ server: 'claude.ai Google Drive', connector: true }])
    expect(mcpSteps).toEqual([{ accountId: side.id, server: 'linear', step: 'browser', url: MCP_LINK }, { accountId: side.id, server: 'linear', step: 'done' }])
    expect((await claude.calls()).filter((c) => c.args.startsWith('mcp login'))).toEqual([{ args: 'mcp login linear', dir: folder, token: false }])
    // A connector finishes on claude.ai, so it stays listed until the next check.
    mcpSteps.length = 0
    const connector = await h['accounts.mcpSignIn']({ provider: 'claude', accountId: side.id, server: 'claude.ai Google Drive' })
    expect(connector.find((a) => a.id === side.id)?.mcpSignIns).toEqual([{ server: 'claude.ai Google Drive', connector: true }])
    expect(mcpSteps.map((s) => [s.step, s.connector, s.url])).toEqual([['browser', true, 'https://claude.ai/customize/connectors'], ['done', true, undefined]])
    // A refusal says why, and an API key account's servers run on the CLI's login.
    process.env.FAKE_MCP_FAIL = '1'
    await expect(h['accounts.mcpSignIn']({ provider: 'claude', accountId: side.id, server: 'linear' })).rejects.toThrow('Claude Code said: Couldn\'t complete authentication for "linear": access denied')
    expect(mcpSteps.at(-1)).toMatchObject({ step: 'failed', error: 'Claude Code said: Couldn\'t complete authentication for "linear": access denied' })
    const p = k.providers as unknown as { load: () => { claude: { accounts: object[] } } }
    p.load().claude.accounts.push({ id: 'key', label: 'Key', auth: 'apiKey', createdAt: 1 })
    await expect(h['accounts.checkMcp']({ provider: 'claude', accountId: 'key' })).rejects.toThrow("This account's MCP servers use Claude Code's own login.")
    expect(kc.writes).toEqual([])
    await k.stop()
  })

  it('refuses to add a Claude login that is the CLI login or already added, and lets the same email in another organization in', async () => {
    const { k, h, claude, rows, steps, dataDir } = await setUp().then((t) => ({ ...t, dataDir: t.k.o.dataDir }))
    process.env.FAKE_EMAIL = 'CJ@example.com'
    await expect(h['accounts.add']({ provider: 'claude' })).rejects.toThrow('That account is already in Kernel.')
    expect(steps.at(-1)).toMatchObject({ provider: 'claude', step: 'failed', error: 'That account is already in Kernel.' })
    expect(await rows()).toHaveLength(1)
    // The new folder signed out and went. The CLI's own login stays signed in.
    expect(await claude.logins()).toEqual({ cli: { email: 'cj@example.com', plan: 'max' } })
    expect(existsSync(join(dataDir, 'claude-homes')) ? await readdir(join(dataDir, 'claude-homes')) : []).toEqual([])
    process.env.FAKE_EMAIL = 'side@example.com'
    const side = await h['accounts.add']({ provider: 'claude' })
    await expect(h['accounts.add']({ provider: 'claude' })).rejects.toThrow('That account is already in Kernel.')
    expect((await rows()).map((a) => a.id)).toEqual(['cli', side.id])
    expect(await readdir(join(dataDir, 'claude-homes'))).toEqual([side.id])
    // One email, two plans: the CLI login is a personal Max, and the new login a Team seat.
    await claude.setLogin('cli', { email: 'cj@example.com', plan: 'max', org: 'org-personal' })
    process.env.FAKE_EMAIL = 'cj@example.com'
    process.env.FAKE_ORG = 'org-team'
    process.env.FAKE_PLAN = 'team'
    const team = await h['accounts.add']({ provider: 'claude' })
    expect(team).toMatchObject({ email: 'cj@example.com', plan: 'Claude Team' })
    await expect(h['accounts.add']({ provider: 'claude' })).rejects.toThrow('That account is already in Kernel.')
    expect(await rows()).toHaveLength(3)
    await k.stop()
  })

  it('refuses to add a Codex login that is the CLI login or already added', async () => {
    const { k, h, rows, steps } = await setUp()
    process.env.FAKE_CODEX_LOGIN_EMAIL = 'cj@example.com'
    await expect(h['accounts.add']({ provider: 'codex' })).rejects.toThrow('That account is already in Kernel.')
    expect(steps.at(-1)).toMatchObject({ provider: 'codex', step: 'failed', error: 'That account is already in Kernel.' })
    expect(await rows('codex')).toHaveLength(1)
    expect(existsSync(join(k.o.dataDir, 'codex-homes')) ? await readdir(join(k.o.dataDir, 'codex-homes')) : []).toEqual([])
    delete process.env.FAKE_CODEX_LOGIN_EMAIL
    const added = await h['accounts.add']({ provider: 'codex' })
    await expect(h['accounts.add']({ provider: 'codex' })).rejects.toThrow('That account is already in Kernel.')
    expect((await rows('codex')).map((a) => a.id)).toEqual(['cli', added.id])
    await k.stop()
  })

  it("names the agents whose model the account switched to doesn't offer, on its row and once in the Inbox", async () => {
    const { k, h } = await setUp({ checkPins: true, starterDir: STARTERS })
    const repo = await tempRepo()
    // Kai's file pins Opus.
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    await writeFile(join(repo, '.claude', 'agents', 'kai.md'), '---\nname: kai\ndescription: Engineer. Builds the engine.\nmodel: opus\n---\nYou are Kai.')
    const room = await k.addRoom(repo)
    // The user put the Lead on Opus 5.5 themselves, so a Pro plan's defaults don't move it.
    await k.config.setSettings({ models: { roles: { lead: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } } } })
    await k.team.agents(room.id)
    const lead = k.team.agentsSync(room.id).filter((a) => k.team.pickFor(a).model === 'claude-opus-5-5').map((a) => a.name).sort()
    expect(lead).toEqual(['Kai', 'Rowan'])
    const side = await h['accounts.add']({ provider: 'claude' })
    k.providers.readModels = async (_p, id) => (id === side.id ? ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] : ['claude-opus-5-5', 'claude-sonnet-5-5'])
    const rows = await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    expect(rows.find((a) => a.id === side.id)?.missingModels).toEqual([{ model: 'claude-opus-5-5', label: 'Opus 5.5', agents: lead }])
    const notices = () => k.notifications.list().filter((n) => n.id.startsWith('n-models-'))
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toMatchObject({
      title: "side@example.com doesn't offer Opus 5.5", sub: `${joinLabels(lead)} can't run on it. Pick another model in Settings, Models.`,
      body: `side@example.com doesn't offer Opus 5.5, so ${joinLabels(lead)} can't run on it. Pick another model for them in Settings, Models, or switch to another account.`
    })
    // Back on the CLI login, which offers it, nothing is missing. Switching to the account again the same day says nothing new.
    expect((await h['accounts.switch']({ provider: 'claude', accountId: 'cli' })).find((a) => a.id === 'cli')?.missingModels).toBeUndefined()
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    expect(notices()).toHaveLength(1)
    // The Lead moves to a model the account offers. Kai's file still pins Opus.
    await k.config.setSettings({ models: { roles: { lead: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } } } })
    expect((await h['accounts.list'](undefined)).find((a) => a.id === side.id)?.missingModels).toEqual([{ model: 'claude-opus-5-5', label: 'Opus 5.5', agents: ['Kai'] }])
    await k.stop()
  })
})

describe('MCP servers added on an account, Keychain prompts and shared organizations (KERNEL-618)', () => {
  const keys = ['FAKE_EMAIL', 'FAKE_PLAN', 'FAKE_ORG'] as const
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })

  /** A Kernel whose Claude is a fake CLI with its own login on Max and `neon` in `~/.claude.json`, an in-memory Keychain, and one added login. */
  async function setUp() {
    const kc = fakeKeychain()
    const t = await kernel({ keychain: kc.keychain })
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    const claude = await fakeClaude()
    await t.k.providers.setPath('claude', { path: claude.bin })
    await writeFile(join(t.home, '.claude.json'), JSON.stringify({ mcpServers: { neon: { command: 'neon' } }, projects: { '/repo': {} }, oauthAccount: { emailAddress: 'cj@example.com' } }))
    const h = t.k.handlers()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = t.k.providers.claudeHome(side.id)
    const rows = async () => (await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude')
    const row = async (id = side.id) => (await rows()).find((a) => a.id === id)
    /** The environment the next Claude process on `accountId` gets, with the MCP servers synced across every login first. */
    const start = (accountId?: string) => { (t.k.providers as unknown as { syncedAt: number }).syncedAt = 0; return t.k.providers.claudeEnv(accountId) }
    return { ...t, kc, claude, h, side, folder, rows, row, start }
  }

  const config = async (file: string) => JSON.parse(await readFile(file, 'utf8'))
  /** Changes a `.claude.json` the way `claude mcp add` or `claude mcp remove` would. */
  const edit = async (file: string, change: (c: any) => void) => { const c = await config(file); change(c); await writeFile(file, JSON.stringify(c)) }

  it('keeps an MCP server added on an added account on every login while switching back and forth, and one removed stays removed', async () => {
    const { k, h, side, folder, home, start } = await setUp()
    const cliFile = join(home, '.claude.json')
    const acctFile = join(folder, '.claude.json')
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    expect(start()).toEqual({ CLAUDE_CONFIG_DIR: folder })
    // `claude mcp add --scope user fal` in a terminal on the account, and a local server in /repo.
    await edit(acctFile, (c) => { c.mcpServers.fal = { command: 'fal' }; c.projects['/repo'] = { mcpServers: { db: { command: 'db' } } } })
    await h['accounts.switch']({ provider: 'claude', accountId: 'cli' })
    expect(start()).toEqual({})
    expect((await config(cliFile)).mcpServers).toEqual({ neon: { command: 'neon' }, fal: { command: 'fal' } })
    expect((await config(cliFile)).projects['/repo'].mcpServers).toEqual({ db: { command: 'db' } })
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    start()
    expect((await config(acctFile)).mcpServers).toEqual({ neon: { command: 'neon' }, fal: { command: 'fal' } })
    // `claude mcp remove fal` on the CLI login: gone from the account, and it doesn't come back.
    await edit(cliFile, (c) => { delete c.mcpServers.fal })
    for (const to of ['cli', side.id, 'cli', side.id]) {
      await h['accounts.switch']({ provider: 'claude', accountId: to })
      start()
    }
    expect((await config(acctFile)).mcpServers).toEqual({ neon: { command: 'neon' } })
    expect((await config(cliFile)).mcpServers).toEqual({ neon: { command: 'neon' } })
    // The account's own login stays its own.
    expect((await config(acctFile)).oauthAccount).toEqual({ emailAddress: 'side@example.com' })
    expect((await config(cliFile)).oauthAccount).toEqual({ emailAddress: 'cj@example.com' })
    await k.stop()
  })

  it('says an account waits for Keychain access instead of signing it out, holds its chats only while the prompt is up, and goes on once allowed', async () => {
    const { k, kc, claude, h, side, folder, row } = await setUp()
    k.providers.keychainMs = { wait: 50, prompt: 5000, retry: 60_000 }
    await h['accounts.rename']({ provider: 'claude', accountId: side.id, label: 'Personal' })
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    const item = credentialsItem({ CLAUDE_CONFIG_DIR: folder })
    kc.set(item, { claudeAiOauth: { accessToken: 'pro-login' } })
    // macOS asks before reading the item, and Claude Code gives up after 2 seconds and reads the login as signed out.
    kc.prompt(item)
    await claude.setLogin(folder, null)
    k.account.signedOut('claude')
    await until(() => k.sessions.heldFor('claude').includes('keychain'))
    expect(k.sessions.heldFor('claude')).not.toContain('auth')
    expect(await row()).toMatchObject({ signedIn: true, keychainWait: true })
    const notices = () => k.notifications.list().filter((n) => n.title.startsWith('Personal is'))
    expect(notices()).toMatchObject([{ title: 'Personal is waiting for Keychain access', sub: 'Allow it in the macOS prompt to use this account.' }])
    // Reads meanwhile keep the sign-in and show one prompt, not one each.
    await k.providers.readUsage({ force: true })
    expect(await h['account.get'](undefined)).toMatchObject({ signedIn: true, name: 'Personal' })
    expect(kc.accesses.filter((i) => i === item)).toHaveLength(1)
    // Always Allow.
    await claude.setLogin(folder, { email: 'side@example.com', plan: 'pro' })
    kc.allow(item)
    await until(() => !k.sessions.heldFor('claude').includes('keychain'))
    await until(async () => (await row())?.keychainWait === undefined)
    expect(await row()).toMatchObject({ signedIn: true })
    expect(notices().map((n) => n.title)).toEqual(['Personal is waiting for Keychain access'])
    await k.stop()
  })

  it("stops holding chats when nobody allows the prompt, asks again only later, and still never signs the account out", async () => {
    const { k, kc, claude, h, side, folder, row } = await setUp()
    k.providers.keychainMs = { wait: 50, prompt: 200, retry: 60_000 }
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    const item = credentialsItem({ CLAUDE_CONFIG_DIR: folder })
    kc.set(item, { claudeAiOauth: { accessToken: 'pro-login' } })
    kc.prompt(item)
    await claude.setLogin(folder, null)
    k.account.signedOut('claude')
    await until(() => k.sessions.heldFor('claude').includes('keychain'))
    // Kernel's read gives up, and with it the hold.
    await until(() => !k.sessions.heldFor('claude').includes('keychain'))
    expect(await row()).toMatchObject({ signedIn: true, keychainWait: true })
    // Refused again: no new prompt yet, and nothing waits for one.
    k.account.signedOut('claude')
    await until(() => !k.sessions.heldFor('claude').includes('auth'))
    expect(k.sessions.heldFor('claude')).toEqual([])
    expect(kc.accesses.filter((i) => i === item)).toHaveLength(1)
    expect(k.notifications.list().filter((n) => n.title.endsWith('is signed out'))).toEqual([])
    await k.stop()
  })

  it('lets chats held for a Keychain prompt go on when Claude moves to another account', async () => {
    const { k, kc, claude, h, side, folder } = await setUp()
    k.providers.keychainMs = { wait: 50, prompt: 5000, retry: 60_000 }
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    const item = credentialsItem({ CLAUDE_CONFIG_DIR: folder })
    kc.set(item, { claudeAiOauth: { accessToken: 'pro-login' } })
    kc.prompt(item)
    await claude.setLogin(folder, null)
    k.account.signedOut('claude')
    await until(() => k.sessions.heldFor('claude').includes('keychain'))
    await h['accounts.switch']({ provider: 'claude', accountId: 'cli' })
    expect(k.sessions.heldFor('claude')).toEqual([])
    kc.deny(item)
    await k.stop()
  })

  it('signs an account out as before when its Keychain item reads, or is gone', async () => {
    const { k, h, side, claude, folder, row } = await setUp()
    await h['accounts.switch']({ provider: 'claude', accountId: side.id })
    await claude.setLogin(folder, null)
    k.account.signedOut('claude')
    await until(async () => (await row())?.signedIn === false)
    expect(k.sessions.heldFor('claude')).toContain('auth')
    expect((await row())?.keychainWait).toBeUndefined()
    expect(k.notifications.list().map((n) => n.title)).toContain('side@example.com is signed out')
    await k.stop()
  })

  it('names the accounts in one organization on each row, and moves at a limit to one of them only once its own windows say it has room', async () => {
    const { k, claude, h, side, folder, row } = await setUp()
    // The CLI login is a Team seat, and a second seat in the same organization is added.
    await claude.setLogin('cli', { email: 'cj@example.com', plan: 'team', org: 'org-team' })
    process.env.FAKE_EMAIL = 'seat@example.com'
    process.env.FAKE_PLAN = 'team'
    process.env.FAKE_ORG = 'org-team'
    const seat = await h['accounts.add']({ provider: 'claude' })
    await h['accounts.rename']({ provider: 'claude', accountId: 'cli', label: 'Work' })
    expect(await row('cli')).toMatchObject({ sameOrg: [seat.id] })
    expect(await row(seat.id)).toMatchObject({ sameOrg: ['cli'] })
    expect((await row(side.id))?.sameOrg).toBeUndefined()
    // side@example.com signs out, so the seat is the only other account.
    await claude.setLogin(folder, null)
    await k.providers.readUsage({ force: true })
    expect((await row(side.id))?.signedIn).toBe(false)
    await k.config.setSettings({ accounts: { switchAtLimit: { claude: true } } })
    // Work hits its 5-hour limit, and the seat's usage can't be read.
    sdk.usage = { '': 100 }
    const merge = (l: Partial<RateLimit>) => (k.sessions as unknown as { mergeLimits: (l: Partial<RateLimit>[]) => void }).mergeLimits([{ type: 'five_hour', resetsAt: Math.round(Date.now() / 1000) + 3600, ...l }])
    merge({ status: 'rejected', utilization: 1 })
    const moving = () => [...(k.account as unknown as { moving: Map<string, { state: string }> }).moving.values()].map((m) => m.state)
    await until(() => moving().includes('waiting'))
    expect(k.providers.active('claude')).toBeUndefined()
    // A reading of the seat's own windows shows room, and Kernel moves there.
    merge({ status: 'allowed', utilization: 0.1, accountId: seat.id })
    await until(() => k.providers.active('claude') === seat.id)
    await k.stop()
  })
})

describe("Every account's MCP servers, Sign in to all, and the notice after adding an account (KERNEL-626)", () => {
  const keys = ['FAKE_EMAIL', 'FAKE_MCP_FAIL', 'FAKE_LOGIN_WAIT', 'FAKE_CODEX_MCP_STATUS', 'FAKE_CODEX_LOGIN_EMAIL'] as const
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })

  /** A Kernel whose Claude is a fake CLI with its own login, with the pushes this issue adds. */
  async function setUp(o: Partial<KernelOptions> = {}) {
    const t = await kernel(o)
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    const claude = await fakeClaude()
    await t.k.providers.setPath('claude', { path: claude.bin })
    const runs: McpSignInAll[] = []
    const needed: McpNeeded[] = []
    const views: McpAccount[][] = []
    bus.on('push', (e: PushEvent) => {
      if (e.type === 'account.mcpSignInAll') runs.push(e.run)
      if (e.type === 'account.mcpNeeded') needed.push(e.needed)
      if (e.type === 'mcp.accounts') views.push(e.accounts)
    })
    const h = t.k.handlers()
    const logins = async () => (await claude.calls()).filter((c) => c.args.startsWith('mcp login')).map((c) => c.args.slice('mcp login '.length))
    return { ...t, claude, h, runs, needed, views, logins }
  }

  const states = (a: McpAccount | undefined) => a?.servers.map((s) => [s.name, s.state, ...(s.connector ? ['connector'] : []), ...(s.error ? [s.error] : [])])

  it("gives every account's server states for both providers in one call, checks each account once, and again on refresh", async () => {
    const { k, h, root, views } = await setUp()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    process.env.FAKE_CODEX_LOGIN_EMAIL = 'side@example.com'
    const work = await h['accounts.add']({ provider: 'codex' })
    const workHome = k.providers.codexHome(work.id)!
    sdk.mcp = {
      '': [{ name: 'linear', status: 'connected', scope: 'user' }, { name: 'neon', status: 'connected', scope: 'user' }, { name: 'claude.ai Gmail', status: 'connected', scope: 'claudeai' }, { name: 'claude.ai Google Drive', status: 'needs-auth', scope: 'claudeai' }],
      [folder]: [{ name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'neon', status: 'failed', scope: 'user', error: 'spawn neon ENOENT' } as { name: string; status: string; scope: string }]
    }
    await writeFile(join(root, 'config.toml'), '[mcp_servers.vapi]\ncommand = "vapi"\nenabled = false\n')
    const codexServer = (name: string, authStatus: string, tools: string[] = []) => ({ name, authStatus, runtimeStatus: null, tools: Object.fromEntries(tools.map((t) => [t, {}])) })
    process.env.FAKE_CODEX_MCP_STATUS = JSON.stringify({
      '': [codexServer('github', 'bearerToken', ['search']), codexServer('vercel', 'notLoggedIn'), codexServer('vapi', 'unsupported')],
      [workHome]: [codexServer('github', 'bearerToken', ['search']), codexServer('vercel', 'notLoggedIn'), codexServer('figma', 'unsupported')]
    })
    sdk.probes = []
    const all = await h['mcp.accounts'](undefined)
    expect(all.map((a) => [a.provider, a.accountId])).toEqual([['claude', 'cli'], ['claude', side.id], ['codex', 'cli'], ['codex', work.id]])
    const on = (list: McpAccount[], provider: string, id: string) => list.find((a) => a.provider === provider && a.accountId === id)
    expect(states(on(all, 'claude', 'cli'))).toEqual([['claude.ai Gmail', 'ready', 'connector'], ['claude.ai Google Drive', 'needs-sign-in', 'connector'], ['linear', 'ready'], ['neon', 'ready']])
    // The connectors are the CLI login's own, so the added login doesn't have them.
    expect(states(on(all, 'claude', side.id))).toEqual([['claude.ai Gmail', 'not-set-up', 'connector'], ['claude.ai Google Drive', 'not-set-up', 'connector'], ['linear', 'needs-sign-in'], ['neon', 'failed', 'spawn neon ENOENT']])
    // A server config.toml switches off is off on every Codex account, since they share the file (KERNEL-646, KERNEL-660).
    expect(states(on(all, 'codex', 'cli'))).toEqual([['figma', 'not-set-up'], ['github', 'ready'], ['vapi', 'off'], ['vercel', 'needs-sign-in']])
    expect(states(on(all, 'codex', work.id))).toEqual([['figma', 'failed', 'Codex listed no tools for it and didn\u2019t start it.'], ['github', 'ready'], ['vapi', 'off'], ['vercel', 'needs-sign-in']])
    expect(all.every((a) => typeof a.checkedAt === 'number' && !a.error)).toBe(true)
    expect(views.at(-1)).toEqual(all)
    // The Claude check also fills the account's row, as accounts.checkMcp does.
    expect((await h['accounts.list'](undefined)).find((a) => a.id === side.id)?.mcpSignIns).toEqual([{ server: 'linear', connector: false }])
    expect(sdk.probes.map((p) => p.dir).sort()).toEqual(['', folder])
    // Opening the page again checks nothing.
    sdk.probes = []
    const spy = vi.spyOn(k.providers, 'mcpServersOn')
    expect(await h['mcp.accounts']({})).toEqual(all)
    expect(spy).not.toHaveBeenCalled()
    // Refresh checks again, here one account.
    sdk.mcp[folder] = [{ name: 'linear', status: 'connected', scope: 'user' }, { name: 'neon', status: 'connected', scope: 'user' }]
    const again = await h['mcp.accounts']({ refresh: true, accountId: side.id })
    expect(spy.mock.calls).toEqual([['claude', side.id]])
    expect(states(on(again, 'claude', side.id))).toEqual([['claude.ai Gmail', 'not-set-up', 'connector'], ['claude.ai Google Drive', 'not-set-up', 'connector'], ['linear', 'ready'], ['neon', 'ready']])
    spy.mockRestore()
    await k.stop()
  })

  it("signs in to every server an account needs one after another, moves on from one that fails, and reports it at the end", async () => {
    const { k, h, runs, logins, views } = await setUp()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    sdk.mcp = { [folder]: [{ name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'figma', status: 'needs-auth', scope: 'user' }, { name: 'claude.ai Google Drive', status: 'needs-auth', scope: 'claudeai' }, { name: 'neon', status: 'connected', scope: 'user' }] }
    process.env.FAKE_MCP_FAIL = 'figma'
    // Once linear signs in, Claude Code lists it as connected, which the check after each sign-in reads (KERNEL-660).
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.mcpSignInAll' && e.run.done.includes('linear')) sdk.mcp[folder] = sdk.mcp[folder].map((s) => (s.name === 'linear' ? { ...s, status: 'connected' } : s)) })
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    // Nothing checked the account yet, so Sign in to all checks it first.
    const run = await h['accounts.mcpSignInAll']({ provider: 'claude', accountId: side.id })
    expect(run).toEqual({ accountId: side.id, servers: ['claude.ai Google Drive', 'figma', 'linear'], done: ['claude.ai Google Drive', 'linear'], failed: [{ server: 'figma', error: 'Claude Code said: Couldn\'t complete authentication for "figma": access denied' }], finished: true })
    expect(await logins()).toEqual(['claude.ai Google Drive', 'figma', 'linear'])
    // Each push says which server is next.
    expect(runs.map((r) => r.current ?? (r.finished ? 'finished' : 'queued'))).toEqual(['queued', 'claude.ai Google Drive', 'figma', 'linear', 'finished'])
    // linear is ready now. figma still needs one, and the connector stays listed until Claude Code lists it, as on its row.
    const view = await until(() => views.at(-1)?.find((a) => a.accountId === side.id && a.servers.find((s) => s.name === 'linear')?.state === 'ready'))
    expect(states(view)).toEqual([['claude.ai Google Drive', 'needs-sign-in', 'connector'], ['figma', 'needs-sign-in'], ['linear', 'ready'], ['neon', 'ready']])
    for (const spy of logs) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/token|access_token|refresh/i)
      spy.mockRestore()
    }
    await k.stop()
  })

  it('stops Sign in to all on Cancel, so no server after the current one starts', async () => {
    const { k, h, runs, logins, claude } = await setUp()
    const diag: unknown[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.mcpSignIn' || e.type === 'account.mcpSignInAll') diag.push([Date.now() % 100000, e]) })
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    sdk.mcp = { [folder]: [{ name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'figma', status: 'needs-auth', scope: 'user' }] }
    await h['mcp.accounts'](undefined)
    process.env.FAKE_LOGIN_WAIT = '1'
    const running = h['accounts.mcpSignInAll']({ provider: 'claude', accountId: side.id })
    await until(async () => (await logins()).includes('figma'))
    diag.push(['SEEN', Date.now() % 100000, await claude.calls()])
    await expect(h['accounts.mcpSignInAll']({ provider: 'claude', accountId: side.id })).rejects.toThrow('Sign in to all is already running.')
    await h['accounts.cancelAdd']({ provider: 'claude' })
    expect(await running).toEqual({ accountId: side.id, servers: ['figma', 'linear'], done: [], failed: [], finished: true, canceled: true })
    diag.push(['AFTER', Date.now() % 100000, await claude.calls()])
    expect(await logins(), JSON.stringify(diag)).toEqual(['figma'])
    // It can run again once it ended.
    delete process.env.FAKE_LOGIN_WAIT
    expect((await h['accounts.mcpSignInAll']({ provider: 'claude', accountId: side.id })).done).toEqual(['figma', 'linear'])
    await k.stop()
  })

  it('says once when servers need a sign-in on a Claude account just added, and nothing when none do', async () => {
    const { k, h, needed, views } = await setUp({ checkMcpOnAdd: true })
    sdk.mcp = { '*': [{ name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'figma', status: 'needs-auth', scope: 'user' }, { name: 'neon', status: 'connected', scope: 'user' }] }
    const side = await h['accounts.add']({ provider: 'claude' })
    await until(() => needed.length)
    expect(needed).toEqual([{ provider: 'claude', accountId: side.id, servers: ['figma', 'linear'], title: '2 MCP servers need a sign-in on side@example.com' }])
    expect(views.at(-1)?.find((a) => a.accountId === side.id)?.checkedAt).toBeTypeOf('number')
    // Only once per account.
    await k.mcp.accountAdded('claude', side.id)
    // An account where every server is ready gets no notice, and neither does a Codex account, which shares its sign-ins.
    sdk.mcp = { '*': [{ name: 'neon', status: 'connected', scope: 'user' }] }
    process.env.FAKE_EMAIL = 'personal@example.com'
    const personal = await h['accounts.add']({ provider: 'claude' })
    await until(() => views.some((v) => v.some((a) => a.accountId === personal.id && a.checkedAt)))
    process.env.FAKE_CODEX_LOGIN_EMAIL = 'side@example.com'
    await h['accounts.add']({ provider: 'codex' })
    await new Promise((r) => setTimeout(r, 200))
    expect(needed).toHaveLength(1)
    await k.stop()
  })
})

describe('Every server on every account, Codex sign-in, failure reasons and ignore (KERNEL-646)', () => {
  const keys = ['FAKE_EMAIL', 'FAKE_MCP_FAIL', 'FAKE_CODEX_MCP_STATUS', 'FAKE_CODEX_MCP_STARTUP', 'FAKE_CODEX_MCP_LOGIN', 'FAKE_CODEX_MCP_NO_OAUTH', 'FAKE_CODEX_LOGIN_EMAIL'] as const
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })

  /** A Kernel whose Claude is a fake CLI with its own login, with the pushes `mcp.accounts` sends. */
  async function setUp(o: Partial<KernelOptions> = {}) {
    const t = await kernel(o)
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    const claude = await fakeClaude()
    await t.k.providers.setPath('claude', { path: claude.bin })
    const runs: McpSignInAll[] = []
    const needed: McpNeeded[] = []
    const steps: McpSignInStep[] = []
    bus.on('push', (e: PushEvent) => {
      if (e.type === 'account.mcpSignInAll') runs.push(e.run)
      if (e.type === 'account.mcpNeeded') needed.push(e.needed)
      if (e.type === 'account.mcpSignIn') steps.push(e.signIn)
    })
    const h = t.k.handlers()
    const on = (list: McpAccount[], provider: string, id: string) => list.find((a) => a.provider === provider && a.accountId === id)
    return { ...t, claude, h, runs, needed, steps, on }
  }

  const codexServer = (name: string, authStatus: string, tools: string[] = [], pluginId: string | null = null) => ({ name, authStatus, runtimeStatus: null, pluginId, tools: Object.fromEntries(tools.map((t) => [t, {}])) })
  const STATES = ['ready', 'needs-sign-in', 'failed', 'not-set-up', 'ignored', 'off']

  it('gives every account every server of its provider with a kind, one of five states and a one-line reason', async () => {
    const { k, h, root, on } = await setUp()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    sdk.mcp = {
      // Claude Code leaves out the vercel plugin's server on the CLI login, whose claude.ai Vercel connector points to the same place.
      '': [{ name: 'claude.ai Gmail', status: 'connected', scope: 'claudeai' }, { name: 'claude.ai Vercel', status: 'connected', scope: 'claudeai' }, { name: 'linear', status: 'connected', scope: 'user' },
        { name: 'neon', status: 'failed', scope: 'user', error: '\x1b[31mError: spawn neon ENOENT\x1b[0m\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)' } as { name: string; status: string; scope: string }],
      [folder]: [{ name: 'plugin:vercel:vercel', status: 'connected', source: 'plugin' } as { name: string; status: string }, { name: 'plugin:figma:figma', status: 'connected', source: 'plugin' } as { name: string; status: string },
        { name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'neon', status: 'failed', scope: 'user' }]
    }
    await writeFile(join(root, 'config.toml'), '[mcp_servers.vapi]\ncommand = "vapi"\nenabled = false\n')
    process.env.FAKE_CODEX_MCP_STATUS = JSON.stringify({
      '': [codexServer('github', 'bearerToken', ['search']), codexServer('supabase', 'notLoggedIn'), codexServer('code-review', 'unsupported', [], 'code-review@openai-bundled'), codexServer('broken', 'unsupported'), codexServer('vapi', 'unsupported')]
    })
    process.env.FAKE_CODEX_MCP_STARTUP = JSON.stringify({ '': { github: { status: 'ready' }, broken: { status: 'failed', error: 'MCP client for `broken` failed to start: handshake timed out\nCaused by: deadline has elapsed' } } })
    const all = await h['mcp.accounts'](undefined)
    const rows = (a: McpAccount | undefined) => a?.servers.map((s) => [s.name, s.kind, s.state, ...(s.error ? [s.error] : []), ...(s.note ? [s.note] : []), ...(s.connectUrl ? [s.connectUrl] : [])])
    expect(rows(on(all, 'claude', 'cli'))).toEqual([
      ['claude.ai Gmail', 'connector', 'ready'], ['claude.ai Vercel', 'connector', 'ready'], ['linear', 'user', 'ready'], ['neon', 'user', 'failed', 'Error: spawn neon ENOENT'],
      ['plugin:figma:figma', 'plugin', 'not-set-up', 'Claude Code didn’t load its plugin on this account.'],
      ['plugin:vercel:vercel', 'plugin', 'ready', 'Covered by claude.ai Vercel on this account.']
    ])
    // The connectors are the CLI login's own: the added login gets claude.ai's connector settings and its email, to sign in there as.
    const added = on(all, 'claude', side.id)
    expect(added?.email).toBe('side@example.com')
    expect(rows(added)).toEqual([
      ['claude.ai Gmail', 'connector', 'not-set-up', 'claude.ai connectors are set up on claude.ai, for each account.', 'https://claude.ai/settings/connectors'],
      ['claude.ai Vercel', 'connector', 'not-set-up', 'claude.ai connectors are set up on claude.ai, for each account.', 'https://claude.ai/settings/connectors'],
      ['linear', 'user', 'needs-sign-in'], ['neon', 'user', 'failed', 'It failed to start, and Claude Code gave no reason.'],
      ['plugin:figma:figma', 'plugin', 'ready'], ['plugin:vercel:vercel', 'plugin', 'ready']
    ])
    // Codex's reasons come from how each server started on a thread, and a server it never started says so.
    expect(rows(on(all, 'codex', 'cli'))).toEqual([
      ['broken', 'user', 'failed', 'MCP client for `broken` failed to start: handshake timed out'],
      ['code-review', 'plugin', 'off', 'Not started by Codex'],
      ['github', 'user', 'ready'], ['supabase', 'user', 'needs-sign-in'], ['vapi', 'user', 'off', 'Off in Codex config']
    ])
    expect(all.flatMap((a) => a.servers).every((s) => STATES.includes(s.state) && s.connector === (s.kind === 'connector'))).toBe(true)
    expect((await fake.messages()).some((m) => m.method === 'thread/start' && m.params?.ephemeral === true)).toBe(true)
    await k.stop()
  })

  it('signs a Codex server in through Codex, ready on every Codex account, and Sign in to all goes through the rest', async () => {
    const { k, h, opened, steps, runs, on } = await setUp()
    process.env.FAKE_CODEX_LOGIN_EMAIL = 'work@example.com'
    const work = await h['accounts.add']({ provider: 'codex' })
    const workHome = k.providers.codexHome(work.id)!
    const list = [codexServer('github', 'bearerToken', ['search']), codexServer('supabase', 'notLoggedIn'), codexServer('linear', 'notLoggedIn'), codexServer('mobbin', 'notLoggedIn')]
    process.env.FAKE_CODEX_MCP_STATUS = JSON.stringify({ '': list, [workHome]: list })
    await h['mcp.accounts'](undefined)
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    opened.length = 0
    // Signed in, Codex lists supabase with its token, which the check after the sign-in reads (KERNEL-660).
    const signedIn = list.map((s) => (s.name === 'supabase' ? codexServer('supabase', 'oAuth', ['query']) : s))
    process.env.FAKE_CODEX_MCP_STATUS = JSON.stringify({ '': signedIn, [workHome]: signedIn })
    await h['accounts.mcpSignIn']({ provider: 'codex', accountId: work.id, server: 'supabase' })
    expect(opened).toEqual(['https://supabase.example.com/authorize?client=codex'])
    expect(steps).toEqual([
      { provider: 'codex', accountId: work.id, server: 'supabase', step: 'browser', url: 'https://supabase.example.com/authorize?client=codex' },
      { provider: 'codex', accountId: work.id, server: 'supabase', step: 'done' }
    ])
    // The login ran in the account's own home.
    const messages = await fake.messages()
    const login = messages.findIndex((m) => m.method === 'mcpServer/oauth/login')
    expect(messages[login].params.name).toBe('supabase')
    expect(messages.slice(0, login).filter((m) => 'started' in m).at(-1)?.started).toBe(workHome)
    // Codex keeps the token where every Codex account reads it, so it is ready on both without another check.
    const after = await h['mcp.accounts'](undefined)
    for (const id of ['cli', work.id]) expect(on(after, 'codex', id)?.servers.find((s) => s.name === 'supabase')?.state).toBe('ready')
    // Sign in to all skips what is ready, and a failure carries Codex's reason.
    process.env.FAKE_MCP_FAIL = 'linear'
    const run = await h['accounts.mcpSignInAll']({ provider: 'codex', accountId: 'cli' })
    expect(run).toEqual({ provider: 'codex', accountId: 'cli', servers: ['linear', 'mobbin'], done: ['mobbin'], failed: [{ server: 'linear', error: 'Codex said: access denied' }], finished: true })
    expect(runs.at(-1)).toEqual(run)
    // A server Codex can't sign in to says why, and Cancel stops a sign-in waiting in the browser.
    process.env.FAKE_CODEX_MCP_NO_OAUTH = 'github'
    await expect(h['accounts.mcpSignIn']({ provider: 'codex', accountId: 'cli', server: 'github' })).rejects.toThrow('Codex said: OAuth login is only supported for streamable HTTP servers.')
    process.env.FAKE_CODEX_MCP_LOGIN = 'wait'
    const waiting = h['accounts.mcpSignIn']({ provider: 'codex', accountId: 'cli', server: 'linear' })
    await until(() => steps.some((s) => s.server === 'linear' && s.step === 'browser' && s.accountId === 'cli' && steps.indexOf(s) > 3))
    await h['accounts.cancelAdd']({ provider: 'codex' })
    await expect(waiting).rejects.toThrow('Sign-in canceled.')
    for (const spy of logs) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/token|access_token|refresh/i)
      spy.mockRestore()
    }
    await k.stop()
  })

  it('shares a plugin installed on an added account with the CLI login before either starts Claude again', async () => {
    const { k, h, home } = await setUp()
    const root = join(home, '.claude')
    await mkdir(join(root, 'plugins'), { recursive: true })
    await writeFile(join(root, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }))
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    k.providers.claudeEnv(side.id)
    const own = join(folder, 'plugins', 'installed_plugins.json')
    expect((await lstat(own)).isSymbolicLink()).toBe(true)
    // Claude Code on the account installs vercel, writing a file of its own over the link.
    await rm(own)
    await writeFile(own, JSON.stringify({ version: 2, plugins: { 'vercel@official': [{ scope: 'user', installPath: join(folder, 'plugins', 'cache', 'official', 'vercel', '0.50.0'), version: '0.50.0' }] } }))
    k.providers.claudeEnv(side.id)
    expect(JSON.parse(await readFile(join(root, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['vercel@official'][0].installPath).toBe(join(root, 'plugins', 'cache', 'official', 'vercel', '0.50.0'))
    expect((await lstat(own)).isSymbolicLink()).toBe(true)
    await k.stop()
  })

  it('keeps an ignored server across a restart and leaves it, and one off in every room, out of every warning', async () => {
    const { k, h, home, needed, logins } = await (async () => {
      const t = await setUp({ checkMcpOnAdd: true })
      return { ...t, logins: async () => (await t.claude.calls()).filter((c) => c.args.startsWith('mcp login')).map((c) => c.args.slice('mcp login '.length)) }
    })()
    sdk.mcp = { '*': [{ name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'figma', status: 'needs-auth', scope: 'user' }, { name: 'neon', status: 'needs-auth', scope: 'user' }] }
    const repo = await tempRepo()
    await k.addRoom(repo)
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[disabled]\nmcp = ["neon"]\n')
    const side = await h['accounts.add']({ provider: 'claude' })
    // The notice after adding leaves out neon, which the only room switches off.
    await until(() => needed.length)
    expect(needed[0].servers).toEqual(['figma', 'linear'])
    const out = await h['accounts.mcpIgnore']({ provider: 'claude', accountId: side.id, server: 'figma', ignored: true })
    const servers = (list: McpAccount[]) => list.find((a) => a.accountId === side.id)?.servers.map((s) => [s.name, s.state, ...(s.roomOff ? ['roomOff'] : [])])
    expect(servers(out)).toEqual([['figma', 'ignored'], ['linear', 'needs-sign-in'], ['neon', 'needs-sign-in', 'roomOff']])
    // The row's warning counts only linear.
    expect((await h['accounts.list'](undefined)).find((a) => a.id === side.id)?.mcpSignIns).toEqual([{ server: 'linear', connector: false }])
    // Sign in to all signs in linear alone.
    const run = await h['accounts.mcpSignInAll']({ provider: 'claude', accountId: side.id })
    expect(run.servers).toEqual(['linear'])
    expect(await logins()).toEqual(['linear'])
    // Ignore is kept in accounts.json, so a new Kernel on the same data folder still ignores it.
    const dataDir = (k.o as KernelOptions).dataDir
    await k.stop()
    const again = new Kernel({ dataDir, home, cipher })
    await again.start()
    expect(again.providers.mcpIgnored('claude', side.id)).toEqual(['figma'])
    // Stop ignoring takes it out of accounts.json.
    await again.providers.setMcpIgnored('claude', side.id, 'figma', false)
    expect(again.providers.mcpIgnored('claude', side.id)).toEqual([])
    expect(JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')).claude.accounts[0].mcpIgnored).toBeUndefined()
    await again.stop()
  })
})

describe('Off on purpose, Set up this account, re-check on return and one Codex view (KERNEL-660)', () => {
  const keys = ['FAKE_EMAIL', 'FAKE_MCP_FAIL', 'FAKE_CODEX_MCP_STATUS', 'FAKE_CODEX_MCP_STARTUP', 'FAKE_CODEX_LOGIN_EMAIL'] as const
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })

  async function setUp() {
    const t = await kernel()
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    const claude = await fakeClaude()
    await t.k.providers.setPath('claude', { path: claude.bin })
    const runs: McpSignInAll[] = []
    const connects: McpConnect[] = []
    const views: McpAccount[][] = []
    const order: string[] = []
    bus.on('push', (e: PushEvent) => {
      if (e.type === 'account.mcpSignInAll') { runs.push(e.run); if (e.run.current) order.push(`sign in ${e.run.current}`) }
      if (e.type === 'account.mcpConnect') { connects.push(e.connect); order.push('connect') }
      if (e.type === 'mcp.accounts') views.push(e.accounts)
    })
    const h = t.k.handlers()
    const logins = async () => (await claude.calls()).filter((c) => c.args.startsWith('mcp login')).map((c) => c.args.slice('mcp login '.length))
    const on = (list: McpAccount[] | undefined, provider: string, id: string) => list?.find((a) => a.provider === provider && a.accountId === id)
    return { ...t, h, runs, connects, views, order, logins, on }
  }

  const codexServer = (name: string, authStatus: string, tools: string[] = [], pluginId: string | null = null) => ({ name, authStatus, runtimeStatus: null, pluginId, tools: Object.fromEntries(tools.map((t) => [t, {}])) })

  it('reads servers switched off on purpose as off with a reason, and leaves them out of the counts and Sign in to all', async () => {
    const { k, h, root, on } = await setUp()
    await writeFile(join(root, 'config.toml'), '[mcp_servers.vapi]\ncommand = "vapi"\nenabled = false\n\n[mcp_servers.computer-use]\ncommand = "cu"\nenabled = false\n')
    process.env.FAKE_CODEX_MCP_STATUS = JSON.stringify({
      '': [codexServer('github', 'bearerToken', ['search']), codexServer('supabase', 'notLoggedIn'), codexServer('linear', 'notLoggedIn'), codexServer('broken', 'unsupported'),
        codexServer('code-review', 'unsupported', [], 'code-review@openai-bundled'), codexServer('codex_app', 'unsupported', [], 'codex_app@openai-bundled'), codexServer('vapi', 'unsupported')]
    })
    process.env.FAKE_CODEX_MCP_STARTUP = JSON.stringify({ '': { broken: { status: 'failed', error: 'MCP client for `broken` failed to start: handshake timed out' } } })
    await h['accounts.mcpIgnore']({ provider: 'codex', accountId: 'cli', server: 'linear', ignored: true })
    const codex = on(await h['mcp.accounts'](undefined), 'codex', 'cli')
    expect(codex?.servers.map((s) => [s.name, s.state, ...(s.note ? [s.note] : [])])).toEqual([
      ['broken', 'failed'], ['code-review', 'off', 'Not started by Codex'], ['codex_app', 'off', 'Not started by Codex'], ['computer-use', 'off', 'Off in Codex config'],
      ['github', 'ready'], ['linear', 'ignored'], ['supabase', 'needs-sign-in'], ['vapi', 'off', 'Off in Codex config']
    ])
    // Needs you: supabase's sign-in and broken's failure. Not the four off, nor the ignored one.
    expect([codex?.needsYou, codex?.ready]).toEqual([2, 1])
    process.env.FAKE_MCP_FAIL = 'supabase'
    expect((await h['accounts.mcpSignInAll']({ provider: 'codex', accountId: 'cli' })).servers).toEqual(['supabase'])
    await k.stop()
  })

  it('sets an account up from a ticked list: ignores the rest in one write, sends the connectors as one step, signs in in order and reports failures', async () => {
    const { k, h, runs, connects, order, logins, on } = await setUp()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    sdk.mcp = {
      '': [{ name: 'claude.ai Gmail', status: 'connected', scope: 'claudeai' }, { name: 'claude.ai Google Drive', status: 'connected', scope: 'claudeai' }, { name: 'linear', status: 'connected', scope: 'user' }, { name: 'figma', status: 'connected', scope: 'user' }, { name: 'neon', status: 'connected', scope: 'user' }],
      [folder]: [{ name: 'linear', status: 'needs-auth', scope: 'user' }, { name: 'figma', status: 'needs-auth', scope: 'user' }, { name: 'neon', status: 'failed', scope: 'user' }]
    }
    const before = on(await h['mcp.accounts'](undefined), 'claude', side.id)
    expect(before?.servers.filter((s) => s.state !== 'ready').map((s) => s.name)).toEqual(['claude.ai Gmail', 'claude.ai Google Drive', 'figma', 'linear', 'neon'])
    expect(before?.needsYou).toBe(5)
    process.env.FAKE_MCP_FAIL = 'figma'
    const ignore = vi.spyOn(k.providers, 'ignoreMcp')
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    const run = await h['accounts.mcpSetUp']({ provider: 'claude', accountId: side.id, include: ['claude.ai Google Drive', 'linear', 'figma', 'claude.ai Gmail'] })
    const connect = { provider: 'claude', accountId: side.id, email: 'side@example.com', url: 'https://claude.ai/settings/connectors', servers: ['claude.ai Google Drive', 'claude.ai Gmail'] }
    expect(run).toEqual({
      accountId: side.id, servers: ['linear', 'figma'], done: ['linear'], failed: [{ server: 'figma', error: 'Claude Code said: Couldn\'t complete authentication for "figma": access denied' }],
      finished: true, ignored: ['neon'], connect
    })
    // One write for what wasn't ticked, one step for both connectors at the first one's turn, then the sign-ins in order.
    expect(ignore.mock.calls).toEqual([['claude', side.id, ['neon']]])
    expect(k.providers.mcpIgnored('claude', side.id)).toEqual(['neon'])
    expect(connects).toEqual([connect])
    expect(order).toEqual(['connect', 'sign in linear', 'sign in figma'])
    expect(await logins()).toEqual(['linear', 'figma'])
    expect(runs.at(-1)).toEqual(run)
    for (const spy of logs) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/token|access_token|refresh/i)
      spy.mockRestore()
    }
    await k.stop()
  })

  it('checks an account again after each sign-in, and on focus only the accounts with something pending, once every 10 seconds', async () => {
    const { k, h, views, on } = await setUp()
    const side = await h['accounts.add']({ provider: 'claude' })
    const folder = k.providers.claudeHome(side.id)
    sdk.mcp = { '': [{ name: 'linear', status: 'connected', scope: 'user' }, { name: 'figma', status: 'connected', scope: 'user' }], [folder]: [{ name: 'linear', status: 'needs-auth', scope: 'user' }] }
    process.env.FAKE_CODEX_MCP_STATUS = JSON.stringify({ '': [codexServer('github', 'bearerToken', ['search'])] })
    await h['mcp.accounts'](undefined)
    const checks = vi.spyOn(k.providers, 'mcpServersOn')
    // A sign-in finished: the account is checked again, and what Claude Code says then is what shows.
    sdk.mcp[folder] = [{ name: 'linear', status: 'connected', scope: 'user' }, { name: 'figma', status: 'needs-auth', scope: 'user' }]
    await h['accounts.mcpSignIn']({ provider: 'claude', accountId: side.id, server: 'linear' })
    // Before the check, figma reads not set up there, copied from the CLI login. The check finds it waiting on a sign-in.
    const after = await until(() => (on(views.at(-1), 'claude', side.id)?.servers.some((s) => s.name === 'figma' && s.state === 'needs-sign-in') ? views.at(-1) : undefined))
    expect(checks.mock.calls).toEqual([['claude', side.id]])
    expect(on(after, 'claude', side.id)?.needsYou).toBe(1)
    // Focus: only the added login has something pending.
    checks.mockClear()
    sdk.mcp[folder] = [{ name: 'linear', status: 'connected', scope: 'user' }, { name: 'figma', status: 'connected', scope: 'user' }]
    const back = await h['mcp.recheck'](undefined)
    expect(checks.mock.calls).toEqual([['claude', side.id]])
    expect(on(back, 'claude', side.id)?.needsYou).toBe(0)
    expect(views.at(-1)).toEqual(back)
    // Focus again within 10 seconds checks nothing, and nor does focus later with nothing pending.
    sdk.mcp[folder] = [{ name: 'linear', status: 'needs-auth', scope: 'user' }]
    await h['mcp.recheck'](undefined)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11_000)
    await h['mcp.recheck'](undefined)
    clock.mockRestore()
    expect(checks).toHaveBeenCalledTimes(1)
    checks.mockRestore()
    await k.stop()
  })

  it('marks Codex accounts whose servers read the same as shared, and stops when they differ', async () => {
    const { k, h, on } = await setUp()
    process.env.FAKE_CODEX_LOGIN_EMAIL = 'work@example.com'
    const work = await h['accounts.add']({ provider: 'codex' })
    const workHome = k.providers.codexHome(work.id)!
    const list = [codexServer('github', 'bearerToken', ['search']), codexServer('supabase', 'notLoggedIn')]
    process.env.FAKE_CODEX_MCP_STATUS = JSON.stringify({ '': list, [workHome]: list })
    sdk.mcp = { '': [{ name: 'linear', status: 'connected', scope: 'user' }] }
    const all = await h['mcp.accounts'](undefined)
    expect(on(all, 'codex', 'cli')?.sharedWith).toEqual([work.id])
    expect(on(all, 'codex', work.id)?.sharedWith).toEqual(['cli'])
    expect(on(all, 'claude', 'cli')?.sharedWith).toBeUndefined()
    // Ignoring a server on one of them makes them read differently.
    const apart = await h['accounts.mcpIgnore']({ provider: 'codex', accountId: work.id, server: 'supabase', ignored: true })
    expect(apart.filter((a) => a.sharedWith)).toEqual([])
    await k.stop()
  })
})
