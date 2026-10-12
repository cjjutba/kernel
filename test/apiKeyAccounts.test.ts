import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, RateLimit, Workspace } from '@shared/types'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { checkApiKey } from '../src/main/services/providers/apiKeys'
import { fakeCodex, script } from './helpers/fakeCodex'
import { tempRepo } from './helpers'

// API key accounts in the engine (KERNEL-523). Anthropic's and OpenAI's models lists are a stubbed fetch, and Codex is the
// fake app-server, so nothing here reaches either API.

/** Encrypts by reversing, so a test can tell a stored key from the plain one. */
const cipher = { encrypt: (t: string) => `enc:${[...t].reverse().join('')}`, decrypt: (d: string) => [...d.slice(4)].reverse().join('') }

const CLAUDE_KEY = 'sk-ant-api03-' + 'Kq7_'.repeat(20)
const CLAUDE_KEY_2 = 'sk-ant-api03-' + 'Wd2-'.repeat(20)
const OPENAI_KEY = 'sk-proj-' + 'Zp4-'.repeat(25)
const GOOD = new Set([CLAUDE_KEY, CLAUDE_KEY_2, OPENAI_KEY])

/** Answers like Anthropic's and OpenAI's models lists: 200 for the keys above, 401 for any other. Records each request. */
function keyApi() {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ url: String(url), headers })
    const key = headers['x-api-key'] ?? headers.authorization?.replace(/^Bearer /, '')
    return new Response('{}', { status: key && GOOD.has(key) ? 200 : 401 })
  }) as typeof fetch
  return { calls, fetch: fetchImpl }
}

async function until<T>(check: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Every regular file under `dir`, links not followed, that holds `secret`. */
async function filesHolding(dir: string, secret: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const s = await lstat(path)
    if (s.isDirectory()) out.push(...await filesHolding(path, secret))
    else if (s.isFile() && (await readFile(path)).includes(secret)) out.push(path)
  }
  return out
}

let fake: Awaited<ReturnType<typeof fakeCodex>>
const saved = { log: process.env.FAKE_CODEX_LOG, codexHome: process.env.CODEX_HOME, openai: process.env.OPENAI_API_KEY, codexKey: process.env.CODEX_API_KEY }
const put = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value }
beforeEach(async () => { fake = await fakeCodex(); process.env.FAKE_CODEX_LOG = fake.log; delete process.env.CODEX_HOME })
afterEach(() => {
  put('FAKE_CODEX_LOG', saved.log); put('CODEX_HOME', saved.codexHome); put('OPENAI_API_KEY', saved.openai); put('CODEX_API_KEY', saved.codexKey)
  bus.removeAllListeners('push')
})

/** A `claude` that only answers `--version` and `auth status`, so nothing reads the Mac's own login. */
async function fakeClaudeCli(): Promise<string> {
  const bin = join(await mkdtemp(join(tmpdir(), 'kernel-bin-')), 'claude')
  await writeFile(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.292 (Claude Code)";; auth) echo '{"loggedIn":true,"email":"cj@example.com","subscriptionType":"max"}';; esac\n`)
  await chmod(bin, 0o755)
  return bin
}

/** A Kernel with the fake Codex and Claude, a CLI Claude login on `plan`, and the stubbed key checks. */
async function kernel(plan = 'max') {
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await mkdir(join(home, '.codex', 'skills'), { recursive: true })
  await writeFile(join(home, '.codex', 'config.toml'), 'model = "gpt-6-astra"\n')
  const api = keyApi()
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const k = new Kernel({ dataDir, home, cipher, fetch: api.fetch })
  await k.start()
  await k.providers.setPath('codex', { path: fake.bin })
  await k.providers.setPath('claude', { path: await fakeClaudeCli() })
  const reader = { plan }
  k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: reader.plan })
  return { k, h: k.handlers(), api, dataDir, home, reader }
}

