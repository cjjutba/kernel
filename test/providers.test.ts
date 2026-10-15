import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Chat, RateLimit, Workspace } from '@shared/types'
import { chatProvider, limitProvider, providerOf } from '../src/shared/providers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it. An
// abort ends the stream with an error, as the real one does when Kernel stops the process.
const sdk = vi.hoisted(() => ({ calls: [] as { options: Options; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: Options }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    const call = { options, feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) } }
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      mcpServerStatus: async () => [],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('not supported') }
    }
  }
}))

describe('which provider runs a model (KERNEL-406)', () => {
  it('reads Claude ids and the aliases agent files use as Claude, and anything else as Codex', () => {
    expect(providerOf('claude-opus-5-5')).toBe('claude')
    expect(providerOf('Opus')).toBe('claude')
    expect(providerOf('haiku')).toBe('claude')
    expect(providerOf('gpt-6-astra')).toBe('codex')
    expect(providerOf('gpt-5.6-luna')).toBe('codex')
  })
  it('reads chats and limits saved before KERNEL-406 as Claude', () => {
    expect(chatProvider({})).toBe('claude')
    expect(chatProvider({ provider: 'codex' })).toBe('codex')
    expect(limitProvider({})).toBe('claude')
  })
})

describe('Claude chats keep the account that holds their cache (KERNEL-843)', () => {
  afterEach(() => { bus.removeAllListeners('push'); sdk.calls = [] })

  /** Encrypts by reversing, so a stored key isn't the plain one. */
  const cipher = { encrypt: (t: string) => `enc:${[...t].reverse().join('')}`, decrypt: (d: string) => [...d.slice(4)].reverse().join('') }
  const KEYS = { work: 'sk-ant-api03-' + 'Wk1_'.repeat(20), side: 'sk-ant-api03-' + 'Sd2-'.repeat(20) }
  const S = (ms: number) => Math.round(ms / 1000)
  const flush = () => new Promise((r) => setTimeout(r, 20))

  async function until<T>(check: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
    const end = Date.now() + ms
    for (;;) {
      const v = await check()
      if (v) return v as NonNullable<T>
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /**
   * A Kernel with two Claude API key accounts, Work and Side, a `claude` that only answers `--version` and `auth status`, and
   * a workspace with the Claude chats `ids`. `turn` sends a message and ends its turn, and says which key its process has.
   */
  async function setUp(ids = ['a', 'b']) {
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const bin = join(await mkdtemp(join(tmpdir(), 'kernel-bin-')), 'claude')
    await writeFile(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.292 (Claude Code)";; auth) echo '{"loggedIn":true,"email":"cj@example.com","subscriptionType":"max"}';; esac\n`)
    await chmod(bin, 0o755)
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home, cipher, fetch: (async () => new Response('{}')) as typeof fetch })
    await k.start()
    k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    await k.providers.setPath('claude', { path: bin })
    const h = k.handlers()
    const work = (await h['accounts.addKey']({ provider: 'claude', label: 'Work', key: KEYS.work })).id
    const side = (await h['accounts.addKey']({ provider: 'claude', label: 'Side', key: KEYS.side })).id
    const repo = await tempRepo()
    const project = await k.addProject(repo)
    const ws: Workspace = { id: 'ws', projectId: project.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'kernel-lead', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    k.store.saveWorkspace(ws)
    for (const id of ids) k.store.saveChat({ id, workspaceId: 'ws', title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } satisfies Chat)
    // The process each chat started last.
    const started = new Map<string, (typeof sdk.calls)[number]>()
    const send = async (chatId: string) => {
      const calls = sdk.calls.length
      await k.sessions.send(chatId, [{ type: 'text', text: 'Go on' }])
      await flush()
      // A chat with a live process takes the turn there. Otherwise a new process starts.
      const fresh = sdk.calls.length > calls
      if (fresh) {
        started.set(chatId, sdk.calls.at(-1)!)
        const call = sdk.calls.at(-1)!
        call.feed({ type: 'system', subtype: 'init', session_id: `session-${chatId}`, apiKeySource: call.options.env?.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none' })
      }
      const call = started.get(chatId)!
      call.feed({ type: 'result', subtype: 'success', uuid: `r-${chatId}-${sdk.calls.length}-${Date.now()}`, duration_ms: 5 })
      await until(() => !k.sessions.isRunning(chatId))
      return { key: call.options.env?.ANTHROPIC_API_KEY ?? 'cli', fresh }
    }
    const callOf = (chatId: string) => started.get(chatId)!
    const stopped = (chatId: string) => !!callOf(chatId).options.abortController?.signal.aborted
    const key = (id: string | undefined) => (id === work ? KEYS.work : id === side ? KEYS.side : 'cli')
    const notes = (chatId: string) => k.store.items(chatId).flatMap((i) => (i.kind === 'note' ? [i.text] : []))
    const chats = async () => Object.fromEntries((await h['accounts.list'](undefined)).filter((a) => a.provider === 'claude').map((a) => [a.label, a.chats ?? 0]))
    return { k, h, work, side, send, stopped, key, notes, chats }
  }

  it('after a switch with Keep, an idle chat keeps running on its old account in the same process, and a new chat starts on the new one', async () => {
    const { k, h, work, side, send, stopped, key, chats } = await setUp()
    await h['accounts.switch']({ provider: 'claude', accountId: work })
    expect(await send('a')).toEqual({ key: KEYS.work, fresh: true })
    await h['accounts.switch']({ provider: 'claude', accountId: side })
    expect(stopped('a')).toBe(false)
    expect(k.placement.accountFor('claude', k.store.chat('a')!)).toBe(work)
    expect(await send('b')).toEqual({ key: KEYS.side, fresh: true })
    expect(await send('a')).toEqual({ key: KEYS.work, fresh: false })
    expect(k.store.chat('a')?.ranOn).toBe(work)
    // A new chat that hasn't run is on no account yet.
    expect(await chats()).toEqual({ 'Work': 1, 'Side': 1, 'cj@example.com': 0 })
    expect(key(k.placement.accountFor('claude', { ...k.store.chat('a')!, id: 'new', ranOn: undefined }))).toBe(KEYS.side)
    await k.stop({ budgetMs: 0 })
  })

  it('Move all moves every chat, and ends only the processes of chats whose account changes', async () => {
    const { k, h, work, side, send, stopped, notes, chats } = await setUp(['a', 'b', 'c'])
    await h['accounts.switch']({ provider: 'claude', accountId: work })
    await send('a')
    await send('b')
    await h['accounts.switch']({ provider: 'claude', accountId: side })
    await send('c')
    await h['accounts.switch']({ provider: 'claude', accountId: work, move: 'all' })
    // Chat c moves from Side to Work, and a and b were on Work already.
    expect([stopped('a'), stopped('b'), stopped('c')]).toEqual([false, false, true])
    expect(await chats()).toMatchObject({ Work: 3, Side: 0 })
    await h['accounts.switch']({ provider: 'claude', accountId: side, move: 'all' })
    expect([stopped('a'), stopped('b')]).toEqual([true, true])
    expect(await send('a')).toEqual({ key: KEYS.side, fresh: true })
    expect(notes('a')).toEqual(['Moved to Side'])
    // Once a chat ran where it was placed, a Keep switch leaves it there.
    await h['accounts.switch']({ provider: 'claude', accountId: work })
    expect(k.placement.accountFor('claude', k.store.chat('a')!)).toBe(side)
    expect(k.placement.accountFor('claude', k.store.chat('b')!)).toBe(side)
    await k.stop({ budgetMs: 0 })
  })

  it('moves a chat off its account when that account signs out, and when it is removed', async () => {
    const { k, h, work, side, send, stopped, notes } = await setUp()
    await h['accounts.switch']({ provider: 'claude', accountId: work })
    await send('a')
    await send('b')
    await h['accounts.switch']({ provider: 'claude', accountId: side })
    await h['accounts.signOut']({ provider: 'claude', accountId: work })
    // The idle process on Work ends at the chat's next message, which runs on Side.
    expect(await send('a')).toEqual({ key: KEYS.side, fresh: true })
    expect(notes('a')).toEqual(['Moved to Side'])
    expect(stopped('b')).toBe(false)
    await h['accounts.remove']({ provider: 'claude', accountId: work })
    expect(stopped('b')).toBe(true)
    expect(k.placement.accountFor('claude', k.store.chat('b')!)).toBe(side)
    await k.stop({ budgetMs: 0 })
  })

  it('moves a chat when its account hits a limit or crosses the move threshold, and not below it', async () => {
    const { k } = await setUp([])
    // Subscription logins, as accounts.json keeps them, so they have usage windows.
    const p = k.providers as unknown as { load: () => { claude: { accounts: object[] } }; save: () => Promise<void> }
    for (const id of ['work', 'side']) p.load().claude.accounts.push({ id, label: id, home: k.providers.claudeHome(id), signedIn: true, createdAt: 1 })
    await p.save()
    await k.providers.switchTo('claude', 'side')
    const chat = { id: 'x', workspaceId: 'ws', title: 'x', kind: 'chat', model: 'claude-opus-5-5', effort: 'low', plan: false, ranOn: 'work', createdAt: 1 } satisfies Chat
    const at = (l: Partial<RateLimit>[]) => k.placement.accountFor('claude', chat, l.map((x) => ({ type: 'five_hour', status: 'allowed', accountId: 'work', resetsAt: S(Date.now() + 3600_000), ...x }) as RateLimit))
    expect(at([])).toBe('work')
    expect(at([{ utilization: 0.89 }, { type: 'seven_day', utilization: 0.94 }])).toBe('work')
    expect(at([{ utilization: 0.9 }])).toBe('side')
    expect(at([{ type: 'seven_day', utilization: 0.95 }])).toBe('side')
    expect(at([{ status: 'rejected', utilization: 1 }])).toBe('side')
    expect(at([{ type: 'seven_day_opus', status: 'rejected' }])).toBe('side')
    // Another account's windows, and a window past its reset, don't count.
    expect(at([{ utilization: 1, accountId: 'side' }, { utilization: 0.99, resetsAt: S(Date.now() - 1000) }])).toBe('work')
    // A chat on the CLI's own login stays there too, and goes when the login reads as signed out.
    expect(k.placement.accountFor('claude', { ...chat, ranOn: 'cli' }, [])).toBeUndefined()
    p.load().claude.accounts.forEach((a) => { if ((a as { id: string }).id === 'work') (a as { signedIn: boolean }).signedIn = false })
    expect(at([])).toBe('side')
    await k.stop({ budgetMs: 0 })
  })

  it('with "Keep chats on their account" off, every chat follows the switch as before', async () => {
    const { k, h, work, side, send, stopped } = await setUp()
    await k.config.setSettings({ accounts: { keepChatsOnAccount: false } })
    await h['accounts.switch']({ provider: 'claude', accountId: work })
    await send('a')
    // Keep is ignored with the setting off.
    await h['accounts.switch']({ provider: 'claude', accountId: side, move: 'keep' })
    expect(stopped('a')).toBe(true)
    expect(await send('a')).toEqual({ key: KEYS.side, fresh: true })
    expect(k.placement.accountFor('claude', { ...k.store.chat('a')!, ranOn: work })).toBe(side)
    await k.stop({ budgetMs: 0 })
  })
})
