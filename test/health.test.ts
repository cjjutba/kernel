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
import { Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { blockingLimit, failureOf, fallbackModel, limitedModels, NetworkMonitor, terminalScript } from '../src/main/services/health'
import { discardChanges, gitStatus, pushBranch } from '../src/main/services/archive'
import { run } from '../src/main/services/exec'
import { tempRepo } from './helpers'

// A scripted SDK, as in sessionRunner.test.ts. `context` is what getContextUsage reports.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[], context: 40 }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    const call = { options, feed: (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
      getContextUsage: async () => ({ percentage: sdk.context })
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
    sdk.context = 40
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
    expect(await sessions.send(chat.id, [{ type: 'text', text: 'Also add a loading skeleton.' }])).toEqual({ queued: true })
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
  return { k, room, repo }
}

describe('kernel recovery paths', () => {
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
