import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, RateLimit, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Kernel } from '../src/main/kernel'
import { Approvals } from '../src/main/services/approvals'
import { LIMIT_LIFTED, Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { blockingLimit, failureOf, fallbackModel, limitedModels, NetworkMonitor, terminalScript } from '../src/main/services/health'
import { discardChanges, gitStatus, pushBranch } from '../src/main/services/archive'
import { run } from '../src/main/services/exec'
import { tempRepo, trustRoom, setUp } from './helpers'

// A scripted SDK, as in sessionRunner.test.ts. `context` is the percentage getContextUsage reports, `contextReply` a full
// answer that replaces it (null: percentage only), `usage` what the usage call answers (null: unsupported).
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void; end: () => void }[], context: 40, contextReply: null as unknown, contextCalls: 0, usage: null as unknown }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    // end() is the process exiting on its own: the stream finishes once what was fed is read.
    let ended = false
    const call = {
      options,
      feed: (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) },
      end: () => { ended = true; for (const w of waiters.splice(0)) w({ value: undefined, done: true }) }
    }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : ended ? Promise.resolve({ value: undefined, done: true }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
      getContextUsage: async () => { sdk.contextCalls++; return sdk.contextReply ?? { percentage: sdk.context } },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { if (!sdk.usage) throw new Error('not supported'); return sdk.usage }
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))
const S = (ms: number) => Math.round(ms / 1000)

function listen() {
  const pushes: PushEvent[] = []
  const on = (e: PushEvent) => pushes.push(e)
  bus.on('push', on)
  return { pushes, off: () => bus.off('push', on) }
}

async function runner(o: { onFailure?: (f: string) => void; onReached?: () => void } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-health-')), 'kernel.db'))
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-table', branch: 'feat/x', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kai', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Table', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 } } as unknown as AppSettings
  const sessions = new Sessions({
    store, approvals: new Approvals(store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => undefined,
    onFailure: (f) => o.onFailure?.(f), onReached: () => o.onReached?.()
  })
  return { store, sessions, chat }
}

const result = (uuid = 'r1') => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1000, session_id: 's' })

/** What the usage call answers: the 5-hour window at `percent`, resetting at `resetsAt` (epoch seconds). */
const usageAt = (percent: number, resetsAt: number) => ({
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max', rate_limits_available: true, behaviors: null,
  rate_limits: { five_hour: { utilization: percent, resets_at: new Date(resetsAt * 1000).toISOString() } }
})

/** A Kernel whose Lead chat hit the 5-hour limit and finished its turn, so every room is paused by the limit. */
async function limited() {
  const { k, room } = await kernel()
  const chat = await k.leadChat(room.id)
  await setUp(k, chat.id)
  await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
  const call = sdk.calls[sdk.calls.length - 1]
  const resetsAt = S(Date.now() + 3600_000)
  call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, utilization: 1 }, uuid: 'l1', session_id: 's' })
  call.feed(result())
  await flush()
  expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
  return { k, room, chat, call, resetsAt }
}

describe('failure signals', () => {
  it('maps SDK errors to the banner they call for', () => {
    expect(failureOf('authentication_failed')).toBe('auth')
    expect(failureOf('oauth_org_not_allowed')).toBe('auth')
    expect(failureOf('rate_limit')).toBe('limit')
    expect(failureOf('overloaded', 529)).toBe('overloaded')
    expect(failureOf('unknown', null)).toBe('network')
    expect(failureOf('server_error', 500)).toBeUndefined()
    expect(failureOf(undefined)).toBeUndefined()
  })

  it('knows which limits stop the account, which stop one model, and what to switch to', () => {
    const now = Date.now()
    const limits: RateLimit[] = [
      { type: 'five_hour', status: 'rejected', resetsAt: S(now + 3600_000) },
      { type: 'seven_day', status: 'allowed' },
      { type: 'seven_day_opus', status: 'rejected', resetsAt: S(now + 86_400_000), model: 'claude-opus-5-5' },
      { type: 'seven_day_sonnet', status: 'rejected', resetsAt: S(now - 1000), model: 'claude-sonnet-5-5' }
    ]
    expect(blockingLimit(limits, now)?.type).toBe('five_hour')
    expect(blockingLimit([{ type: 'five_hour', status: 'rejected', resetsAt: S(now - 1000) }], now)).toBeUndefined()
    // Claude Code's Fable limit is Fable's own weekly window: the other models keep running.
    const fable: RateLimit[] = [{ type: 'seven_day_overage_included', status: 'rejected', resetsAt: S(now + 86_400_000) }]
    expect(blockingLimit(fable, now)).toBeUndefined()
    expect(limitedModels(fable, now)).toEqual(['claude-fable-5-1'])
    // The sonnet window already reset.
    expect(limitedModels(limits, now)).toEqual(['claude-opus-5-5'])
    expect(fallbackModel('claude-fable-5-1', ['claude-fable-5-1'])).toBe('claude-opus-5-5')
    expect(fallbackModel('claude-opus-5-5', ['claude-opus-5-5', 'claude-fable-5-1'])).toBe('claude-sonnet-5-5')
  })

  it('quotes the Terminal script so a path with quotes stays one argument', () => {
    const script = terminalScript(`/Users/you/it's "here"`, 'claude /login')
    expect(script).toContain('tell application "Terminal"')
    expect(script).toContain(`do script "cd '/Users/you/it'\\\\''s \\"here\\"' && claude /login"`)
  })

  it('reports a network flip once, repeats while offline, and shares one probe between callers', async () => {
    const answers = [true, false, false, true]
    let probes = 0
    const seen: boolean[] = []
    const m = new NetworkMonitor({ probe: async () => { probes++; return answers.shift() ?? true }, onChange: (o) => seen.push(o), everyMs: 60_000, offlineMs: 60_000 })
    await Promise.all([m.check(), m.check()])
    expect(probes).toBe(1)
    expect(seen).toEqual([])
    await m.check(); await m.check(); await m.check()
    expect(seen).toEqual([false, false, true])
    m.stop()
  })

  it('trusts a reply from the API over a failing DNS probe, until a session loses its connection (KERNEL-231)', async () => {
    let dns = false
    const seen: boolean[] = []
    const m = new NetworkMonitor({ probe: async () => dns, onChange: (o) => seen.push(o), everyMs: 60_000, offlineMs: 60_000 })
    // Behind a proxy: DNS for the API fails, so the first check says offline.
    expect(await m.check()).toBe(false)
    expect(seen).toEqual([false])
    // A turn reaches the API anyway: back online, and later failed probes no longer hold sends.
    m.reached()
    expect(m.online).toBe(true)
    expect(seen).toEqual([false, true])
    expect(await m.check()).toBe(true)
    expect(await m.check()).toBe(true)
    expect(seen).toEqual([false, true])
    // A dropped connection makes the probe count again.
    expect(await m.lost()).toBe(false)
    expect(seen).toEqual([false, true, false])
    // A probe that passes puts things back as they were.
    dns = true
    expect(await m.check()).toBe(true)
    m.stop()
  })

  it('keeps a failing probe from holding sends right after a turn reached the API (KERNEL-231)', async () => {
    let now = 1_000_000
    const seen: boolean[] = []
    const m = new NetworkMonitor({ probe: async () => false, onChange: (o) => seen.push(o), everyMs: 60_000, offlineMs: 60_000, trustMs: 120_000, now: () => now })
    m.reached()
    now += 30_000
    expect(await m.check()).toBe(true)
    expect(seen).toEqual([])
    m.stop()
    // Long after the last reply, with nothing reached since, a failing probe still means offline.
    const idle = new NetworkMonitor({ probe: async () => false, onChange: (o) => seen.push(o), everyMs: 60_000, offlineMs: 60_000, trustMs: 120_000, now: () => now })
    idle.reached()
    now += 600_000
    expect(await idle.check()).toBe(false)
    idle.stop()
  })
})

