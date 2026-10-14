import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { git, run } from '../src/main/services/exec'
import { roomWorktreeRoot } from '../src/main/services/worktrees'
import { setUp, tempRepo, trustRoom } from './helpers'

// KERNEL-542: lead.start answers once the chat, its tab and its workspace are saved. The fetch, the worktree and setup run
// after, and the first message waits in the tab's queue until the worktree exists.

const sdk = vi.hoisted(() => ({ calls: [] as { options: any }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: unknown }) => {
    sdk.calls.push({ options })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 0 })
    }
  }
}))

/** Every `git fetch` counts, and waits while `gate` is set, as one on a slow network does. */
const fetches = vi.hoisted(() => ({ count: 0, gate: undefined as Promise<void> | undefined }))
vi.mock('../src/main/services/exec', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/services/exec')>()
  return {
    ...real,
    exec: async (cmd: string, args: string[], opts?: Parameters<typeof real.exec>[2]) => {
      if (args.includes('fetch')) { fetches.count++; await fetches.gate }
      return real.exec(cmd, args, opts)
    }
  }
})

/** Holds every fetch until the returned `open` is called. Opened when the test ends, so nothing waits past it. */
function slowNetwork() {
  let open!: () => void
  fetches.gate = new Promise((r) => { open = () => { fetches.gate = undefined; r() } })
  onTestFinished(() => open())
  return open
}

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.'
}

/** A repo with an `origin`, as most rooms have. */
async function withOrigin(files: Record<string, string> = {}) {
  const repo = await tempRepo({ ...REPO, ...files })
  const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', bare])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
  await run('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main'])
  return repo
}

async function dirs(workspace: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace }))
  return { dataDir, home }
}

/** A started Kernel on `where`, stopped when the test ends. */
async function boot(where: { dataDir: string; home: string }) {
  const k = new Kernel(where)
  k.signedInReader = async () => true
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  return k
}

/** A started Kernel on a trusted room made from `files`, with `origin`, and `workspace` in its settings. */
async function room(files: Record<string, string> = {}, workspace: Record<string, unknown> = {}) {
  const where = await dirs(workspace)
  const k = await boot(where)
  const r = await k.addRoom(await withOrigin(files))
  await trustRoom(k, r.id)
  sdk.calls.length = 0
  return { k, room: r, where }
}

