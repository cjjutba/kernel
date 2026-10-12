import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { git, run } from '../src/main/services/exec'
import { createWorktree, leadBranch, moveWorktree, roomWorktreeRoot, worktreeFolder } from '../src/main/services/worktrees'
import { fakeCodex } from './helpers/fakeCodex'
import { setUp, tempRepo } from './helpers'

// KERNEL-424: a chat with Rowan names its branch and its worktree folder once, from the chat's first title. Later titles, and
// a name the user types, name only the chat.

// A scripted SDK, as in leadMerge.test.ts: a turn runs until the test feeds its result.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: unknown }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    const feed = (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) }
    sdk.calls.push({ options, feed })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => { feed({ type: 'result', subtype: 'error_during_execution', uuid: `i${sdk.calls.length}`, duration_ms: 1 }) }, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 10 })
    }
  }
}))

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.'
}

const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId })
const result = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1 })
const tasks = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id })) })
const callIn = (path: string) => sdk.calls.filter((c) => c.options.cwd === path)
const branchOf = async (path: string) => (await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()

/** A started Kernel on a repo with an `origin`, stopped when the test ends. Chat names come only from the test. */
async function room() {
  const repo = await tempRepo(REPO)
  const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', bare])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
  await run('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main'])
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir, home })
  k.signedInReader = async () => true
  k.titleFor = async () => undefined
  k.sessionInfo = async () => undefined
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  const r = await k.addRoom(repo)
  return { k, repo, room: r, root: roomWorktreeRoot(join(home, 'wt'), r) }
}

/** Claude Code titles the tab, as Chats.autoName passes it on. */
const titled = (k: Kernel, chat: Chat, title: string) => k.lead.tabNamed(k.store.saveChat({ ...k.store.chat(chat.id)!, title }))

/** A new chat with Rowan that has sent nothing, so it is idle once setup passes. */
async function idleChat(k: Kernel, roomId: string) {
  const chat = await k.lead.startLeadChat(roomId, { prompt: '' })
  return { chat, ws: await setUp(k, chat.id) }
}

afterEach(() => { sdk.calls.length = 0 })

describe("a chat with Rowan's branch name (KERNEL-424)", () => {
  it('takes every word of the title, cut at a word to 60 characters', () => {
    expect(leadBranch('{lead}/{slug}', 'Setup script tab Run button redundancy', 'Rowan')).toBe('rowan/setup-script-tab-run-button-redundancy')
    // Filler words stay, and an apostrophe goes.
    expect(leadBranch('{lead}/{slug}', "Don't break the CI when it is red", 'Rowan')).toBe('rowan/dont-break-the-ci-when-it-is-red')
    const long = leadBranch('{lead}/{slug}', 'Plan the invoices export with PDF and CSV for every client in the workspace', 'Rowan')
    expect(long).toBe('rowan/plan-the-invoices-export-with-pdf-and-csv-for-every')
    expect(long.length).toBeLessThanOrEqual(60)
    expect(worktreeFolder('rowan/setup-script-tab-run-button-redundancy')).toBe('rowan-setup-script-tab-run-button-redundancy')
  })
})