describe('sessions under failure', () => {
  it('shows a retry while the API retries, and clears it on the next reply', async () => {
    const { sessions, chat } = await runner()
    const { pushes, off } = listen()
    await sessions.send(chat.id, [{ type: 'text', text: 'Shorten the copy' }])
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 12_000, error_status: 529, error: 'overloaded', uuid: 'a', session_id: 's' })
    await flush()
    const retry = pushes.filter((e) => e.type === 'retry')
    expect(retry).toHaveLength(1)
    expect(retry[0]).toMatchObject({ chatId: chat.id, retry: { attempt: 2, of: 5 } })
    call.feed({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Shortened it.' }] }, session_id: 's' })
    await flush()
    expect(pushes.filter((e) => e.type === 'retry').pop()).toMatchObject({ chatId: chat.id, retry: null })
    off()
  })

  it('lists a working chat and its retry for a window that loads meanwhile, and drops them as they end (KERNEL-340)', async () => {
    const { sessions, chat } = await runner()
    await sessions.send(chat.id, [{ type: 'text', text: 'Shorten the copy' }])
    const call = sdk.calls[sdk.calls.length - 1]
    await flush()
    expect(sessions.runningIds()).toEqual([chat.id])
    expect(sessions.retries()).toEqual({})
    call.feed({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 12_000, error_status: 529, error: 'overloaded', uuid: 'a', session_id: 's' })
    await flush()
    expect(sessions.retries()).toEqual({ [chat.id]: { attempt: 2, of: 5, nextAt: expect.any(Number) } })
    call.feed({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Shortened it.' }] }, session_id: 's' })
    await flush()
    expect(sessions.retries()).toEqual({})
    expect(sessions.runningIds()).toEqual([chat.id])
    call.feed(result())
    await flush()
    expect(sessions.runningIds()).toEqual([])
  })

  it('reports an auth error and a dropped connection instead of a retry banner', async () => {
    const failures: string[] = []
    const { sessions, chat } = await runner({ onFailure: (f) => failures.push(f) })
    const { pushes, off } = listen()
    await sessions.send(chat.id, [{ type: 'text', text: 'Go' }])
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown', uuid: 'a', session_id: 's' })
    call.feed({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] }, session_id: 's' })
    await flush()
    expect(failures).toEqual(['network', 'auth'])
    expect(pushes.some((e) => e.type === 'retry')).toBe(false)
    off()
  })

  it('says the API was reached on a reply with no error and on a turn that ended well, never on a failure (KERNEL-231)', async () => {
    let reached = 0
    const { sessions, chat } = await runner({ onReached: () => reached++ })
    await sessions.send(chat.id, [{ type: 'text', text: 'Go' }])
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown', uuid: 'a', session_id: 's' })
    call.feed({ type: 'assistant', uuid: 'm0', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] }, session_id: 's' })
    await flush()
    expect(reached).toBe(0)
    call.feed({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] }, session_id: 's' })
    call.feed(result())
    await flush()
    expect(reached).toBe(2)
  })

  it.each(['unknown', 'server_error'])('never says the API was reached on a message with error %s, as when retries run out (KERNEL-231)', async (error) => {
    let reached = 0
    const { sessions, chat } = await runner({ onReached: () => reached++ })
    await sessions.send(chat.id, [{ type: 'text', text: 'Go' }])
    sdk.calls[sdk.calls.length - 1].feed({ type: 'assistant', uuid: 'm1', parent_tool_use_id: null, error, message: { content: [{ type: 'text', text: 'API Error: Connection error.' }] }, session_id: 's' })
    await flush()
    expect(reached).toBe(0)
  })

  it('never says the API was reached on a turn that ended on an API error, success with is_error (KERNEL-231)', async () => {
    let reached = 0
    const { sessions, chat } = await runner({ onReached: () => reached++ })
    await sessions.send(chat.id, [{ type: 'text', text: 'Go' }])
    sdk.calls[sdk.calls.length - 1].feed({ ...result(), is_error: true, result: 'API Error: Connection error.' })
    await flush()
    expect(reached).toBe(0)
  })

  it('saves the context use Claude Code reports after each turn', async () => {
    const { sessions, chat, store } = await runner()
    sdk.context = 91.6
    await sessions.send(chat.id, [{ type: 'text', text: 'Go' }])
    sdk.calls[sdk.calls.length - 1].feed(result())
    await flush()
    expect(store.chat(chat.id)?.context).toBe(92)
    // A percentage-only answer has no token counts to keep.
    expect(store.chat(chat.id)?.contextUsage).toBeUndefined()
    sdk.context = 40
  })

  it('saves the token counts and in-window rows behind the context use', async () => {
    const { sessions, chat, store } = await runner()
    sdk.contextReply = {
      percentage: 42.4, totalTokens: 84_800, maxTokens: 200_000, rawMaxTokens: 200_000, gridRows: [],
      categories: [
        { name: 'System prompt', tokens: 3_100, color: 'promptBorder', kind: 'used' },
        { name: 'MCP tools', tokens: 9_000, color: 'cyan', kind: 'deferred', isDeferred: true },
        { name: 'Messages', tokens: 81_700, color: 'purple', kind: 'used' },
        { name: 'Free space', tokens: 82_200, color: 'promptBorder', kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' }
      ]
    }
    try {
      await sessions.send(chat.id, [{ type: 'text', text: 'Go' }])
      const call = sdk.calls[sdk.calls.length - 1]
      call.feed(result())
      await flush()
      expect(store.chat(chat.id)).toMatchObject({
        context: 42,
        contextUsage: {
          used: 84_800, max: 200_000,
          rows: [
            { name: 'System prompt', tokens: 3_100, kind: 'used' },
            { name: 'Messages', tokens: 81_700, kind: 'used' },
            { name: 'Free space', tokens: 82_200, kind: 'free' },
            { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' }
          ]
        }
      })
      expect(store.chat(chat.id)?.contextUsage?.rows[0]).not.toHaveProperty('color')

      // The same numbers after the next turn leave the chat alone.
      const asked = sdk.contextCalls
      const { pushes, off } = listen()
      await sessions.send(chat.id, [{ type: 'text', text: 'Again' }])
      call.feed(result('r2'))
      await flush()
      off()
      expect(sdk.contextCalls).toBe(asked + 1)
      expect(pushes.filter((e) => e.type === 'chat')).toEqual([])

      // A later percentage-only answer drops the old counts, so they never disagree with the percentage.
      sdk.contextReply = null
      sdk.context = 30
      await sessions.send(chat.id, [{ type: 'text', text: 'Once more' }])
      call.feed(result('r3'))
      await flush()
      expect(store.chat(chat.id)?.context).toBe(30)
      expect(store.chat(chat.id)?.contextUsage).toBeUndefined()
    } finally {
      sdk.contextReply = null
      sdk.context = 40
    }
  })

  it('compacts by sending /compact', async () => {
    const { sessions, chat, store } = await runner()
    await sessions.compact(chat.id)
    expect(store.items(chat.id).find((i) => i.kind === 'user')).toMatchObject({ parts: [{ type: 'text', text: '/compact' }] })
  })

  it('holds every send while offline or signed out, and sends them when the last reason clears', async () => {
    const { sessions, chat, store } = await runner()
    const before = sdk.calls.length
    sessions.holdAll('offline')
    sessions.holdAll('auth')
    expect(await sessions.send(chat.id, [{ type: 'text', text: 'Also add a loading skeleton.' }])).toEqual({ queued: true, why: 'offline' })
    sessions.releaseAll('offline')
    expect(sessions.queued(chat.id)).toHaveLength(1)
    // A second release for the same reason does nothing.
    sessions.releaseAll('offline')
    expect(sessions.queued(chat.id)).toHaveLength(1)
    sessions.releaseAll('auth')
    expect(sessions.queued(chat.id)).toHaveLength(0)
    expect(sdk.calls.length).toBe(before + 1)
    expect(store.items(chat.id).filter((i) => i.kind === 'user')).toHaveLength(1)
  })

  it('keeps a held prompt out of every drain until release', async () => {
    const { sessions, chat, store } = await runner()
    sessions.hold(chat.id, [{ type: 'text', text: 'Build T-14' }])
    sessions.holdAll('offline')
    sessions.releaseAll('offline')
    expect(sessions.queued(chat.id)).toHaveLength(1)
    sessions.release(chat.id)
    expect(sessions.queued(chat.id)).toHaveLength(0)
    expect(store.items(chat.id).find((i) => i.kind === 'user')).toMatchObject({ parts: [{ type: 'text', text: 'Build T-14' }] })
  })
})

