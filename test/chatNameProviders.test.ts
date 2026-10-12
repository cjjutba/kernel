import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import type { SessionDeps } from '../src/main/services/sessions'
import { askTitle, CODEX_TITLE_MODEL } from '../src/main/services/titles'
import { fakeCodex } from './helpers/fakeCodex'
import { tempRepo } from './helpers'

// Which account names a chat (KERNEL-624): Haiku on the active Claude account, else Codex's small model on the active Codex
// account, whatever the chat runs on. Codex is the fake app-server, and the SDK's query answers what `sdk.answer` holds.

const sdk = vi.hoisted(() => ({ answer: undefined as object[] | undefined, options: [] as any[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: any }) => {
    sdk.options.push(options)
    const out = sdk.answer ?? []
    let n = 0
    // With no answer set, a query never answers, as in sdkStub.
    return { [Symbol.asyncIterator]: () => ({ next: () => n < out.length ? Promise.resolve({ value: out[n++], done: false }) : sdk.answer ? Promise.resolve({ value: undefined, done: true }) : new Promise(() => undefined) }) }
  }
}))

/** Encrypts by reversing, so a stored key isn't the plain one. */
const cipher = { encrypt: (t: string) => `enc:${[...t].reverse().join('')}`, decrypt: (d: string) => [...d.slice(4)].reverse().join('') }
const CLAUDE_KEY = 'sk-ant-api03-' + 'Kq7_'.repeat(20)
/** Anthropic's models list, which takes the key above. */
const keyApi = (async (_url: string | URL | Request, init?: RequestInit) => new Response('{}', { status: new Headers(init?.headers).get('x-api-key') === CLAUDE_KEY ? 200 : 401 })) as typeof fetch

const settle = () => new Promise((r) => setTimeout(r, 60))
const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }

let fake: Awaited<ReturnType<typeof fakeCodex>>
const saved = { ...process.env }
beforeEach(async () => {
  fake = await fakeCodex()
  process.env.FAKE_CODEX_LOG = fake.log
  process.env.FAKE_CODEX_MODELS = JSON.stringify(['gpt-6-astra', CODEX_TITLE_MODEL])
  process.env.FAKE_CODEX_REPLY = '"Fix the login bug."'
  delete process.env.CODEX_HOME
  sdk.answer = undefined
  sdk.options.length = 0
})
afterEach(() => {
  for (const name of ['FAKE_CODEX_LOG', 'FAKE_CODEX_MODELS', 'FAKE_CODEX_REPLY', 'CODEX_HOME']) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] }
  vi.restoreAllMocks()
})

/** A `claude` that only answers `--version` and `auth status`, so nothing reads the Mac's own login. */
async function fakeClaudeCli(): Promise<string> {
  const bin = join(await mkdtemp(join(tmpdir(), 'kernel-bin-')), 'claude')
  await writeFile(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.292 (Claude Code)";; auth) echo '{"loggedIn":true,"email":"cj@example.com","subscriptionType":"max"}';; esac\n`)
  await chmod(bin, 0o755)
  return bin
}

/** A Kernel with the fake Codex and Claude, and one auto-named "New chat" on `provider` with a session. */
async function setup(provider: 'claude' | 'codex' = 'codex') {
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir, home, cipher, fetch: keyApi })
  await k.start()
  await k.providers.setPath('codex', { path: fake.bin })
  await k.providers.setPath('claude', { path: await fakeClaudeCli() })
  k.sessionInfo = (async () => undefined) as typeof k.sessionInfo
  const repo = await tempRepo()
  const room = await k.addRoom(repo)
  const ws: Workspace = { id: 'ws', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'kernel-lead', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  k.store.saveWorkspace(ws)
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'New chat', autoTitle: { turns: 0 }, kind: 'chat', provider, model: provider === 'codex' ? 'gpt-6-astra' : 'claude-opus-4-8', effort: 'low', plan: false, sessionId: 'thread-9', createdAt: 1 }
  k.store.saveChat(chat)
  const d = (k.sessions as unknown as { d: SessionDeps }).d
  let n = 0
  /** One finished turn: the user's message, a reply and the result row, then the turn end Sessions reports. */
  const turn = async (text = `message ${n}`) => {
    n++
    k.store.saveItem('chat', { kind: 'user', id: `u${n}`, ts: n, parts: [{ type: 'text', text }] })
    k.store.saveItem('chat', { kind: 'text', id: `m${n}:0`, ts: n, text: `reply ${n}` })
    k.store.saveItem('chat', { kind: 'result', id: `r${n}`, ts: n, durationMs: 10, ok: true })
    d.onTurnDone!(k.store.workspace('ws')!, k.store.chat('chat')!, { ok: true, interrupted: false, by: 'user' })
    await settle()
  }
  return { k, h: k.handlers(), repo, turn, chat: () => k.store.chat('chat')! }
}