describe("naming a chat with Rowan's branch and folder once (KERNEL-424)", () => {
  it('renames the branch at the first title, moves the folder when the turn ends, and the next message resumes the session there', async () => {
    const { k, repo, room: r, root } = await room()
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'in a setup script tab in the workspace the Run button does the same as Play' })
    const ws = await setUp(k, chat.id)
    expect(ws).toMatchObject({ branch: 'rowan/in-setup-script-tab-in', naming: 'branch' })
    expect(ws.path).toBe(join(root, 'rowan-in-setup-script-tab-in'))
    const first = await vi.waitFor(() => { const c = callIn(ws.path)[0]; expect(c).toBeDefined(); return c })
    first.feed(init('S1'))
    await vi.waitFor(() => expect(k.store.chat(chat.id)?.sessionId).toBe('S1'))

    // Claude Code titles the chat mid-turn. The branch takes the whole title at once, and the folder waits for the turn.
    titled(k, chat, 'Setup script tab Run button redundancy')
    await vi.waitFor(() => expect(k.store.workspace(ws.id)).toMatchObject({ branch: 'rowan/setup-script-tab-run-button-redundancy', name: 'setup-script-tab-run-button-redundancy', naming: 'folder' }))
    expect(k.store.workspace(ws.id)).toMatchObject({ path: ws.path, title: 'Setup script tab Run button redundancy' })
    expect(k.store.thread(chat.threadId!)!.title).toBe('Setup script tab Run button redundancy')
    expect(await branchOf(ws.path)).toBe('rowan/setup-script-tab-run-button-redundancy')
    expect(await git(repo, 'branch', '--list', 'rowan/in-setup-script-tab-in')).toBe('')

    first.feed(result('r1'))
    const moved = join(root, 'rowan-setup-script-tab-run-button-redundancy')
    await vi.waitFor(() => expect(k.store.workspace(ws.id)!.path).toBe(moved), { timeout: 10_000 })
    expect(k.store.workspace(ws.id)!.naming).toBeUndefined()
    expect(existsSync(ws.path)).toBe(false)
    expect(await branchOf(moved)).toBe('rowan/setup-script-tab-run-button-redundancy')
    expect((await git(repo, 'worktree', 'list', '--porcelain'))).toContain(`${await realpath(moved)}\n`)
    // The turn's checkpoint was saved before the folder moved.
    const saved = await k.handlers()['checkpoints.list']({ workspaceId: ws.id })
    expect(saved.some((c) => c.chatId === chat.id && !c.start)).toBe(true)

    // The process that ran in the old folder ended. The next message resumes the same session from the new one.
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Go on' }])
    await vi.waitFor(() => expect(callIn(moved)).toHaveLength(1))
    expect(callIn(moved)[0].options).toMatchObject({ cwd: moved, resume: 'S1' })
    // The database and Compose names setup ran with hold in the new folder (KERNEL-449).
    const names = (env: Record<string, string>) => ({ slug: env.KERNEL_WORKSPACE_SLUG, compose: env.COMPOSE_PROJECT_NAME })
    expect(names(callIn(moved)[0].options.env)).toEqual(names(first.options.env))
    expect(names(first.options.env).compose).toMatch(/^kernel_/)
    expect(callIn(ws.path)).toHaveLength(1)

    // A later title, and a name the user types, name the chat and the breadcrumb only.
    titled(k, chat, 'Snippets overflow fix approved')
    expect(k.store.thread(chat.threadId!)!.title).toBe('Snippets overflow fix approved')
    expect(k.store.workspace(ws.id)).toMatchObject({ title: 'Snippets overflow fix approved', branch: 'rowan/setup-script-tab-run-button-redundancy', path: moved })
    await k.handlers()['threads.rename']({ threadId: chat.threadId!, title: 'Run button' })
    expect(k.store.workspace(ws.id)).toMatchObject({ title: 'Run button', branch: 'rowan/setup-script-tab-run-button-redundancy', path: moved })
    await k.lead.nameChatBranch(ws.id, 'Something else')
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: 'rowan/setup-script-tab-run-button-redundancy', path: moved })
    expect(await branchOf(moved)).toBe('rowan/setup-script-tab-run-button-redundancy')
  })

  it('takes the free-name suffix when the branch or the folder is taken', async () => {
    const { k, repo, room: r, root } = await room()
    await run('git', ['-C', repo, 'branch', 'rowan/plan-the-release'])
    const a = await idleChat(k, r.id)
    titled(k, a.chat, 'Plan the release')
    await vi.waitFor(() => expect(k.store.workspace(a.ws.id)).toMatchObject({ branch: 'rowan/plan-the-release-2', path: join(root, 'rowan-plan-the-release-2') }))
    // A folder left in the worktree root, that git doesn't know.
    await mkdir(join(root, 'rowan-check-the-docs'))
    const b = await idleChat(k, r.id)
    titled(k, b.chat, 'Check the docs')
    await vi.waitFor(() => expect(k.store.workspace(b.ws.id)).toMatchObject({ branch: 'rowan/check-the-docs', path: join(root, 'rowan-check-the-docs-2') }))
    expect(k.store.workspace(b.ws.id)!.naming).toBeUndefined()
    expect(await branchOf(join(root, 'rowan-check-the-docs-2'))).toBe('rowan/check-the-docs')
  })

  it('leaves a pushed branch, one with a PR, and a chat from before alone', async () => {
    const { k, room: r } = await room()
    const pushed = await idleChat(k, r.id)
    await run('git', ['-C', pushed.ws.path, 'push', '-q', '-u', 'origin', pushed.ws.branch])
    titled(k, pushed.chat, 'Plan wave 3')
    await vi.waitFor(() => expect(k.store.workspace(pushed.ws.id)!.naming).toBeUndefined())
    expect(k.store.workspace(pushed.ws.id)).toMatchObject({ branch: pushed.ws.branch, path: pushed.ws.path, title: 'Plan wave 3' })

    const pr = await idleChat(k, r.id)
    k.store.saveWorkspace({ ...k.store.workspace(pr.ws.id)!, prNumber: 9, prState: 'open' })
    titled(k, pr.chat, 'Fix the docs')
    await vi.waitFor(() => expect(k.store.workspace(pr.ws.id)!.naming).toBeUndefined())
    expect(k.store.workspace(pr.ws.id)).toMatchObject({ branch: pr.ws.branch, path: pr.ws.path })

    // A chat from before KERNEL-424 has no `naming`: its title names the chat only.
    const old = await idleChat(k, r.id)
    k.store.saveWorkspace({ ...k.store.workspace(old.ws.id)!, naming: undefined })
    titled(k, old.chat, 'Old chat')
    await k.lead.nameChatBranch(old.ws.id, 'Old chat')
    expect(k.store.workspace(old.ws.id)).toMatchObject({ branch: old.ws.branch, path: old.ws.path, title: 'Old chat' })
  })

  it('waits for background tasks and a terminal command, and the terminal comes back in the new folder', async () => {
    const { k, root, room: r } = await room()
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Watch the build' })
    const ws = await setUp(k, chat.id)
    const turn = await vi.waitFor(() => { const c = callIn(ws.path)[0]; expect(c).toBeDefined(); return c })
    turn.feed(init('S2'))
    turn.feed(tasks('build'))
    titled(k, chat, 'Watch the build')
    await vi.waitFor(() => expect(k.store.workspace(ws.id)!.naming).toBe('folder'))
    // The turn ends with a background task still running in the folder.
    turn.feed(result('r1'))
    await vi.waitFor(() => expect(k.sessions.isRunning(chat.id)).toBe(false))
    await k.lead.syncLead(r.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)!.path).toBe(ws.path)
    turn.feed(tasks())
    await vi.waitFor(() => expect(k.sessions.hasTasks(chat.id)).toBe(false))

    // The workspace's shell runs a command.
    const shell = `shell:${ws.id}`
    let out = ''
    const onPush = (e: PushEvent) => { if (e.type === 'terminal.data' && e.chatId === shell) out += e.data }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    await k.handlers()['terminal.write']({ chatId: shell, data: 'sleep 30\r' })
    await vi.waitFor(() => expect(k.ptys.busy(shell)).toBe(true), { timeout: 10_000 })
    await k.lead.syncLead(r.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)!.path).toBe(ws.path)
    await k.handlers()['terminal.write']({ chatId: shell, data: '\x03' })
    await vi.waitFor(() => expect(k.ptys.busy(shell)).toBe(false), { timeout: 10_000 })

    await k.lead.syncLead(r.id, { workspaceId: ws.id })
    const moved = join(root, 'rowan-watch-the-build')
    expect(k.store.workspace(ws.id)!.path).toBe(moved)
    expect(k.store.workspace(ws.id)!.naming).toBeUndefined()
    const real = await realpath(moved)
    out = ''
    await k.handlers()['terminal.write']({ chatId: shell, data: 'pwd -P\r' })
    await vi.waitFor(() => expect(out).toContain(real), { timeout: 10_000 })
  })

  it('forks a moved chat from its transcript in the old folder', async () => {
    const { k, room: r, root } = await room()
    const { chat, ws } = await idleChat(k, r.id)
    k.store.saveChat({ ...k.store.chat(chat.id)!, sessionId: 'S3' })
    titled(k, chat, 'Plan the fork')
    await vi.waitFor(() => expect(k.store.workspace(ws.id)!.path).toBe(join(root, 'rowan-plan-the-fork')))
    // The SDK looks for the transcript in the new folder's project, which has none, then in every project.
    const asked: (string | undefined)[] = []
    k.forkSession = async (id, o) => {
      asked.push(o?.dir)
      if (o?.dir) throw new Error(`Session ${id} not found in project directory for ${o.dir}`)
      return { sessionId: 'F3' }
    }
    const fork = await k.handlers()['chats.fork']({ chatId: chat.id })
    expect(fork.sessionId).toBe('F3')
    expect(asked).toEqual([join(root, 'rowan-plan-the-fork'), undefined])
  })
})