describe('archive and discard', () => {
  it('counts commits the remote has not seen, and the uncommitted changes', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await run('git', ['init', '-q', '--bare', remote])
    const repo = await tempRepo({ 'README.md': '# r\n', 'a.ts': 'one\n' })
    await run('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    await run('git', ['-C', repo, 'push', '-q', 'origin', 'main'])
    await run('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/x'])
    for (const n of [1, 2]) { await writeFile(join(repo, `c${n}.ts`), `${n}\n`); await run('git', ['-C', repo, 'add', '-A']); await run('git', ['-C', repo, 'commit', '-q', '-m', `c${n}`]) }
    // Never pushed: counted against the base.
    expect(await gitStatus(repo, 'feat/x', 'origin/main')).toMatchObject({ branch: 'feat/x', ahead: 2, behind: 0, dirty: { files: 0 } })
    await pushBranch(repo, 'feat/x')
    expect((await gitStatus(repo, 'feat/x', 'origin/main')).ahead).toBe(0)
    await writeFile(join(repo, 'a.ts'), 'one\ntwo\n')
    await writeFile(join(repo, 'new.ts'), 'x\ny\n')
    expect((await gitStatus(repo, 'feat/x', 'origin/main')).dirty).toEqual({ files: 2, added: 3, removed: 0 })
  })

  it('discards tracked edits and untracked files, and keeps ignored ones', async () => {
    const repo = await tempRepo({ 'a.ts': 'one\n', '.gitignore': '.env.local\n' })
    await writeFile(join(repo, 'a.ts'), 'changed\n')
    await writeFile(join(repo, 'new.ts'), 'x\n')
    await writeFile(join(repo, '.env.local'), 'SECRET=1\n')
    await discardChanges(repo)
    expect(await readFile(join(repo, 'a.ts'), 'utf8')).toBe('one\n')
    expect(existsSync(join(repo, 'new.ts'))).toBe(false)
    expect(existsSync(join(repo, '.env.local'))).toBe(true)
  })
})

