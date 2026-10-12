import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountAddStep, AccountProfile, Chat, RateLimit, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { limitProvider } from '@shared/providers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { sessionEnv } from '../src/main/services/providers/claude'
import { fakeCodex } from './helpers/fakeCodex'
import { fakeClaude, LINK } from './helpers/fakeClaude'
import { tempRepo } from './helpers'

// Claude Code's usage call, answered by the account each short session runs on: its CLAUDE_CONFIG_DIR, '' for the CLI's own
// login (KERNEL-567). `usage` holds each account's 5-hour use in percent. No Claude Code process starts.
const sdk = vi.hoisted(() => ({ usage: {} as Record<string, number>, probes: [] as { dir: string; token?: string }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: { env?: Record<string, string> } }) => {
    const dir = options.env?.CLAUDE_CONFIG_DIR ?? ''
    sdk.probes.push({ dir, ...(options.env?.CLAUDE_CODE_OAUTH_TOKEN ? { token: options.env.CLAUDE_CODE_OAUTH_TOKEN } : {}) })
    const window = (used: number) => ({ utilization: used, resets_at: new Date(Date.now() + 3600_000).toISOString() })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => {},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        const used = sdk.usage[dir]
        if (used === undefined) throw new Error('not supported')
        return { rate_limits: { five_hour: window(used), seven_day: window(used / 2) } }
      }
    }
  }
}))

/** Encrypts by reversing, so a test can tell a stored token from the plain one. */
const cipher = { encrypt: (t: string) => `enc:${[...t].reverse().join('')}`, decrypt: (d: string) => [...d.slice(4)].reverse().join('') }

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
beforeEach(async () => { fake = await fakeCodex(); process.env.FAKE_CODEX_LOG = fake.log; delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR; sdk.usage = {}; sdk.probes = [] })
afterEach(() => {
  process.env.FAKE_CODEX_LOG = saved.log
  if (saved.codexHome) process.env.CODEX_HOME = saved.codexHome
  if (saved.claudeDir) process.env.CLAUDE_CONFIG_DIR = saved.claudeDir
  bus.removeAllListeners('push')
})

async function kernel() {
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  const root = join(home, '.codex')
  await mkdir(join(root, 'skills', 'impeccable'), { recursive: true })
  await writeFile(join(root, 'config.toml'), 'model = "gpt-6-astra"\n')
  await writeFile(join(root, 'auth.json'), '{"cli":true}')
  const opened: string[] = []
  const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home, cipher, openExternal: async (url) => { opened.push(url) } })
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
    expect(added).toMatchObject({ provider: 'codex', label: 'cj@example.com', email: 'cj@example.com', plan: 'ChatGPT Plus', cli: false, active: false, signedIn: true })
    expect(opened).toEqual(['https://auth.openai.com/oauth/authorize?fake=1'])
    expect(steps.map((s) => s.step)).toEqual(['browser', 'done'])
    expect(existsSync(join(k.providers.codexHome(added.id)!, 'auth.json'))).toBe(true)
    const list = await k.handlers()['accounts.list']()
    expect(list.filter((a) => a.provider === 'codex').map((a) => [a.label, a.cli, a.active])).toEqual([['cj@example.com', true, true], ['cj@example.com', false, false]])
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