describe('a Codex chat whose worktree moved (KERNEL-424)', () => {
  let open: Sessions | undefined
  afterEach(() => { open?.stopAll(); open = undefined })

  it('resumes its thread from the new folder', async () => {
    const fake = await fakeCodex()
    const repo = await tempRepo()
    const root = await mkdtemp(join(tmpdir(), 'kernel-wt-'))
    const path = await createWorktree({ repo, root, branch: 'rowan/chat', baseRef: 'main' })
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-codex-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', roomId: 'room', name: 'chat', branch: 'rowan/chat', baseRef: 'main', path, mode: 'worktree', agentId: 'rowan', lead: true, threadId: 't', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Plan', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'medium', plan: false, threadId: 't', createdAt: 1 })
    const settings = { permissions: { mode: 'acceptEdits', network: true, alwaysAsk: [], neverAllow: [], protectedBranches: ['main'], approvalTimeoutSec: 300 }, providers: { codex: { path: fake.bin, useSystem: false, personality: 'pragmatic' } } } as unknown as AppSettings
    const rowan = { id: 'rowan', name: 'Rowan', lead: true, prompt: 'You are Rowan.' } as AgentDef
    const sessions = open = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => rowan, mcpFor: () => undefined, envFor: () => fake.env,
      roomAllow: () => [], allowInRoom: () => undefined, codexFor: () => ({ bin: fake.bin, personality: 'pragmatic', tools: [] })
    })
    const sent = async (method: string) => (await fake.messages()).filter((m) => m.method === method)
    await sessions.send('chat', [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(store.chat('chat')?.sessionId).toBe('thread-1'))
    await vi.waitFor(() => expect(sessions.isRunning('chat')).toBe(false))
    expect((await sent('thread/start'))[0].params.cwd).toBe(path)

    // What Lead.moveNow does: git moves the folder, the record follows, and the idle process ends.
    const to = join(root, 'rowan-plan')
    await moveWorktree(repo, path, to)
    store.saveWorkspace({ ...ws, path: to })
    sessions.restartIdle(['ws'])
    await sessions.send('chat', [{ type: 'text', text: 'again' }])
    await vi.waitFor(async () => expect(await sent('thread/resume')).toHaveLength(1))
    expect((await sent('thread/resume'))[0].params).toMatchObject({ threadId: 'thread-1', cwd: to })
    // Each process started in the folder as it was then. git and the process see the real path (/private/var on macOS).
    const real = await realpath(root)
    expect((await fake.messages()).filter((m) => 'started' in m).map((m) => m.cwd)).toEqual([join(real, 'rowan-chat'), join(real, 'rowan-plan')])
  })
})