/** A room with one Claude chat and one Codex chat in the same workspace. */
async function chats(k: Kernel) {
  const repo = await tempRepo()
  const room = await k.addRoom(repo)
  const ws: Workspace = { id: 'ws', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'kernel-lead', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  k.store.saveWorkspace(ws)
  const codex: Chat = { id: 'codex', workspaceId: 'ws', title: 'x', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'low', plan: false, createdAt: 1 }
  k.store.saveChat(codex)
  return { repo, room, ws }
}

describe('checking a key (KERNEL-523)', () => {
  it("asks Anthropic's models list for a Claude key, and OpenAI's for a Codex key, once each", async () => {
    const api = keyApi()
    await checkApiKey('claude', CLAUDE_KEY, api.fetch)
    await checkApiKey('codex', OPENAI_KEY, api.fetch)
    expect(api.calls).toEqual([
      { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' } },
      { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${OPENAI_KEY}` } }
    ])
  })

  it('says why in plain words when the check fails, and never repeats the key', async () => {
    const answering = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch
    const offline = (async () => { throw new TypeError(`fetch failed for ${CLAUDE_KEY}`) }) as unknown as typeof fetch
    const why = (p: 'claude' | 'codex', f: typeof fetch) => checkApiKey(p, CLAUDE_KEY, f).then(() => 'ok', (e: Error) => e.message)
    const reasons = [
      await why('claude', answering(401)), await why('codex', answering(401)), await why('claude', answering(403)),
      await why('claude', answering(429)), await why('codex', answering(500)), await why('claude', offline)
    ]
    expect(reasons).toEqual([
      "Anthropic didn't accept that key. Check that you copied all of it.",
      "OpenAI didn't accept that key. Check that you copied all of it.",
      "Anthropic says that key isn't allowed to use the API.",
      'Anthropic is limiting requests for that key. Try again in a minute.',
      'OpenAI answered 500 when Kernel checked the key. Try again in a minute.',
      "Kernel couldn't reach Anthropic to check the key. Check your connection and try again."
    ])
  })
})

describe("showing the provider's reason when a check fails (KERNEL-582)", () => {
  const answering = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch
  /** An error body shaped as each provider sends one. */
  const body = (p: 'claude' | 'codex', message: string) => JSON.stringify(p === 'claude'
    ? { type: 'error', error: { type: 'invalid_request_error', message } }
    : { error: { message, type: 'invalid_request_error', param: null, code: null } })
  const keyOf = (p: 'claude' | 'codex') => p === 'claude' ? CLAUDE_KEY : OPENAI_KEY
  const why = (p: 'claude' | 'codex', f: typeof fetch) => checkApiKey(p, keyOf(p), f).then(() => 'ok', (e: Error) => e.message)

  it("shows the provider's message for a 400, and says it was turned down without a reason when there is none", async () => {
    expect([
      await why('claude', answering(400, body('claude', 'Your credit balance is too low to access the Anthropic API.'))),
      await why('codex', answering(400, body('codex', 'Your organization must be verified to use this API.'))),
      await why('claude', answering(400, '{}')),
      await why('codex', answering(400, body('codex', '  ')))
    ]).toEqual([
      'Anthropic says: Your credit balance is too low to access the Anthropic API.',
      'OpenAI says: Your organization must be verified to use this API.',
      'Anthropic turned the key down without saying why. Check the key and your Anthropic account.',
      'OpenAI turned the key down without saying why. Check the key and your OpenAI account.'
    ])
  })

  it("keeps the 401, 403 and 429 wording and adds the provider's message after it", async () => {
    expect([
      await why('claude', answering(401, body('claude', 'invalid x-api-key'))),
      await why('codex', answering(401, body('codex', 'Incorrect API key provided: sk-proj-****Zp4-.'))),
      await why('codex', answering(403, body('codex', 'You are not allowed to sample from this model.'))),
      await why('claude', answering(429, body('claude', 'Number of request tokens has exceeded your per-minute rate limit.')))
    ]).toEqual([
      "Anthropic didn't accept that key. Check that you copied all of it. Anthropic says: invalid x-api-key",
      "OpenAI didn't accept that key. Check that you copied all of it. OpenAI says: Incorrect API key provided: sk-proj-****Zp4-.",
      "OpenAI says that key isn't allowed to use the API. OpenAI says: You are not allowed to sample from this model.",
      'Anthropic is limiting requests for that key. Try again in a minute. Anthropic says: Number of request tokens has exceeded your per-minute rate limit.'
    ])
  })

  it('falls back to plain words for a body that is empty, not JSON, or has no message', async () => {
    expect([
      await why('claude', answering(400, '<html><body>Bad request</body></html>')),
      await why('codex', answering(400, '')),
      await why('claude', answering(502, 'upstream connect error')),
      await why('codex', answering(500, JSON.stringify({ error: 'server_error' }))),
      await why('claude', answering(401, 'null'))
    ]).toEqual([
      'Anthropic turned the key down without saying why. Check the key and your Anthropic account.',
      'OpenAI turned the key down without saying why. Check the key and your OpenAI account.',
      'Anthropic answered 502 when Kernel checked the key. Try again in a minute.',
      'OpenAI answered 500 when Kernel checked the key. Try again in a minute.',
      "Anthropic didn't accept that key. Check that you copied all of it."
    ])
  })

  it('never repeats the key, and keeps the message to one line of about 300 characters', async () => {
    for (const p of ['claude', 'codex'] as const) {
      const key = keyOf(p)
      const echoed = await why(p, answering(400, body(p, `The key ${key} can't be used yet.\nTry again later. (${key})`)))
      expect(echoed).toBe(`${p === 'claude' ? 'Anthropic' : 'OpenAI'} says: The key [your key] can't be used yet. Try again later. ([your key])`)
      // The key sits across the cut, so trimming before replacing it would leave its start behind.
      const long = await why(p, answering(401, body(p, `${'word '.repeat(54)}${key}\n\n${'more '.repeat(200)}`)))
      expect(long).not.toContain(key.slice(0, 20))
      expect(long).not.toMatch(/\n/)
      expect(long.split(' says: ')[1].length).toBeLessThanOrEqual(300)
      expect(long.endsWith('…')).toBe(true)
    }
  })
})

describe('Claude API key accounts (KERNEL-523)', () => {
  it('adds a checked key encrypted on disk, and hands it only to sessions once the user switches to it', async () => {
    const { k, h, api, dataDir } = await kernel()
    await expect(h['accounts.addKey']({ provider: 'claude', label: ' ', key: CLAUDE_KEY })).rejects.toThrow('Give the account a name.')
    await expect(h['accounts.addKey']({ provider: 'claude', label: 'Billing', key: '  ' })).rejects.toThrow('Paste the API key.')
    await expect(h['accounts.addKey']({ provider: 'claude', label: 'Billing', key: 'sk-ant-api03-wrong' })).rejects.toThrow("Anthropic didn't accept that key.")
    expect((await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude')).toHaveLength(1)
    expect(existsSync(join(dataDir, 'api-keys.json'))).toBe(false)
    api.calls.length = 0
    const added = await h['accounts.addKey']({ provider: 'claude', label: ' Billing ', key: ` ${CLAUDE_KEY}\n` })
    expect(api.calls.map((c) => c.url)).toEqual(['https://api.anthropic.com/v1/models?limit=1'])
    expect(added).toEqual({ id: added.id, provider: 'claude', label: 'Billing', cli: false, auth: 'apiKey', active: false, signedIn: true })
    const list = (await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude')
    expect(list.map((a) => [a.label, a.auth, a.active])).toEqual([['cj@example.com', 'subscription', true], ['Billing', 'apiKey', false]])
    expect(list[1]).not.toHaveProperty('usageFromTurns')
    // Kept encrypted, readable by Kernel's user only, and nowhere else in plain text.
    expect(await filesHolding(dataDir, CLAUDE_KEY)).toEqual([])
    expect((await stat(join(dataDir, 'api-keys.json'))).mode & 0o777).toBe(0o600)
    // Added, not used: switching is the user's click.
    expect(k.providers.active('claude')).toBeUndefined()
    expect(k.providers.claudeEnv()).toEqual({})
    await h['accounts.switch']({ provider: 'claude', accountId: added.id })
    expect(k.providers.claudeEnv()).toEqual({ ANTHROPIC_API_KEY: CLAUDE_KEY })
    const deps = (k.sessions as unknown as { d: { claudeEnv: () => Record<string, string>; authOf: (p: string, id?: string) => string } }).d
    expect(deps.claudeEnv()).toEqual({ ANTHROPIC_API_KEY: CLAUDE_KEY })
    expect([deps.authOf('claude', added.id), deps.authOf('claude', undefined)]).toEqual(['apiKey', 'subscription'])
    expect(await k.providers.status('claude')).toMatchObject({ signedIn: true, loginMethod: 'API key' })
    await k.stop()
  })

  it("keeps the last plan's defaults on a key account, as a sign-out does, and applies the plan again on switching back", async () => {
    const { k, h, reader } = await kernel('pro')
    await h['account.get'](undefined)
    expect(k.settings.plan).toBe('pro')
    expect(k.settings.models.roles.lead.model).toBe('claude-sonnet-5-5')
    const key = await h['accounts.addKey']({ provider: 'claude', label: 'Billing', key: CLAUDE_KEY })
    await h['accounts.switch']({ provider: 'claude', accountId: key.id })
    expect(await h['account.get'](undefined)).toEqual({ signedIn: true, name: 'Billing' })
    expect(k.settings.plan).toBe('pro')
    expect(k.settings.models.roles.lead.model).toBe('claude-sonnet-5-5')
    reader.plan = 'max'
    await h['accounts.switch']({ provider: 'claude', accountId: 'cli' })
    expect(k.settings.plan).toBe('max')
    await k.stop()
  })

  it('reads as signed out once a session refuses the key, until a new key replaces it', async () => {
    const { k, h } = await kernel()
    const key = await h['accounts.addKey']({ provider: 'claude', label: 'Billing', key: CLAUDE_KEY })
    await h['accounts.switch']({ provider: 'claude', accountId: key.id })
    // What a session's 401 reports (sessionDeps.onFailure).
    k.account.signedOut('claude')
    expect((await h['accounts.list'](undefined)).find((a) => a.id === key.id)?.signedIn).toBe(false)
    expect(k.sessions.heldFor('claude')).toContain('auth')
    expect(await h['account.get'](undefined)).toMatchObject({ signedIn: false })
    await expect(h['providers.signIn']({ provider: 'claude' })).rejects.toThrow('This account runs on an API key. Add a new key to sign it in again.')
    await expect(h['accounts.addKey']({ provider: 'claude', accountId: 'cli', key: CLAUDE_KEY_2 })).rejects.toThrow('That API key account is no longer in Kernel.')
    const again = await h['accounts.addKey']({ provider: 'claude', accountId: key.id, key: CLAUDE_KEY_2 })
    expect(again).toMatchObject({ id: key.id, label: 'Billing', auth: 'apiKey', active: true, signedIn: true })
    expect(k.sessions.heldFor('claude')).not.toContain('auth')
    expect(k.providers.claudeEnv()).toEqual({ ANTHROPIC_API_KEY: CLAUDE_KEY_2 })
    expect((await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude')).toHaveLength(2)
    await k.stop()
  })

  it('signs out by forgetting the key, and removes it back to the CLI login', async () => {
    const { k, h, dataDir } = await kernel()
    const key = await h['accounts.addKey']({ provider: 'claude', label: 'Billing', key: CLAUDE_KEY })
    await h['accounts.switch']({ provider: 'claude', accountId: key.id })
    const out = await h['accounts.signOut']({ provider: 'claude', accountId: key.id })
    expect(out.find((a) => a.id === key.id)).toMatchObject({ signedIn: false, active: true })
    expect(JSON.parse(await readFile(join(dataDir, 'api-keys.json'), 'utf8'))).toEqual({})
    const after = await h['accounts.remove']({ provider: 'claude', accountId: key.id })
    expect(after.filter((a) => a.provider === 'claude').map((a) => a.id)).toEqual(['cli'])
    expect(k.providers.active('claude')).toBeUndefined()
    await k.stop()
  })
})

describe('Codex API key accounts (KERNEL-523)', () => {
  it("runs a key account in a home of its own, logged in with the key in memory only, and keeps no usage window from it", async () => {
    const { k, h, api, dataDir, home } = await kernel()
    await expect(h['accounts.addKey']({ provider: 'codex', label: 'Billing', key: 'sk-proj-wrong' })).rejects.toThrow("OpenAI didn't accept that key.")
    api.calls.length = 0
    const key = await h['accounts.addKey']({ provider: 'codex', label: 'Billing', key: OPENAI_KEY })
    expect(api.calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/models'])
    expect(key).toMatchObject({ provider: 'codex', label: 'Billing', auth: 'apiKey', active: false, signedIn: true })
    const acctHome = k.providers.codexHome(key.id)!
    expect(await readlink(join(acctHome, 'config.toml'))).toBe(join(home, '.codex', 'config.toml'))
    await h['accounts.switch']({ provider: 'codex', accountId: key.id })
    expect(await k.providers.signedIn('codex')).toBe(true)
    // An API key from the Mac never reaches Codex. Only the picked account's key does, over stdin.
    process.env.OPENAI_API_KEY = 'sk-proj-from-the-mac-' + 'x'.repeat(20)
    process.env.CODEX_API_KEY = 'sk-from-the-mac-' + 'y'.repeat(20)
    const { repo } = await chats(k)
    const full = { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 3600 }
    await k.sessions.send('codex', [{ type: 'text', text: script({ notify: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: full, secondary: null, rateLimitReachedType: 'rate_limit_reached' } } }) }])
    await until(() => k.store.chat('codex')?.sessionId && !k.sessions.isRunning('codex'))
    const cwd = await realpath(repo)
    const log = await fake.messages()
    const started = log.find((m) => 'started' in m && m.cwd === cwd)
    expect(started).toMatchObject({ started: acctHome, args: ['app-server', '-c', 'cli_auth_credentials_store="ephemeral"'], keyInEnv: false })
    const methods = log.filter((m) => m.method).map((m) => m.method)
    expect(methods.indexOf('account/login/start')).toBeLessThan(methods.indexOf('thread/start'))
    expect(log.find((m) => m.method === 'account/login/start')?.params).toEqual({ type: 'apiKey', apiKey: OPENAI_KEY })
    expect(existsSync(join(acctHome, 'auth.json'))).toBe(false)
    expect(await filesHolding(dataDir, OPENAI_KEY)).toEqual([])
    // A key account has no usage windows, so a full one holds nothing and pauses no room.
    expect((await k.sessions.usage()).filter((l: RateLimit) => l.provider === 'codex')).toEqual([])
    await k.stop()
  })

  it('reads as signed out once Codex says the key is unauthorized, until a new key replaces it', async () => {
    const { k, h } = await kernel()
    const key = await h['accounts.addKey']({ provider: 'codex', label: 'Billing', key: OPENAI_KEY })
    await h['accounts.switch']({ provider: 'codex', accountId: key.id })
    await chats(k)
    await k.sessions.send('codex', [{ type: 'text', text: script({ complete: 'failed', error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' } }) }])
    await until(() => k.sessions.heldFor('codex').includes('codex-auth'))
    expect((await h['accounts.list'](undefined)).find((a) => a.id === key.id)?.signedIn).toBe(false)
    // The 10-second sign-in check doesn't lift the hold while the key stands refused.
    const check = () => (k.account as unknown as { readCodex: () => Promise<void> }).readCodex()
    await check()
    expect(k.sessions.heldFor('codex')).toContain('codex-auth')
    await expect(h['providers.signIn']({ provider: 'codex' })).rejects.toThrow('Add a new key')
    await h['accounts.addKey']({ provider: 'codex', accountId: key.id, key: OPENAI_KEY })
    await check()
    expect(k.sessions.heldFor('codex')).not.toContain('codex-auth')
    expect((await h['accounts.list'](undefined)).find((a) => a.id === key.id)?.signedIn).toBe(true)
    await k.stop()
  })

  it('removes a key account with its home and its key', async () => {
    const { k, h, dataDir } = await kernel()
    const key = await h['accounts.addKey']({ provider: 'codex', label: 'Billing', key: OPENAI_KEY })
    await h['accounts.switch']({ provider: 'codex', accountId: key.id })
    const acctHome = k.providers.codexHome(key.id)!
    await h['accounts.remove']({ provider: 'codex', accountId: key.id })
    expect(k.providers.active('codex')).toBeUndefined()
    expect(existsSync(acctHome)).toBe(false)
    expect(JSON.parse(await readFile(join(dataDir, 'api-keys.json'), 'utf8'))).toEqual({})
    await k.stop()
  })
})

describe('Kernel never switches to a key account on its own (KERNEL-523)', () => {
  it('pauses for a limit on the account in use, and moves back only to the CLI login when one is removed', async () => {
    const { k, h } = await kernel()
    const key = await h['accounts.addKey']({ provider: 'claude', label: 'Billing', key: CLAUDE_KEY })
    const { room } = await chats(k)
    k.account.applyLimits([{ type: 'five_hour', status: 'rejected', resetsAt: Math.round(Date.now() / 1000) + 3600 }])
    expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    expect(k.providers.active('claude')).toBeUndefined()
    // Removing the subscription account in use goes back to the CLI login, not to the key.
    const p = k.providers as unknown as { load: () => { claude: { accounts: { id: string; label: string; createdAt: number }[] } }; save: () => Promise<void> }
    p.load().claude.accounts.push({ id: 'work', label: 'Work', createdAt: 1 })
    await p.save()
    await h['accounts.switch']({ provider: 'claude', accountId: 'work' })
    await h['accounts.remove']({ provider: 'claude', accountId: 'work' })
    expect(k.providers.active('claude')).toBeUndefined()
    expect(k.providers.active('claude')).not.toBe(key.id)
    await k.stop()
  })
})
