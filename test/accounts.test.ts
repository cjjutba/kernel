import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountAddStep, AccountProfile, Chat, McpSignInStep, RateLimit, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { limitProvider } from '@shared/providers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import type { KernelOptions } from '../src/main/features/options'
import { sessionEnv } from '../src/main/services/providers/claude'
import { credentialsItem } from '../src/main/services/providers/claudeHome'
import { joinLabels } from '@shared/waits'
import { fakeCodex } from './helpers/fakeCodex'
import { fakeClaude, LINK, MCP_LINK } from './helpers/fakeClaude'
import { fakeKeychain } from './helpers/fakeKeychain'
import { tempRepo } from './helpers'

// Claude Code's usage call, answered by the account each short session runs on: its CLAUDE_CONFIG_DIR, '' for the CLI's own
// login (KERNEL-567). `usage` holds each account's 5-hour use in percent. `mcp` holds the MCP servers each account lists
// (KERNEL-616). No Claude Code process starts.
const sdk = vi.hoisted(() => ({ usage: {} as Record<string, number>, mcp: {} as Record<string, { name: string; status: string; scope?: string }[]>, probes: [] as { dir: string; token?: string }[], hold: undefined as Promise<void> | undefined }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: { env?: Record<string, string> } }) => {
    const dir = options.env?.CLAUDE_CONFIG_DIR ?? ''
    sdk.probes.push({ dir, ...(options.env?.CLAUDE_CODE_OAUTH_TOKEN ? { token: options.env.CLAUDE_CODE_OAUTH_TOKEN } : {}) })
    const window = (used: number) => ({ utilization: used, resets_at: new Date(Date.now() + 3600_000).toISOString() })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => {},
      mcpServerStatus: async () => sdk.mcp[dir] ?? [],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
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
beforeEach(async () => { fake = await fakeCodex(); process.env.FAKE_CODEX_LOG = fake.log; delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR; sdk.usage = {}; sdk.mcp = {}; sdk.probes = []; sdk.hold = undefined })
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
    return { ...t, h, ids, room, repo, folder }
  }

  /** A rejection of the 5-hour window, as a session reports it: on Claude's CLI login unless `l` says otherwise. */
  const reject = (k: Kernel, l: Partial<RateLimit> = {}) => (k.sessions as unknown as { mergeLimits: (l: Partial<RateLimit>[]) => void }).mergeLimits([{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: S(Date.now() + 3600_000), ...l }])
  const moving = (k: Kernel) => [...(k.account as unknown as { moving: Map<string, { state: string }> }).moving.values()].map((m) => m.state)
  const notes = (k: Kernel, chatId = 'chat') => k.store.items(chatId).flatMap((i) => (i.kind === 'note' ? [i.text] : []))

  it('moves Claude to the signed-in account with the lowest 5-hour use, notes it in the chat, and stays there when the old account resets', async () => {
    const { k, ids, room, folder } = await setUp(['Side', 'Personal'])
    sdk.usage = { '': 100, [folder('Side')]: 60, [folder('Personal')]: 20 }
    await k.config.setSettings({ accounts: { switchAtLimit: { claude: true } } })
    sdk.probes = []
    reject(k)
    await until(() => k.providers.active('claude') === ids.Personal)
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