describe('naming a chat on any account (KERNEL-624)', () => {
  it("names a Codex chat through Codex's small model when Claude brings back no answer", async () => {
    const s = await setup('codex')
    const claude: { env?: Record<string, string> }[] = []
    s.k.chats.askClaude = async (_text, o) => { claude.push({ env: o.env }); throw new Error("You've hit your session limit") }
    await s.turn('The login button does nothing')
    await until(() => s.chat().title !== 'New chat')
    expect(s.chat()).toMatchObject({ title: 'Fix the login bug', autoTitle: { turns: 1 } })
    expect(claude).toHaveLength(1)
    // One thread Codex doesn't save, on the small model, with nothing to approve and nothing to write.
    const log = await fake.messages()
    expect(log.find((m) => m.method === 'thread/start')?.params).toMatchObject({ model: CODEX_TITLE_MODEL, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
    const started = log.find((m) => m.method === 'turn/start')?.params
    expect(started.effort).toBe('low')
    expect(started.input[0].text).toContain('User: The login button does nothing')
    expect(log.some((m) => m.method === 'thread/resume')).toBe(false)
    await s.k.stop()
  })

  it("runs Haiku on the active Claude account, an API key account's key, for a Codex chat too, and Codex isn't asked", async () => {
    const s = await setup('codex')
    const key = await s.h['accounts.addKey']({ provider: 'claude', label: 'Billing', key: CLAUDE_KEY })
    await s.h['accounts.switch']({ provider: 'claude', accountId: key.id })
    const claude: { env?: Record<string, string> }[] = []
    s.k.chats.askClaude = async (_text, o) => { claude.push({ env: o.env }); return 'Named by Haiku' }
    s.k.chats.askCodex = async () => { throw new Error('Codex was asked') }
    await s.turn()
    await until(() => s.chat().title !== 'New chat')
    expect(s.chat().title).toBe('Named by Haiku')
    expect(claude).toEqual([{ env: { ANTHROPIC_API_KEY: CLAUDE_KEY } }])
    await s.k.stop()
  })

  it('names a Claude chat through Codex when no Claude account works', async () => {
    const s = await setup('claude')
    s.k.chats.askClaude = async () => { throw new Error('Not logged in') }
    await s.turn()
    await until(() => s.chat().title !== 'New chat')
    expect(s.chat().title).toBe('Fix the login bug')
    await s.k.stop()
  })

  it('logs a chat neither account could name once, with both reasons, and keeps trying at the next turn ends', async () => {
    const s = await setup('codex')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let asked = 0
    s.k.chats.askClaude = async () => { asked++; throw new Error("You've hit your session limit") }
    s.k.chats.askCodex = async () => { throw new Error('Codex did not answer in time.') }
    await s.turn()
    await s.turn()
    await s.turn()
    expect(asked).toBe(3)
    expect(s.chat().title).toBe('New chat')
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[chats]'))
    expect(lines).toEqual(["[chats] could not name chat chat: Claude: You've hit your session limit. Codex: Codex did not answer in time."])
    await s.k.stop()
  })
})

describe('askTitle (KERNEL-624)', () => {
  it("passes the account's env to Claude Code without the Mac's own key, and cleans the answer", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-mac'
    try {
      sdk.answer = [{ type: 'result', subtype: 'success', is_error: false, result: '**Fix the login bug.**' }]
      expect(await askTitle('User: hi', { cwd: tmpdir(), env: { ANTHROPIC_API_KEY: CLAUDE_KEY } })).toBe('Fix the login bug')
      expect(sdk.options[0].env.ANTHROPIC_API_KEY).toBe(CLAUDE_KEY)
      sdk.answer = [{ type: 'result', subtype: 'success', is_error: false, result: 'Rename me' }]
      await askTitle('User: hi', { cwd: tmpdir() })
      expect(sdk.options[1].env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY
    }
  })

  it('throws the reason when the login answers with an error, such as its usage limit', async () => {
    sdk.answer = [{ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 1:10am" }]
    await expect(askTitle('User: hi', { cwd: tmpdir() })).rejects.toThrow("You've hit your session limit · resets 1:10am")
    sdk.answer = [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Invalid API key'] }]
    await expect(askTitle('User: hi', { cwd: tmpdir() })).rejects.toThrow('error_during_execution: Invalid API key')
    sdk.answer = []
    await expect(askTitle('User: hi', { cwd: tmpdir() })).rejects.toThrow('Claude Code ended without a result')
  })
})
