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
import { tempRepo, trustRoom } from './helpers'

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

async function runner(o: { onFailure?: (f: string) => void } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-health-')), 'kernel.db'))
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-table', branch: 'feat/x', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kai', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Table', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 } } as unknown as AppSettings
  const sessions = new Sessions({
    store, approvals: new Approvals(store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => undefined,
    onFailure: (f) => o.onFailure?.(f)
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

async function kernel(files: Record<string, string> = {}) {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nYou are Kai.',
    ...files
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
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
    const again = async () => { const next = new Kernel({ dataDir, home }); await next.start(); return next }
    return { k, room, again }
  }
  const texts = (k: Kernel, chatId: string) => k.sessions.queued(chatId).map((q) => [(q.parts[0] as { text: string }).text, q.from])

  it('keeps a held brief, and the Lead\'s message behind it, across a restart, and Run again sends them in order (KERNEL-128)', async () => {
    const { k, room, again } = await restartable({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const lead = await k.leadChat(room.id)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    expect(ws.status).toBe('failed')
    await k['messageWorkspace'](room.id, ws.id, 'Use EmptyState')
    const chat = k.store.chats(ws.id)[0]
    expect(texts(k, chat.id)).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
    await k.stop()
    const k2 = await again()
    expect(texts(k2, chat.id)).toEqual([['Build T-14', 'lead'], ['Use EmptyState', 'lead']])
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    expect((await k2.retrySetup(ws.id)).status).toBe('ready')
    // Nothing is held any more, so nothing comes back after another restart.
    expect(k2.store.meta('held')).toEqual({})
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
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const other = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Invoice export', leadChatId: lead.id })
    await k['messageWorkspace'](room.id, ws.id, 'Use EmptyState')
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

  it("tells the Lead when a teammate's session dies partway through a turn (KERNEL-124)", async () => {
    const { k, room } = await kernel()
    const lead = await k.leadChat(room.id)
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
    const dataDir = (k as unknown as { o: { dataDir: string } }).o.dataDir
    await k.stop()
    const again = new Kernel({ dataDir })
    await again.start()
    expect(again.store.room(room.id)).toMatchObject({ paused: true, pausedBy: 'limit' })
    expect(again.sessions.isPaused(room.id)).toBe(true)
    await again.stop()
    // Kernel stayed closed through the reset: the next start lifts the pause and the Lead picks up where it left off.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(resetsAt * 1000 + 1000)
      const later = new Kernel({ dataDir })
      await later.start()
      expect(later.store.room(room.id)?.paused).toBe(false)
      expect(later.sessions.isRunning(chat.id)).toBe(true)
      expect(later.store.items(chat.id).filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: LIMIT_LIFTED }] })
      await later.stop()
    } finally { vi.useRealTimers() }
  })

  it("leaves the rooms running on Fable's own limit, and carries the chat on when it switches model", async () => {
    const { k, room } = await kernel()
    const chat = await k.leadChat(room.id)
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
    const lead = await k.leadChat(room.id)
    await expect(h['workspaces.discard']({ workspaceId: lead.workspaceId })).rejects.toThrow('current branch')
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
    const again = new Kernel({ dataDir: (k as unknown as { o: { dataDir: string } }).o.dataDir })
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