async function kernel(files: Record<string, string> = {}, o: { settings?: object; options?: Partial<ConstructorParameters<typeof Kernel>[0]> } = {}) {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nYou are Kai.',
    ...files
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...o.settings }))
  const k = new Kernel({ dataDir, home, ...o.options })
  await k.start()
  const room = await k.addRoom(repo)
  await trustRoom(k, room.id)
  return { k, room, repo }
}

describe('kernel recovery paths', () => {
  /** A Kernel on a temp repo that can quit and start again on the same data, as the app does (KERNEL-128). */
  async function restartable(files: Record<string, string>) {
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nYou are Kai.', ...files })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const room = await k.addRoom(repo)
    await trustRoom(k, room.id)
    // A start with work to carry on checks the sign-in (KERNEL-215). The real one runs `claude auth status`.
    const again = async () => { const next = new Kernel({ dataDir, home }); next.signedInReader = async () => true; await next.start(); return next }
    return { k, room, again }
  }
  const texts = (k: Kernel, chatId: string) => k.sessions.queued(chatId).map((q) => [(q.parts[0] as { text: string }).text, q.from])

  it('keeps a held brief, and the Lead\'s message behind it, across a restart, and Run again sends them in order (KERNEL-128)', async () => {
    const { k, room, again } = await restartable({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const lead = await k.leadChat(room.id)
    // Rowan's own chat runs the same setup, which fails the same way (KERNEL-405).
    await setUp(k, lead.id, 'failed')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    expect(ws.status).toBe('failed')
    await k.lead['messageWorkspace'](room.id, ws.id, 'Use EmptyState')
    const chat = k.store.chats(ws.id)[0]
    expect(texts(k, chat.id)).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
    await k.stop()
    const k2 = await again()
    expect(texts(k2, chat.id)).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    expect((await k2.retrySetup(ws.id)).status).toBe('ready')
    // Nothing of Kai's is held any more, so nothing comes back after another restart. Rowan's chat never waited for its setup (KERNEL-490).
    expect(Object.keys(k2.store.meta<Record<string, unknown>>('held') ?? {})).toEqual([])
    sdk.calls[sdk.calls.length - 1].feed(result('r1'))
    await flush()
    const users = k2.store.items(chat.id).filter((i) => i.kind === 'user').map((i) => [((i as { parts: { text: string }[] }).parts[0]).text, (i as { from?: string }).from])
    expect(users).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
    await k2.stop()
  })

  // A workspace that waits for a PR is ready with its brief still held (KERNEL-259), so this holds for the ones that don't.
  it('marks a workspace that waits for nothing ready only as Run again sends its held brief, with nothing a quit could land between (KERNEL-136)', async () => {
    const { k, room } = await restartable({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const lead = await k.leadChat(room.id)
    // Rowan's own chat runs the same setup, which fails the same way (KERNEL-405).
    await setUp(k, lead.id, 'failed')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const chat = k.store.chats(ws.id)[0]
    expect(ws.waitsFor).toBeUndefined()
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    let heldWhenReady: unknown = 'never ready'
    const on = (e: PushEvent) => { if (e.type === 'workspace' && e.workspace.id === ws.id && e.workspace.status === 'ready') queueMicrotask(() => { heldWhenReady = k.store.meta<Record<string, unknown>>('held')?.[chat.id] ?? null }) }
    bus.on('push', on)
    try { expect((await k.retrySetup(ws.id)).status).toBe('ready') } finally { bus.off('push', on) }
    // Anything Kernel saves after the workspace reads as ready already has the brief out of the held queue.
    expect(heldWhenReady).toBeNull()
    await k.stop()
  })

  it('saves removing a held message in the composer, and drops an archived workspace\'s held queue (KERNEL-128)', async () => {
    const { k, room, again } = await restartable({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const lead = await k.leadChat(room.id)
    // Rowan's own chat runs the same setup, which fails the same way (KERNEL-405).
    await setUp(k, lead.id, 'failed')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const other = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Invoice export', leadChatId: lead.id })
    await k.lead['messageWorkspace'](room.id, ws.id, 'Use EmptyState')
    const chat = k.store.chats(ws.id)[0]
    k.sessions.unqueue(chat.id, k.sessions.queued(chat.id)[1].id)
    await k.archiveWorkspace(other.id)
    await k.stop()
    const k2 = await again()
    expect(texts(k2, chat.id)).toEqual([['Build T-14', 'lead']])
    expect(Object.keys(k2.store.meta<Record<string, unknown>>('held') ?? {})).toEqual([chat.id])
    await k2.stop()
  })

  it('saves the brief before setup runs, so a quit during setup keeps it (KERNEL-128)', async () => {
    const { k, room } = await restartable({ '.kernel/settings.toml': '[scripts]\nsetup = "sleep 5"\n' })
    const made = k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table' })
    const ws = await vi.waitFor(() => { const w = k.store.workspaces(room.id).find((x) => x.title === 'Invoice table' && x.status === 'setup'); if (!w || !k.store.meta<Record<string, { brief?: unknown }>>('setups')?.[w.id]?.brief) throw new Error('not yet'); return w })
    expect(k.store.meta<Record<string, { brief: unknown }>>('setups')![ws.id].brief).toEqual([{ type: 'text', text: 'Build T-14' }])
    await k.archiveWorkspace(ws.id)
    await made
    expect(k.store.meta('setups')).toEqual({})
    await k.stop()
  })

  it('turns a workspace Kernel quit during setup into a failed one, with its brief held and a note (KERNEL-128)', async () => {
    const { k, room, again } = await restartable({})
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table' })
    const chat = k.store.chats(ws.id)[0]
    // As if Kernel quit while setup ran: the workspace says setup, and the brief and a message wait in the saved hold.
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, status: 'setup' })
    k.store.saveMeta('setups', { [ws.id]: { chatId: chat.id, brief: [{ type: 'text', text: 'Build T-14' }], from: 'lead', later: [[{ type: 'text', text: 'Use EmptyState' }]] } })
    await k.stop()
    const k2 = await again()
    expect(k2.store.workspace(ws.id)?.status).toBe('failed')
    expect(texts(k2, chat.id)).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
    expect(k2.store.items(chat.id).filter((i) => i.kind === 'note').map((i) => (i as { text: string }).text)).toContain('Setup stopped when Kernel quit. Click Run again.')
    expect(k2.store.meta('setups')).toEqual({})
    await k2.stop()
  })

  it("tells the Lead about a setup failure only once, and about Run again failing or passing (KERNEL-126)", async () => {
    const { k, room } = await kernel({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const lead = await k.leadChat(room.id)
    // Rowan's own chat runs the same setup, which fails the same way (KERNEL-405).
    await setUp(k, lead.id, 'failed')
    // Rowan's turn waits on create_workspace, so its result tells Rowan.
    const running = k.sessions.isRunning
    k.sessions.isRunning = (id) => id === lead.id
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    k.sessions.isRunning = running
    const waiting = () => [...(k.leadUpdates as unknown as { pending: Map<string, { events: { kind: string; told?: boolean; code?: number | null }[] }> }).pending.values()].flatMap((p) => p.events)
    expect(waiting()).toEqual([expect.objectContaining({ kind: 'setup.failed', told: true, code: 1 })])
    await k.retrySetup(ws.id)
    expect(waiting().at(-1)).toMatchObject({ kind: 'setup.failed', code: 1 })
    expect(waiting().at(-1)?.told).toBeUndefined()
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    expect((await k.retrySetup(ws.id)).status).toBe('ready')
    expect(waiting().at(-1)).toMatchObject({ kind: 'setup.passed' })
    await k.stop()
  })

  it("doesn't tell the Lead setup failed when the user archived the workspace during Run again (KERNEL-126)", async () => {
    const { k, room } = await kernel({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt || (sleep 1 && false)"\n' })
    const lead = await k.leadChat(room.id)
    // Rowan's own chat runs the same setup, which fails the same way (KERNEL-405).
    await setUp(k, lead.id, 'failed')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const waiting = () => [...(k.leadUpdates as unknown as { pending: Map<string, { events: { kind: string; code?: number | null }[] }> }).pending.values()].flatMap((p) => p.events)
    const before = waiting()
    const rerun = k.retrySetup(ws.id)
    await new Promise((r) => setTimeout(r, 200))
    await k.archiveWorkspace(ws.id)
    await rerun
    expect(waiting()).toEqual(before)
    await k.stop()
  })

  it('stops setup from the Setup tab: failed with no exit code, the brief still held, and no word to the Lead (KERNEL-430)', async () => {
    const { k, room } = await kernel({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt || (sleep 2 && false)"\n' })
    const lead = await k.leadChat(room.id)
    await setUp(k, lead.id, 'failed')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const chat = k.store.chats(ws.id)[0]
    const waiting = () => [...(k.leadUpdates as unknown as { pending: Map<string, { events: { kind: string }[] }> }).pending.values()].flatMap((p) => p.events)
    const before = waiting()
    const rerun = k.setup.retrySetup(ws.id)
    await new Promise((r) => setTimeout(r, 300))
    expect(k.store.workspace(ws.id)?.setupRun?.endedAt).toBeUndefined()
    await k.setup.handlers()['scripts.stop']({ workspaceId: ws.id, kind: 'setup' })
    const after = await rerun
    expect(after.status).toBe('failed')
    expect(after.setupRun?.end).toBeNull()
    expect(after.setupRun?.endedAt).toBeGreaterThanOrEqual(after.setupRun!.startedAt)
    expect(k.sessions.queued(chat.id).map((q) => (q.parts[0] as { text: string }).text)).toEqual(['Build T-14'])
    expect(waiting()).toEqual(before)
    await k.stop()
  })

  it('sends a brief anyway after setup failed, once, with a note above it, and the Lead hears setup passed (KERNEL-430)', async () => {
    const { k, room } = await kernel({ '.kernel/settings.toml': '[scripts]\nsetup = "false"\n' })
    const lead = await k.leadChat(room.id)
    await setUp(k, lead.id, 'failed')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const chat = k.store.chats(ws.id)[0]
    expect(ws.status).toBe('failed')
    // A second Send anyway while the first is on its way does nothing.
    const [first, second] = await Promise.all([k.setup.skipSetup(ws.id), k.setup.skipSetup(ws.id)])
    expect(first.status).toBe('ready')
    expect(second.status).toBe('failed')
    const notes = k.store.items(chat.id).filter((i) => i.kind === 'note').map((i) => (i as { text: string }).text)
    expect(notes.filter((n) => n === 'Setup failed, sent anyway')).toHaveLength(1)
    expect(notes.some((n) => n.startsWith('Setup finished'))).toBe(false)
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(k.store.items(chat.id).some((i) => i.kind === 'user')).toBe(true)
    const waiting = () => [...(k.leadUpdates as unknown as { pending: Map<string, { events: { kind: string }[] }> }).pending.values()].flatMap((p) => p.events)
    expect(waiting().at(-1)).toMatchObject({ kind: 'setup.passed' })
    // A workspace that isn't failed has nothing to skip.
    expect((await k.setup.skipSetup(ws.id)).status).toBe('ready')
    await k.stop()
  })

  it('writes no note above the brief when Run again passes (KERNEL-430, KERNEL-533)', async () => {
    const { k, room } = await kernel({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const lead = await k.leadChat(room.id)
    await setUp(k, lead.id, 'failed')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const chat = k.store.chats(ws.id)[0]
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    expect((await k.setup.retrySetup(ws.id)).status).toBe('ready')
    expect(k.store.items(chat.id).filter((i) => i.kind === 'note')).toEqual([])
    expect(k.store.workspace(ws.id)?.setupRun).toMatchObject({ end: 0 })
    await k.stop()
  })

  it("tells the Lead when a teammate's session dies partway through a turn (KERNEL-124)", async () => {
    const { k, room } = await kernel()
    const lead = await k.leadChat(room.id)
    await setUp(k, lead.id)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const call = sdk.calls[sdk.calls.length - 1]
    await flush()
    call.end()
    await flush()
    const waiting = [...(k.leadUpdates as unknown as { pending: Map<string, { events: { kind: string; workspaceId: string }[] }> }).pending.values()].flatMap((p) => p.events)
    expect(waiting).toEqual([expect.objectContaining({ kind: 'crash', workspaceId: ws.id })])
    await k.stop()
  })

  it("Retry now sends a Kernel update first, as Kernel's, and leaves a pending hand-off alone (KERNEL-116)", async () => {
    const { k, room } = await kernel()
    const chat = await k.leadChat(room.id)
    await setUp(k, chat.id)
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed(result())
    await flush()
    const update = { rows: [] }
    expect(k.sessions.post(chat.id, [{ type: 'text', text: 'Team update from Kernel, not from the user.' }], { update })).toBe(true)
    const sent = k.store.items(chat.id).filter((i) => i.kind === 'user').pop()!
    await k.sessions.send(chat.id, [{ type: 'text', text: 'later' }])
    k.sessions.handoffs.approved(chat.id)
    await k.handlers()['chats.retry']({ chatId: chat.id, itemId: sent.id, now: true })
    expect(k.sessions.queued(chat.id).map((q) => q.from)).toEqual(['kernel', undefined])
    expect(k.sessions.handoffs.due(chat.id)).toBe(true)
    // The interrupted turn ends and the copy goes out before "later".
    call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r2', duration_ms: 10 })
    await flush()
    expect(k.store.items(chat.id).filter((i) => i.kind === 'user').pop()).toMatchObject({ from: 'kernel', update })
    expect(k.sessions.handoffs.due(chat.id)).toBe(true)
    await k.stop()
  })

  it('Retry now sends an update past a limit pause, as Send now does (KERNEL-116)', async () => {
    const { k, chat } = await limited()
    k.store.saveItem(chat.id, { kind: 'user', id: 'old', ts: 2, parts: [{ type: 'text', text: 'Update from Kernel (not the user):\n- Kai · Inbox actions (workspace w2): PR #60 is ready to merge' }] })
    await k.handlers()['chats.retry']({ chatId: chat.id, itemId: 'old', now: true })
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(k.store.items(chat.id).filter((i) => i.kind === 'user').pop()).toMatchObject({ from: 'kernel' })
    await k.stop()
  })

  it('holds the first prompt while setup fails, and sends it once Run again passes', async () => {
    const { k, room } = await kernel({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const before = sdk.calls.length
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table' })
    expect(ws.status).toBe('failed')
    const chat = k.store.chats(ws.id)[0]
    expect(k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build T-14' }]])
    expect(sdk.calls.length).toBe(before)

    // Still failing: stays failed, the prompt keeps waiting.
    expect((await k.retrySetup(ws.id)).status).toBe('failed')
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    expect((await k.retrySetup(ws.id)).status).toBe('ready')
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(sdk.calls.length).toBe(before + 1)
    expect(k.store.items(chat.id).find((i) => i.kind === 'user')).toMatchObject({ parts: [{ type: 'text', text: 'Build T-14' }] })
    await k.stop()
  })

  it('pauses every room on a 5-hour rejection and resumes them when it lifts', async () => {
    const { k, room } = await kernel()
    const chat = await k.leadChat(room.id)
    await setUp(k, chat.id)
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    const call = sdk.calls[sdk.calls.length - 1]
    const resetsAt = S(Date.now() + 3600_000)
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, utilization: 1 }, uuid: 'l1', session_id: 's' })
    await flush()
    expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    expect(k.sessions.isPaused(room.id)).toBe(true)
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: S(Date.now() + 5 * 3600_000), utilization: 0.1 }, uuid: 'l2', session_id: 's' })
    await flush()
    expect(k.store.room(room.id)?.paused).toBe(false)
    await k.stop()
  })

  it('lifts a limit pause when Claude Code reports room before the reset time, and sends what queued', async () => {
    const { k, room, chat, resetsAt } = await limited()
    expect(await k.sessions.send(chat.id, [{ type: 'text', text: 'hi' }])).toEqual({ queued: true, why: 'paused' })
    sdk.usage = usageAt(100, resetsAt)
    await k.checkLimits()
    expect(k.store.room(room.id)?.paused).toBe(true)
    // Reset on claude.ai: the window is empty again an hour before its reset time.
    sdk.usage = usageAt(0, resetsAt)
    await k.checkLimits()
    expect(k.store.room(room.id)?.paused).toBe(false)
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(k.store.items(chat.id).filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: 'hi' }] })
    sdk.usage = null
    await k.stop()
  })

  it('lifts a limit pause by the clock when its timer runs late, as after the Mac sleeps', async () => {
    const { k, room, resetsAt } = await limited()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(resetsAt * 1000 + 1000)
      await k.checkLimits()
    } finally { vi.useRealTimers() }
    expect(k.store.room(room.id)?.paused).toBe(false)
    await k.stop()
  })

  it('asks with a short session when a limit pauses the rooms and no session is live', async () => {
    const { k, room, resetsAt } = await limited()
    k.sessions.stopAll()
    const before = sdk.calls.length
    sdk.usage = usageAt(0, resetsAt)
    await k.checkLimits()
    const probe = sdk.calls[before]
    expect(probe.options).toMatchObject({ settingSources: [], persistSession: false })
    expect(probe.options.abortController.signal.aborted).toBe(true)
    expect(k.store.room(room.id)?.paused).toBe(false)
    sdk.usage = null
    await k.stop()
  })

  it('sends a queued message past a limit pause on Send now, and lifts the pause when Claude Code says the limit is gone', async () => {
    const { k, room, chat, call } = await limited()
    await k.sessions.send(chat.id, [{ type: 'text', text: 'hi' }])
    const [q] = k.sessions.queued(chat.id)
    expect(await k.handlers()['chats.sendNow']({ chatId: chat.id, id: q.id })).toEqual([])
    expect(k.sessions.isRunning(chat.id)).toBe(true)
    expect(k.store.room(room.id)?.paused).toBe(true)
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: S(Date.now() + 5 * 3600_000), utilization: 0.01 }, uuid: 'l2', session_id: 's' })
    await flush()
    expect(k.store.room(room.id)?.paused).toBe(false)
    await k.stop()
  })

  it('carries on a chat the limit stopped mid-turn once the limit lifts', async () => {
    const { k, room, chat, call } = await limited()
    expect(k.sessions.isRunning(chat.id)).toBe(false)
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: S(Date.now() + 5 * 3600_000), utilization: 0.01 }, uuid: 'l2', session_id: 's' })
    await flush()
    expect(k.store.room(room.id)?.paused).toBe(false)
    expect(k.sessions.isRunning(chat.id)).toBe(true)
    expect(k.store.items(chat.id).filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: LIMIT_LIFTED }] })
    await k.stop()
  })

  it('keeps a limit pause across a restart while the limit holds, and carries the stopped chat on once it resets', async () => {
    const { k, room, chat, resetsAt } = await limited()
    const dataDir = k.o.dataDir
    await k.stop()
    const again = new Kernel({ dataDir })
    // A start with a cut-off chat checks the sign-in (KERNEL-215). The real one runs `claude auth status`.
    again.signedInReader = async () => true
    await again.start()
    expect(again.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    expect(again.sessions.isPaused(room.id)).toBe(true)
    await again.stop()
    // Kernel stayed closed through the reset: the next start lifts the pause and the Lead picks up where it left off.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(resetsAt * 1000 + 1000)
      const later = new Kernel({ dataDir })
      later.signedInReader = async () => true
      await later.start()
      // The chats carry on once the launch check, in the background, lets them.
      await flush()
      expect(later.store.room(room.id)?.paused).toBe(false)
      expect(later.sessions.isRunning(chat.id)).toBe(true)
      expect(later.store.items(chat.id).filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: LIMIT_LIFTED }] })
      await later.stop()
    } finally { vi.useRealTimers() }
  })

  it("leaves the rooms running on Fable's own limit, and carries the chat on when it switches model", async () => {
    const { k, room } = await kernel()
    const chat = await k.leadChat(room.id)
    await setUp(k, chat.id)
    await k.handlers()['chats.configure']({ chatId: chat.id, model: 'claude-fable-5-1' })
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: S(Date.now() + 86_400_000), utilization: 1 }, uuid: 'l1', session_id: 's' })
    call.feed(result())
    await flush()
    expect(k.store.room(room.id)?.paused).toBe(false)
    expect(k.sessions.isRunning(chat.id)).toBe(false)
    await k.handlers()['chats.configure']({ chatId: chat.id, model: 'claude-opus-5-5' })
    expect(k.sessions.isRunning(chat.id)).toBe(true)
    expect(k.store.items(chat.id).filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: LIMIT_LIFTED }] })
    await k.stop()
  })

  it('marks a sign-out from a session and holds sends until sign in', async () => {
    const { k, room } = await kernel()
    const { pushes, off } = listen()
    const chat = await k.leadChat(room.id)
    await setUp(k, chat.id)
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    sdk.calls[sdk.calls.length - 1].feed({ type: 'assistant', uuid: 'm', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] }, session_id: 's' })
    await flush()
    expect(pushes.find((e) => e.type === 'account')).toMatchObject({ account: { signedIn: false } })
    expect(k.sessions.heldFor()).toEqual(['auth'])
    off()
    await k.stop()
  })

  it('refuses to discard on the current branch or while the agent works, and checkpoints before it does', async () => {
    const { k, room } = await kernel({ 'a.ts': 'one\n' })
    const h = k.handlers()
    const cur = await k.createWorkspace(room.id, { prompt: 'Look around', agentId: 'kai', title: 'Here', mode: 'current' })
    await expect(h['workspaces.discard']({ workspaceId: cur.id })).rejects.toThrow('current branch')
    const ws = await k.createWorkspace(room.id, { prompt: 'Edit a.ts', agentId: 'kai', title: 'Edit' })
    await expect(h['workspaces.discard']({ workspaceId: ws.id })).rejects.toThrow('still working')
    sdk.calls[sdk.calls.length - 1].feed(result('done'))
    await flush()
    await writeFile(join(ws.path, 'a.ts'), 'two\n')
    expect((await h['workspaces.gitStatus']({ workspaceId: ws.id })).dirty.files).toBe(1)
    await h['workspaces.discard']({ workspaceId: ws.id })
    expect(await readFile(join(ws.path, 'a.ts'), 'utf8')).toBe('one\n')
    expect((await h['checkpoints.list']({ workspaceId: ws.id })).some((c) => c.title === 'Before discarding changes')).toBe(true)
    await k.stop()
  })

  it('keeps a branch with unpushed commits on archive, even when asked to delete it', async () => {
    const { k, room } = await kernel()
    const h = k.handlers()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Keep me' })
    await writeFile(join(ws.path, 'c.ts'), 'c\n')
    await run('git', ['-C', ws.path, 'add', '-A'])
    await run('git', ['-C', ws.path, 'commit', '-q', '-m', 'only here'])
    expect((await h['workspaces.gitStatus']({ workspaceId: ws.id })).ahead).toBe(1)
    await h['workspaces.archive']({ workspaceId: ws.id, deleteBranch: true })
    expect((await run('git', ['-C', room.path, 'branch', '--list', ws.branch])).trim()).toContain(ws.branch)
    // With nothing unpushed, the branch goes as asked.
    const empty = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Drop me' })
    await h['workspaces.archive']({ workspaceId: empty.id, deleteBranch: true })
    expect((await run('git', ['-C', room.path, 'branch', '--list', empty.branch])).trim()).toBe('')
    await k.stop()
  })

  it('lifts a sign-out when the CLI is signed in again from a terminal', async () => {
    const { k, room } = await kernel()
    const { pushes, off } = listen()
    let signedIn = false
    k.accountReader = async () => (signedIn ? { signedIn: true, name: 'Sam Rivera' } : { signedIn: false })
    const chat = await k.leadChat(room.id)
    await setUp(k, chat.id)
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    sdk.calls[sdk.calls.length - 1].feed({ type: 'assistant', uuid: 'm', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] }, session_id: 's' })
    await flush()
    expect(k.sessions.heldFor()).toEqual(['auth'])
    await k.handlers()['account.get'](undefined)
    expect(k.sessions.heldFor()).toEqual(['auth'])
    signedIn = true
    expect(await k.handlers()['account.get'](undefined)).toMatchObject({ signedIn: true })
    expect(k.sessions.heldFor()).toEqual([])
    expect(pushes.filter((e) => e.type === 'account').pop()).toMatchObject({ account: { signedIn: true, name: 'Sam Rivera' } })
    off()
    await k.stop()
  })

  it('lifts a limit pause left from the last run, and keeps a pause the user chose', async () => {
    const { k, room } = await kernel()
    const other = await k.addRoom(await tempRepo())
    k.pauseRoom(room.id, 'limit')
    k.pauseRoom(other.id, 'you')
    await k.stop()
    const again = new Kernel({ dataDir: k.o.dataDir })
    await again.start()
    expect(again.store.room(room.id)).toMatchObject({ paused: false })
    expect(again.store.room(room.id)?.pausedBy).toBeUndefined()
    expect(again.sessions.isPaused(room.id)).toBe(false)
    expect(again.store.room(other.id)).toMatchObject({ paused: true, pausedBy: 'you' })
    expect(again.sessions.isPaused(other.id)).toBe(true)
    await again.stop()
  })

  it('only promises a reset notification for a limit it has a reset time for', async () => {
    const { k } = await kernel()
    await expect(k.handlers()['usage.notifyOnReset']({ type: 'five_hour' })).rejects.toThrow('does not know when')
    await k.stop()
  })
})