const queuedText = (k: Kernel, chatId: string) => k.sessions.queued(chatId).map((q) => q.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
const callIn = (path: string) => sdk.calls.filter((c) => c.options.cwd === path)
const wsOf = (k: Kernel, chat: Chat) => k.store.workspace(chat.workspaceId)!

describe('lead.start answers before the worktree exists (KERNEL-542)', () => {
  it('answers while the fetch is still held in a real room, with the branch and folder picked and the message held', async () => {
    const { k, room: r, where } = await room()
    const open = slowNetwork()
    const chat = await k.handlers()['lead.start']({ roomId: r.id, prompt: 'Plan the PDF export' })
    const ws = wsOf(k, chat)
    expect(ws).toMatchObject({ lead: true, status: 'setup', worktreePending: {}, branch: 'kernel/plan-pdf-export', baseRef: 'origin/main' })
    expect(ws.path).toBe(join(roomWorktreeRoot(join(where.home, 'wt'), r), 'kernel-plan-pdf-export'))
    expect(existsSync(ws.path)).toBe(false)
    expect(queuedText(k, chat.id)).toEqual(['Plan the PDF export'])
    expect(k.sessions.queueReason(chat.id)).toBe('setup')
    open()
    await k.workspaces.worktreeMade(ws.id)
    expect(wsOf(k, chat).worktreePending).toBeUndefined()
    expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('kernel/plan-pdf-export')
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
    expect(k.sessions.queued(chat.id)).toEqual([])
  })

  it('sends the held message once the worktree exists, while setup runs, with Wait for setup off', async () => {
    const { k, room: r } = await room({ '.kernel/settings.toml': '[scripts]\nsetup = "sleep 1 && echo set up"\n' })
    const open = slowNetwork()
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    await new Promise((res) => setTimeout(res, 50))
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    open()
    await vi.waitFor(() => expect(callIn(wsOf(k, chat).path)).toHaveLength(1))
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(wsOf(k, chat).status).toBe('setup')
    expect((await setUp(k, chat.id)).setupRun).toMatchObject({ end: 0 })
  })

  it('keeps the message held through setup once the worktree exists, with Wait for setup on', async () => {
    const { k, room: r } = await room({ '.kernel/settings.toml': '[scripts]\nsetup = "sleep 1 && echo set up"\n' }, { leadWaitForSetup: true })
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    await k.workspaces.worktreeMade(chat.workspaceId)
    const ws = wsOf(k, chat)
    expect(ws.worktreePending).toBeUndefined()
    expect(existsSync(ws.path)).toBe(true)
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    expect(k.sessions.queueReason(chat.id)).toBe('setup')
    await setUp(k, chat.id)
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
    expect(k.sessions.queued(chat.id)).toEqual([])
  })

  it('reuses the fetch New chat started when it opened', async () => {
    const { k, room: r } = await room()
    const before = fetches.count
    expect(await k.handlers()['lead.prefetch']({ roomId: r.id })).toEqual({ ok: true })
    await vi.waitFor(() => expect(fetches.count - before).toBe(1))
    const chat = await k.handlers()['lead.start']({ roomId: r.id, prompt: 'Plan it' })
    await k.workspaces.worktreeMade(chat.workspaceId)
    expect(wsOf(k, chat).worktreePending).toBeUndefined()
    expect(fetches.count - before).toBe(1)
    // A room with no remote, or no room at all, fetches nothing and says nothing.
    await expect(k.handlers()['lead.prefetch']({ roomId: 'gone' })).resolves.toEqual({ ok: true })
  })

  it('gives two chats started together two branches and two folders before git makes either', async () => {
    const { k, room: r } = await room()
    const open = slowNetwork()
    const [a, b] = await Promise.all([k.lead.startLeadChat(r.id, { prompt: 'Plan the release' }), k.lead.startLeadChat(r.id, { prompt: 'Plan the release' })])
    expect([wsOf(k, a).branch, wsOf(k, b).branch].sort()).toEqual(['kernel/plan-release', 'kernel/plan-release-2'])
    expect(wsOf(k, a).path).not.toBe(wsOf(k, b).path)
    open()
    const [wa, wb] = [await setUp(k, a.id), await setUp(k, b.id)]
    expect((await git(wa.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(wa.branch)
    expect((await git(wb.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(wb.branch)
  })

  it('reads nothing from the folder and logs nothing while the worktree is being made', async () => {
    const { k, room: r } = await room()
    const open = slowNetwork()
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const chat = await k.handlers()['lead.start']({ roomId: r.id, prompt: 'Plan it' })
    const ws = wsOf(k, chat)
    const h = k.handlers()
    const id = { workspaceId: ws.id }
    // The right panel and the header.
    expect(await h['workspaces.changes'](id)).toEqual([])
    expect(await h['workspaces.changes']({ ...id, target: { kind: 'uncommitted' } })).toEqual([])
    expect(await h['workspaces.diff'](id)).toBe('')
    expect(await h['workspaces.commits'](id)).toEqual([])
    expect(await h['workspaces.tree'](id)).toEqual([])
    expect(await h['workspaces.files']({ ...id, query: 'read' })).toEqual([])
    expect(await h['workspaces.hunks'](id)).toEqual([])
    expect(await h['workspaces.readImage']({ ...id, path: 'a.png', at: 'worktree' })).toBeNull()
    expect(await h['checkpoints.list'](id)).toEqual([])
    expect(await h['workspaces.gitStatus'](id)).toEqual({ branch: ws.branch, ahead: 0, behind: 0, dirty: { files: 0, added: 0, removed: 0 } })
    expect(await h['pr.refresh'](id)).toMatchObject({ prState: 'none', worktreePending: {} })
    expect(await h['pr.get'](id)).toBeNull()
    // The bottom panel's shell waits for the folder.
    await h['terminal.resize']({ chatId: `shell:${ws.id}`, cols: 80, rows: 24 })
    await h['terminal.write']({ chatId: `shell:${ws.id}`, data: 'ls\r' })
    expect(k.ptys.has(`shell:${ws.id}`)).toBe(false)
    // What changes or runs in the folder says why it can't.
    await expect(h['scripts.run']({ ...id, kind: 'run' })).rejects.toThrow("This chat's worktree isn't made yet.")
    await expect(h['workspaces.readFile']({ ...id, path: 'README.md' })).rejects.toThrow("This chat's worktree isn't made yet.")
    await expect(h['workspaces.commit']({ ...id, hunkIds: [] })).rejects.toThrow("This chat's worktree isn't made yet.")
    await expect(h['app.openIn']({ path: ws.path })).rejects.toThrow("This chat's worktree isn't made yet.")
    // Kernel's own reads: the launch check, the sync after a turn and a merge, and the overlap check.
    await k.workspaces.countChanges()
    await k.lead.syncLead(r.id)
    await k.lead.syncLead(r.id, { workspaceId: ws.id })
    await k.overlaps.check(r.id)
    // Kernel's own sends wait with the first message.
    await k.handlers()['rooms.brief']({ roomId: r.id, text: 'And this' })
    expect(queuedText(k, chat.id)).toEqual(['Plan it', 'And this'])
    expect(k.sessions.post(chat.id, [{ type: 'text', text: 'update' }])).toBe(false)
    expect(wsOf(k, chat)).toMatchObject({ path: ws.path, branch: ws.branch, status: 'setup', worktreePending: {} })
    expect(wsOf(k, chat).folderGone).toBeUndefined()
    expect(existsSync(ws.path)).toBe(false)
    expect(sdk.calls).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    open()
    await setUp(k, chat.id)
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
  })

  it('archives a chat whose worktree is being made, and leaves no folder or branch behind', async () => {
    const { k, room: r } = await room()
    const open = slowNetwork()
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    const ws = wsOf(k, chat)
    const archived = k.handlers()['threads.archive']({ threadId: chat.threadId! })
    open()
    await archived
    expect(wsOf(k, chat).status).toBe('archived')
    await k.archive.trashEmptied()
    expect(existsSync(ws.path)).toBe(false)
    expect(await git(r.path, 'branch', '--list', ws.branch)).toBe('')
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(sdk.calls).toEqual([])
  })
})

describe('a worktree git would not make (KERNEL-542)', () => {
  it('fails the workspace with git\'s reason, keeps the message queued, and Run again makes it and sends', async () => {
    const { k, room: r, where } = await room()
    // git can't make a folder in a worktree root it can't write to.
    const root = roomWorktreeRoot(join(where.home, 'wt'), r)
    await mkdir(root, { recursive: true })
    await chmod(root, 0o555)
    onTestFinished(() => chmod(root, 0o755))
    const lines: string[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'script.output' && e.kind === 'setup') lines.push(...e.lines.map((l) => l.line)) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    const failed = await setUp(k, chat.id, 'failed')
    expect(failed.worktreePending?.error).toMatch(/^fatal: /)
    expect(lines).toEqual([`Kernel couldn't make the worktree: ${failed.worktreePending!.error}`])
    expect(existsSync(failed.path)).toBe(false)
    // The branch git made before it gave up is gone again, so Run again can make it.
    expect(await git(r.path, 'branch', '--list', failed.branch)).toBe('')
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    expect(k.sessions.queueReason(chat.id)).toBe('setup')
    // Send anyway has nowhere to send to.
    await k.handlers()['scripts.skipSetup']({ workspaceId: failed.id })
    expect(wsOf(k, chat).status).toBe('failed')
    expect(sdk.calls).toEqual([])

    await chmod(root, 0o755)
    await k.handlers()['scripts.run']({ workspaceId: failed.id, kind: 'setup' })
    const ready = await setUp(k, chat.id)
    expect(ready.worktreePending).toBeUndefined()
    expect((await git(ready.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(ready.branch)
    await vi.waitFor(() => expect(callIn(ready.path)).toHaveLength(1))
    expect(k.sessions.queued(chat.id)).toEqual([])
  })

  it('fails a chat Kernel quit before making its worktree at the next start, and Run again makes it', async () => {
    const where = await dirs()
    const first = new Kernel(where)
    first.signedInReader = async () => true
    await first.start()
    const r = await first.addRoom(await withOrigin())
    const open = slowNetwork()
    const chat = await first.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    await first.stop({ budgetMs: 0 })
    open()

    const k = await boot(where)
    const ws = wsOf(k, chat)
    expect(ws).toMatchObject({ status: 'failed', worktreePending: { error: 'Kernel quit before it made the worktree.' } })
    expect(existsSync(ws.path)).toBe(false)
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    expect(k.sessions.isHeld(chat.id)).toBe(true)
    await k.handlers()['scripts.run']({ workspaceId: ws.id, kind: 'setup' })
    const ready = await setUp(k, chat.id)
    expect(ready.worktreePending).toBeUndefined()
    await vi.waitFor(() => expect(callIn(ready.path)).toHaveLength(1))
  })
})

describe('what New chat still hears about before anything is saved (KERNEL-542)', () => {
  it.each([
    ['a base that is neither here nor on the remote', {}, { baseRef: 'release/v9' }, 'release/v9 is not on origin or in this repo'],
    ['a Lead branch pattern git refuses', { leadBranchPattern: 'bad..{slug}' }, {}, 'is not a valid branch name']
  ] as const)('throws for %s', async (_, workspace, o, message) => {
    const { k, room: r } = await room({}, workspace)
    await expect(k.handlers()['lead.start']({ roomId: r.id, prompt: 'Plan it', ...o })).rejects.toThrow(message)
    expect(k.store.workspaces(r.id)).toEqual([])
    expect(k.store.threads(r.id)).toEqual([])
  })
})
