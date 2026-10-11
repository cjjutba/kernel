import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readlink, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountAddStep, Chat, RateLimit, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { fakeCodex } from './helpers/fakeCodex'
import { fakeClaude, TOKEN } from './helpers/fakeClaude'
import { tempRepo } from './helpers'

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
const saved = { log: process.env.FAKE_CODEX_LOG, codexHome: process.env.CODEX_HOME }
beforeEach(async () => { fake = await fakeCodex(); process.env.FAKE_CODEX_LOG = fake.log; delete process.env.CODEX_HOME })
afterEach(() => { process.env.FAKE_CODEX_LOG = saved.log; if (saved.codexHome) process.env.CODEX_HOME = saved.codexHome; bus.removeAllListeners('push') })

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

  it('adds an account with a ChatGPT sign-in in the browser, and leaves the CLI login active until the user switches', async () => {
    const { k, opened } = await kernel()
    const steps: AccountAddStep[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.add') steps.push(e.add) })
    const added = await k.handlers()['accounts.add']({ provider: 'codex', label: 'Work' })
    expect(added).toMatchObject({ provider: 'codex', label: 'Work', email: 'cj@example.com', plan: 'ChatGPT Plus', cli: false, active: false, signedIn: true })
    expect(opened).toEqual(['https://auth.openai.com/oauth/authorize?fake=1'])
    expect(steps.map((s) => s.step)).toEqual(['browser', 'done'])
    expect(existsSync(join(k.providers.codexHome(added.id)!, 'auth.json'))).toBe(true)
    const list = await k.handlers()['accounts.list']()
    expect(list.filter((a) => a.provider === 'codex').map((a) => [a.label, a.cli, a.active])).toEqual([['cj@example.com', true, true], ['Work', false, false]])
    expect(k.providers.codexHome()).toBeUndefined()
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

describe('Claude accounts (KERNEL-406)', () => {
  const fakeEnv = { wrap: process.env.FAKE_WRAP, none: process.env.FAKE_NO_TOKEN, code: process.env.FAKE_CODE_FILE }
  afterEach(() => {
    for (const [key, value] of [['FAKE_WRAP', fakeEnv.wrap], ['FAKE_NO_TOKEN', fakeEnv.none], ['FAKE_CODE_FILE', fakeEnv.code]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })

  /** A Kernel whose Claude is a fake `setup-token`, and whose CLI login reads as a Max plan. */
  async function claudeKernel() {
    const t = await kernel()
    t.k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    await t.k.providers.setPath('claude', { path: await fakeClaude() })
    const steps: AccountAddStep[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.add') steps.push(e.add) })
    return { ...t, h: t.k.handlers(), steps }
  }

  it('adds an account from claude setup-token with the name and plan given, and the plan defaults follow it once in use', async () => {
    const { k, h, steps } = await claudeKernel()
    process.env.FAKE_WRAP = '60'
    await expect(h['accounts.add']({ provider: 'claude', plan: 'pro' })).rejects.toThrow('Give the account a name.')
    await expect(h['accounts.add']({ provider: 'claude', label: 'Side' })).rejects.toThrow("Pick the account's plan.")
    const added = await h['accounts.add']({ provider: 'claude', label: ' Side ', plan: 'pro' })
    expect(added).toMatchObject({ label: 'Side', plan: 'Claude Pro', cli: false, active: false, signedIn: true, usageFromTurns: true })
    expect(steps.map((s) => s.step)).toEqual(['browser', 'done'])
    expect(steps[0].url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/)
    expect((await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude').map((a) => a.label)).toEqual(['Claude Code’s own login', 'Side'])
    // On the CLI's own login, the plan is the CLI's.
    await h['account.get'](undefined)
    expect(k.settings.plan).toBe('max')
    await h['accounts.switch']({ provider: 'claude', accountId: added.id })
    expect(k.providers.claudeEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    expect(await h['account.get'](undefined)).toMatchObject({ signedIn: true, name: 'Side', plan: 'Claude Pro' })
    expect(k.settings.plan).toBe('pro')
    expect(k.settings.models.roles.lead.model).toBe('claude-sonnet-5-5')
    expect(await k.providers.status('claude')).toMatchObject({ signedIn: true, loginMethod: 'Token from claude setup-token', plan: 'Claude Pro' })
    expect((await k.providers.status('claude')).email).toBeUndefined()
    await h['accounts.switch']({ provider: 'claude', accountId: 'cli' })
    expect(k.settings.plan).toBe('max')
    await k.stop()
  })

  it('says why when no token came, adds nothing, and can be tried again', async () => {
    const { k, h, steps } = await claudeKernel()
    process.env.FAKE_NO_TOKEN = '1'
    await expect(h['accounts.add']({ provider: 'claude', label: 'Side', plan: 'max' })).rejects.toThrow("Kernel couldn't read a token from claude setup-token.")
    expect(steps.at(-1)).toMatchObject({ step: 'failed', error: "Kernel couldn't read a token from claude setup-token." })
    expect((await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude')).toHaveLength(1)
    delete process.env.FAKE_NO_TOKEN
    expect(await h['accounts.add']({ provider: 'claude', label: 'Side', plan: 'max' })).toMatchObject({ label: 'Side', plan: 'Claude Max' })
    await k.stop()
  })

  it('keeps an account whose token a session refused signed out until Run login gets a new one, with the code its page shows', async () => {
    const { k, h, steps } = await claudeKernel()
    const added = await h['accounts.add']({ provider: 'claude', label: 'Side', plan: 'team' })
    await h['accounts.switch']({ provider: 'claude', accountId: added.id })
    k.account.signedOut('claude')
    expect((await h['accounts.list'](undefined)).find((a) => a.id === added.id)?.signedIn).toBe(false)
    expect(await h['account.get'](undefined)).toMatchObject({ signedIn: false })
    expect(k.sessions.heldFor('claude')).toContain('auth')
    // Run login on the added account runs setup-token again; this time its page shows a code.
    const codeFile = join(await mkdtemp(join(tmpdir(), 'kernel-code-')), 'code')
    process.env.FAKE_CODE_FILE = codeFile
    bus.on('push', (e: PushEvent) => { if (e.type === 'account.add' && e.add.step === 'code') void h['accounts.code']({ provider: 'claude', code: 'xyz-789' }) })
    await expect(h['accounts.code']({ provider: 'claude', code: 'early' })).rejects.toThrow('No sign-in is waiting for a code.')
    await h['providers.signIn']({ provider: 'claude' })
    expect(steps.map((s) => s.step).slice(-3)).toEqual(['browser', 'code', 'done'])
    expect((await (await import('node:fs/promises')).readFile(codeFile, 'utf8')).trim()).toBe('xyz-789')
    expect((await h['accounts.list'](undefined)).find((a) => a.id === added.id)?.signedIn).toBe(true)
    expect(k.sessions.heldFor('claude')).not.toContain('auth')
    await k.stop()
  })

  it("passes the active account's token to Claude sessions, kept encrypted on disk, and nothing for the CLI login", async () => {
    const { k } = await kernel()
    const p = k.providers as unknown as { load: () => { claude: { accounts: { id: string; label: string; createdAt: number }[] } }; save: () => Promise<void>; saveToken: (id: string, t?: string) => Promise<void>; tokensFile: string }
    p.load().claude.accounts.push({ id: 'work', label: 'Work', createdAt: 1 })
    await p.save()
    await p.saveToken('work', 'sk-ant-oat01-secret')
    expect(JSON.stringify(JSON.parse(await (await import('node:fs/promises')).readFile(p.tokensFile, 'utf8')))).not.toContain('secret')
    expect(k.providers.claudeEnv()).toEqual({})
    await k.handlers()['accounts.switch']({ provider: 'claude', accountId: 'work' })
    expect(k.providers.claudeEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret' })
    const deps = (k.sessions as unknown as { d: { claudeEnv: () => Record<string, string>; accountFor: (p: string) => string | undefined } }).d
    expect(deps.claudeEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret' })
    expect(deps.accountFor('claude')).toBe('work')
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