describe('the usage guards in a Kernel (KERNEL-220)', () => {
  const near = (type: 'five_hour' | 'seven_day', utilization: number, resetsAt: number, status = 'allowed') => ({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: type, resetsAt, utilization }, uuid: `l-${type}-${utilization}-${resetsAt}`, session_id: 's' })
  const weekly = (k: Kernel) => k.store.notifications().filter((n) => n.id.startsWith('n-weekly-'))
  const NEXT_WEEK = S(Date.now() + 5 * 86_400_000)

  it('warns once per weekly window when it crosses 80%, in the Inbox and as a macOS banner', async () => {
    const shown: { title: string; sub: string }[] = []
    const { k, room } = await kernel({}, { options: { inBackground: () => true, showNotification: (n) => { shown.push({ title: n.title, sub: n.sub }) } } })
    const chat = await k.leadChat(room.id)
    await setUp(k, chat.id)
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed(near('seven_day', 0.79, NEXT_WEEK))
    await flush()
    expect(weekly(k)).toEqual([])
    call.feed(near('seven_day', 0.8, NEXT_WEEK))
    await flush()
    expect(weekly(k)).toHaveLength(1)
    expect(weekly(k)[0]).toMatchObject({ id: `n-weekly-${NEXT_WEEK}`, kind: 'system', title: "You've used 80% of this week's limit", needsYou: false, read: false })
    expect(weekly(k)[0].sub).toMatch(/^Resets \w+day at /)
    // More events in the same window, a second off as the usage call reads them, and a restart's reading: still one.
    call.feed(near('seven_day', 0.86, NEXT_WEEK))
    call.feed(near('seven_day', 0.9, NEXT_WEEK + 1))
    await flush()
    k.sessions.drainWaiting()
    expect(weekly(k)).toHaveLength(1)
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe("You've used 80% of this week's limit")
    // The next window warns again.
    call.feed(near('seven_day', 0.95, NEXT_WEEK + 7 * 86_400))
    await flush()
    expect(weekly(k)).toHaveLength(2)
    expect(weekly(k).find((n) => n.id === `n-weekly-${NEXT_WEEK + 7 * 86_400}`)?.title).toBe("You've used 95% of this week's limit")
    await k.stop()
  })

  it('warns about nothing when the switch in Settings, Account is off', async () => {
    const { k, room } = await kernel({}, { settings: { usage: { warnBeforeWeekly: false, pauseNearLimit: true } } })
    const chat = await k.leadChat(room.id)
    await setUp(k, chat.id)
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    sdk.calls[sdk.calls.length - 1].feed(near('seven_day', 0.9, NEXT_WEEK))
    await flush()
    expect(weekly(k)).toEqual([])
    await k.stop()
  })

  it('sends what a held teammate waited for when the window resets, by its own timer', async () => {
    const { k, room } = await kernel()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Table' })
    const chat = k.store.chats(ws.id)[0]
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed(result())
    await flush()
    expect(k.sessions.isRunning(chat.id)).toBe(false)
    const resetsAt = S(Date.now() + 2000)
    call.feed(near('five_hour', 0.93, resetsAt))
    await flush()
    // The window holds teammates and keeps a timer, which "Notify me" does not take as a rejected limit.
    expect(await k.sessions.send(chat.id, [{ type: 'text', text: 'Next task' }])).toEqual({ queued: true, why: 'limit' })
    expect(k.store.room(room.id)?.paused).toBe(false)
    expect((k.account as unknown as { limitCheck?: unknown }).limitCheck).toBeDefined()
    await expect(k.handlers()['usage.notifyOnReset']({ type: 'five_hour' })).rejects.toThrow('does not know when')
    await vi.waitFor(() => expect(k.sessions.isRunning(chat.id)).toBe(true), { timeout: 8000 })
    expect(k.sessions.queued(chat.id)).toEqual([])
    // Nothing holds any more, so nothing keeps asking for fresh numbers.
    expect((k.account as unknown as { limitCheck?: unknown }).limitCheck).toBeUndefined()
    await k.stop()
  }, 20000)

  it("doesn't poll for usage when nothing is held, or when the switch is off", async () => {
    const off = await kernel({}, { settings: { usage: { warnBeforeWeekly: true, pauseNearLimit: false } } })
    const chat = await off.k.leadChat(off.room.id)
    await setUp(off.k, chat.id)
    await off.k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    sdk.calls[sdk.calls.length - 1].feed(near('five_hour', 0.97, S(Date.now() + 3600_000)))
    await flush()
    expect((off.k.account as unknown as { limitCheck?: unknown }).limitCheck).toBeUndefined()
    expect(off.k.sessions.waitsFor(chat.id)).toBe('running')
    await off.k.stop()
  })

  it('still lets the user ask to hear about a rejected limit', async () => {
    const { k, room } = await limited()
    expect(await k.handlers()['usage.notifyOnReset']({ type: 'five_hour' })).toEqual({ ok: true })
    expect(k.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    await k.stop()
  })
})
