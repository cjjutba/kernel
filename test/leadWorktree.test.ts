import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { git, run } from '../src/main/services/exec'
import { agentPrompt } from '../src/main/services/sessions'
import { slugify } from '../src/main/services/worktrees'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { setUp, tempRepo, trustRoom } from './helpers'

// KERNEL-405: each chat with Rowan is its own workspace, with its own worktree, branch, ports and setup. It replaces KERNEL-355's
// one Lead worktree per room, and KERNEL-181's sync now runs per chat.

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

const REPO = {
  'README.md': '# client\n',
  '.gitignore': '.env.local\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

async function dirs(workspace: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', ...workspace } }))
  return { dataDir, home }
}

/** A started Kernel on `where`, stopped when the test ends. Sends are real, into the mocked SDK, which records each session. */
async function boot(where: { dataDir: string; home: string }) {
  const k = new Kernel(where)
  k.signedInReader = async () => true
  await k.start()
  // The mocked sessions never end a turn, so the quit doesn't wait for them.
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  return k
}

const sha = async (repo: string, ref: string) => (await git(repo, 'rev-parse', ref)).trim()
const branchOf = async (path: string) => (await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
const queuedText = (k: Kernel, chatId: string) => k.sessions.queued(chatId).map((q) => q.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
const callIn = (path: string) => sdk.calls.filter((c) => c.options.cwd === path)

/** A repo with an `origin`, as most rooms have. */
async function withOrigin(files: Record<string, string> = {}) {
  const repo = await tempRepo({ ...REPO, ...files })
  const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', bare])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
  await run('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main'])
  return { repo, bare }
}

/** Someone else pushes a commit to `branch` on the remote, which the room hasn't fetched. Its sha. */
async function pushElsewhere(bare: string, file: string, branch = 'main') {
  const other = await mkdtemp(join(tmpdir(), 'kernel-clone-'))
  await run('git', ['clone', '-q', bare, other])
  const has = (await run('git', ['-C', other, 'rev-parse', '--verify', '--quiet', `origin/${branch}`]).then(() => true, () => false))
  await run('git', ['-C', other, 'checkout', '-q', '-B', branch, has ? `origin/${branch}` : 'origin/main'])
  await writeFile(join(other, `${file}.txt`), `${file}\n`)
  await run('git', ['-C', other, 'add', '-A'])
  await run('git', ['-C', other, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', file])
  await run('git', ['-C', other, 'push', '-q', 'origin', branch])
  return sha(other, 'HEAD')
}

describe('a workspace per chat with Rowan (KERNEL-405)', () => {
  it('fetches, then makes a worktree on rowan/<slug> from the latest origin/main, and holds the first message until setup passes', async () => {
    const { repo, bare } = await withOrigin()
    const where = await dirs()
    const k = await boot(where)
    const room = await k.addRoom(repo)
    // Merged on GitHub and not fetched yet: ⌘N fetches first.
    const merged = await pushElsewhere(bare, 'merged')
    await writeFile(join(repo, 'notes.txt'), 'mine\n')
    sdk.calls.length = 0
    const chat = await k.handlers()['lead.start']({ roomId: room.id, prompt: 'Plan wave 3 of the invoices work' })
    const ws = k.store.workspace(chat.workspaceId)!
    expect(ws).toMatchObject({ lead: true, threadId: chat.threadId, agentId: 'rowan', mode: 'worktree', branch: 'rowan/plan-wave-3-of-invoices', baseRef: 'origin/main', status: 'setup' })
    expect(ws.path).toBe(join(where.home, 'wt', slugify(room.name), 'rowan-plan-wave-3-of-invoices'))
    expect(await sha(ws.path, 'HEAD')).toBe(merged)
    expect(await branchOf(ws.path)).toBe(ws.branch)
    // The first message waits in the chat's queue, and nothing starts before setup passes.
    expect(queuedText(k, chat.id)).toEqual(['Plan wave 3 of the invoices work'])
    expect(k.sessions.queueReason(chat.id)).toBe('setup')
    expect(callIn(ws.path)).toHaveLength(0)
    await setUp(k, chat.id)
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
    expect(k.sessions.queued(chat.id)).toEqual([])
    // The main checkout is left alone: same branch, same commit, its own files.
    expect(await branchOf(repo)).toBe('main')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(existsSync(join(ws.path, 'notes.txt'))).toBe(false)
  })

  it('gives two chats two worktrees, two branches and two port blocks, and a + tab joins its own chat', async () => {
    const { repo } = await withOrigin()
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const a = await k.handlers()['lead.start']({ roomId: room.id, prompt: 'Plan the release' })
    const b = await k.handlers()['lead.start']({ roomId: room.id, prompt: 'Plan the release' })
    const [wa, wb] = [await setUp(k, a.id), await setUp(k, b.id)]
    expect(wa.id).not.toBe(wb.id)
    expect([wa.branch, wb.branch]).toEqual(['rowan/plan-release', 'rowan/plan-release-2'])
    expect(wa.path).not.toBe(wb.path)
    expect(Math.abs(wa.port - wb.port)).toBeGreaterThanOrEqual(10)
    expect(k.env.envFor(wb)).toMatchObject({ KERNEL_PORT: String(wb.port), KERNEL_WORKSPACE: wb.path, KERNEL_BRANCH: 'rowan/plan-release-2', KERNEL_BASE_REF: 'origin/main', KERNEL_DEFAULT_BRANCH: 'main' })
    const tab = await k.handlers()['chats.create']({ workspaceId: wb.id })
    expect(tab).toMatchObject({ workspaceId: wb.id, threadId: b.threadId, title: 'New tab' })
    expect(k.chatTabs(wa.id).map((c) => c.id)).toEqual([a.id])
    expect((await k.handlers()['lead.open']({ roomId: room.id }))?.id).toBe(wb.id)
  })

  it('starts from the target branch picked in New chat, after a fetch', async () => {
    const { repo, bare } = await withOrigin()
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const release = await pushElsewhere(bare, 'release-fix', 'release/v2')
    const chat = await k.handlers()['lead.start']({ roomId: room.id, prompt: 'Check the release', baseRef: 'origin/release/v2' })
    const ws = await setUp(k, chat.id)
    expect(ws).toMatchObject({ baseRef: 'origin/release/v2', branch: 'rowan/check-release' })
    expect(await sha(ws.path, 'HEAD')).toBe(release)
  })

  it('copies files and runs setup like a teammate, holds the message through a failed setup, and Run again sends it', async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt && echo set up"\n' })
    await writeFile(join(repo, '.env.local'), 'SECRET=1\n')
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    await trustRoom(k, room.id)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Plan it' })
    const ws = await setUp(k, chat.id, 'failed')
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    // A second tab of a chat whose setup failed waits with it.
    const tab = await k.handlers()['chats.create']({ workspaceId: ws.id })
    await k.sessions.send(tab.id, [{ type: 'text', text: 'And this' }])
    expect(queuedText(k, tab.id)).toEqual(['And this'])
    expect(callIn(ws.path)).toHaveLength(0)
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    expect((await k.setup.retrySetup(ws.id)).status).toBe('ready')
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(2))
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(k.sessions.queued(tab.id)).toEqual([])
  })

  it("waits for the room's scripts to be trusted, then sets up and sends", async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.toml': '[scripts]\nsetup = "echo set up"\n' })
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Plan it' })
    const ws = await setUp(k, chat.id, 'trust')
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    await trustRoom(k, room.id)
    await setUp(k, ws.id)
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
  })

  it('sends the first message at once while setup runs when Wait for setup is off, for the room too', async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.local.toml': '[workspace]\nlead_wait_for_setup = false\n' })
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Plan it' })
    expect(k.store.workspace(chat.workspaceId)!.status).toBe('setup')
    await vi.waitFor(() => expect(callIn(k.store.workspace(chat.workspaceId)!.path)).toHaveLength(1))
    await setUp(k, chat.id)
  })

  it("names the branch from the chat's title until it is pushed, and keeps the name once it is", async () => {
    const { repo } = await withOrigin()
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Hello' })
    const ws = await setUp(k, chat.id)
    expect(ws.branch).toBe('rowan/hello')
    // Claude Code titles the chat (D-089), and the chat takes its first tab's name.
    k.lead.tabNamed(k.store.saveChat({ ...k.store.chat(chat.id)!, title: 'Plan wave 3' }))
    await vi.waitFor(() => expect(k.store.workspace(ws.id)).toMatchObject({ branch: 'rowan/plan-wave-3', name: 'plan-wave-3' }))
    expect(await branchOf(ws.path)).toBe('rowan/plan-wave-3')
    expect(await git(repo, 'branch', '--list', 'rowan/hello')).toBe('')
    expect(k.store.thread(chat.threadId!)!.title).toBe('Plan wave 3')
    // Pushed, it keeps its name.
    await run('git', ['-C', ws.path, 'push', '-q', '-u', 'origin', 'rowan/plan-wave-3'])
    await k.lead.renameChatBranch(ws.id, 'Something else')
    expect(k.store.workspace(ws.id)!.branch).toBe('rowan/plan-wave-3')
    // So does one with a PR, pushed or not.
    const other = await setUp(k, (await k.lead.startLeadChat(room.id, { prompt: 'Other' })).id)
    k.store.saveWorkspace({ ...other, prNumber: 9, prState: 'open' })
    await k.lead.renameChatBranch(other.id, 'Renamed')
    expect(k.store.workspace(other.id)!.branch).toBe('rowan/other')
  })

  it('follows its own branch pattern, from Settings or the room', async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.local.toml': '[workspace]\nlead_branch_pattern = "plans/{lead}-{slug}"\n' })
    const k = await boot(await dirs({ leadBranchPattern: 'lead/{slug}' }))
    const room = await k.addRoom(repo)
    const ws = await setUp(k, (await k.lead.startLeadChat(room.id, { prompt: 'Release notes' })).id)
    expect(ws.branch).toBe('plans/rowan-release-notes')
  })

  it('keeps Rowan on the checkout in a repo with no commit yet, with no setup', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-'))
    await run('git', ['init', '-q', '-b', 'main', repo])
    for (const [f, c] of Object.entries(REPO)) { await mkdir(join(repo, f, '..'), { recursive: true }); await writeFile(join(repo, f), c) }
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Plan it' })
    expect(k.store.workspace(chat.workspaceId)).toMatchObject({ mode: 'current', path: repo, lead: true, status: 'ready' })
    await vi.waitFor(() => expect(callIn(repo)).toHaveLength(1))
  })

  it("runs Rowan in its worktree with the checkout's project config, and tells it its branch and that the checkout isn't its", async () => {
    const repo = await tempRepo(REPO)
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Plan the PDF export' })
    const ws = await setUp(k, chat.id)
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
    const options = callIn(ws.path)[0].options
    expect(options).toMatchObject({ cwd: ws.path, projectConfigRoot: repo })
    expect(options.systemPrompt.append).toContain(`You are working in a git worktree at ${ws.path} on branch ${ws.branch}, created from main. It is not the main checkout, which the user may be running.`)
    const kai = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    await vi.waitFor(() => expect(callIn(kai.path)).toHaveLength(1))
    expect(callIn(kai.path)[0].options).not.toHaveProperty('projectConfigRoot')
    expect(agentPrompt(undefined, kai)).not.toContain('It is not the main checkout')
  })

  it("reads the room's env files from the chat's own worktree, where files.copy put them", async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.toml': '[env]\nfiles = [".env.local"]\n' })
    await writeFile(join(repo, '.env.local'), 'FROM_COPY=1\n')
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    await trustRoom(k, room.id)
    const ws = await setUp(k, (await k.lead.leadChat(room.id)).id)
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('FROM_COPY=1\n')
    expect(k.env.envFor(ws)).toMatchObject({ FROM_COPY: '1', KERNEL_WORKSPACE: ws.path, KERNEL_ROOT_PATH: repo })
  })

  it('refuses Fork into new workspace for a chat with Rowan, and lets Create PR run on its branch', async () => {
    const repo = await tempRepo(REPO)
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const chat = await k.lead.leadChat(room.id)
    await setUp(k, chat.id)
    await expect(k.workspaces.forkWorkspace(chat.id)).rejects.toThrow("A chat with the Lead can't fork")
    expect(k.team.isLeadWorkspace(k.store.workspace(chat.workspaceId)!)).toBe(true)
  })
})

/**
 * The shared Lead workspace from before KERNEL-405, as a database from 0.2.0 holds it: open chats with tabs, one of them closed,
 * one closed chat, a session on each tab. `mode` puts it on the checkout, as CJ's is, or in `<root>/<room>/lead`.
 */
async function legacy(mode: 'current' | 'worktree') {
  const { repo } = await withOrigin()
  const where = await dirs()
  const k = await boot(where)
  const room = await k.addRoom(repo)
  await k.stop()
  const store = new Store(join(where.dataDir, 'kernel.db'))
  const root = join(where.home, 'wt', slugify(room.name))
  let path = repo
  if (mode === 'worktree') {
    path = join(root, 'lead')
    await mkdir(root, { recursive: true })
    await run('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', path, 'origin/main'])
  }
  const old: Workspace = { id: 'old-lead', roomId: room.id, name: 'lead', branch: mode === 'current' ? 'main' : 'HEAD', baseRef: mode === 'current' ? 'main' : 'origin/main', path, mode, agentId: 'rowan', lead: true, port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  store.saveWorkspace(old)
  const t = (id: string, title: string, at: number, closedAt?: number) => store.saveThread({ id, roomId: room.id, title, createdAt: at, ...(closedAt ? { closedAt } : {}) })
  t('plan', 'Plan wave 3', 1)
  t('icons', 'Chat icons sizing', 2)
  t('done', 'Old question', 3, 5)
  const tab = (id: string, threadId: string, o: Partial<Chat> = {}) => store.saveChat({ id, workspaceId: old.id, title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, threadId, sessionId: `session-${id}`, createdAt: 1, ...o })
  tab('plan-1', 'plan')
  tab('plan-2', 'plan', { closed: true })
  tab('plan-3', 'plan')
  tab('icons-1', 'icons')
  tab('done-1', 'done', { closed: true })
  store.saveChat({ id: 'term', workspaceId: old.id, title: 'Claude', kind: 'terminal', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 })
  // A message that waited in a tab when Kernel quit.
  store.saveMeta('queues', { 'plan-1': [{ id: 'q1', chatId: 'plan-1', parts: [{ type: 'text', text: 'Carry on' }], ts: 1 }] })
  store.saveMeta('leadChatsMoved', false)
  store.db.close()
  // The user's own setup, which needs no trusting, and takes long enough to see the chats held while it runs.
  await mkdir(join(repo, '.kernel'), { recursive: true })
  await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[scripts]\nsetup = "sleep 1"\n')
  await mkdir(join(path, '.kernel', 'plans'), { recursive: true })
  await writeFile(join(path, '.kernel', 'plans', 'wave-3.md'), '# Wave 3\n')
  await writeFile(join(repo, 'untracked.txt'), 'the user is working here\n')
  return { repo, where, room, old, path }
}

describe('moving the open chats out of the shared Lead workspace at startup (KERNEL-405)', () => {
  for (const mode of ['current', 'worktree'] as const) {
    it(`gives each open chat its own worktree with its tabs and sessions, and archives the old record (${mode})`, async () => {
      const { repo, where, room, old, path } = await legacy(mode)
      const headBefore = await sha(repo, 'HEAD')
      const k = await boot(where)
      const moved = k.lead.chatWorkspaces(room.id)
      expect(moved.map((w) => [w.threadId, w.branch, w.mode, w.lead])).toEqual([['plan', 'rowan/plan-wave-3', 'worktree', true], ['icons', 'rowan/chat-icons-sizing', 'worktree', true]])
      // Every tab of each open chat moves with it, a closed one too, and keeps its session (KERNEL-348).
      const plan = moved[0]
      expect(k.store.chats(plan.id).map((c) => [c.id, c.sessionId, !!c.closed])).toEqual([['plan-1', 'session-plan-1', false], ['plan-2', 'session-plan-2', true], ['plan-3', 'session-plan-3', false]])
      expect(k.store.chats(moved[1].id).map((c) => c.id)).toEqual(['icons-1'])
      // The closed chat stays with the old record, which is archived, and the old record's terminal closes.
      expect(k.store.chats(old.id).map((c) => [c.id, !!c.closed])).toEqual([['done-1', true], ['term', true]])
      expect(k.store.workspace(old.id)).toMatchObject({ status: 'archived' })
      expect(k.store.thread('done')!.closedAt).toBe(5)
      // The plans its chats wrote come along.
      expect(await readFile(join(plan.path, '.kernel', 'plans', 'wave-3.md'), 'utf8')).toBe('# Wave 3\n')
      // Setup runs with the chats held, and they carry on once it passes. A quit didn't cut this setup short, so it isn't failed.
      expect(moved.map((w) => w.status)).toEqual(['setup', 'setup'])
      expect(k.sessions.isHeld('plan-1')).toBe(true)
      expect(k.sessions.isHeld('plan-3')).toBe(true)
      expect(queuedText(k, 'plan-1')).toEqual(['Carry on'])
      sdk.calls.length = 0
      for (const w of moved) await setUp(k, w.id)
      expect(k.sessions.isHeld('plan-1')).toBe(false)
      // What waited goes once setup passed, in the new folder, resuming the chat's session.
      await vi.waitFor(() => expect(callIn(plan.path).map((c) => c.options.resume)).toEqual(['session-plan-1']))
      expect(k.store.thread('plan')!.closedAt).toBeUndefined()
      // The checkout is untouched, and on the checkout nothing was removed. A worktree goes.
      expect(await sha(repo, 'HEAD')).toBe(headBefore)
      expect(await branchOf(repo)).toBe('main')
      expect(await readFile(join(repo, 'untracked.txt'), 'utf8')).toBe('the user is working here\n')
      if (mode === 'current') expect(existsSync(join(repo, '.kernel', 'plans', 'wave-3.md'))).toBe(true)
      else {
        await k.archive.trashEmptied()
        expect(existsSync(path)).toBe(false)
        expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(`${path}\n`)
      }
      expect(k.store.meta('leadChatsMoved')).toBe(true)
      // The old record can't be deleted from History, and lead.open finds the newest chat.
      expect((await k.history.deletePreview([old.id])).skipped).toEqual([{ id: old.id, name: 'lead', reason: "It is the Lead's workspace." }])
      expect((await k.handlers()['lead.open']({ roomId: room.id }))?.id).toBe(moved[1].id)
      await k.stop()

      // A second start moves nothing.
      const again = await boot(where)
      expect(again.store.workspaces(room.id).filter((w) => w.lead).map((w) => w.id).sort()).toEqual([old.id, ...moved.map((w) => w.id)].sort())
    })
  }
})

// KERNEL-181: each chat's worktree follows the latest main, on its own.

/** Commits on main in `repo` and pushes, so origin/main moves there without a fetch. */
async function landOnMain(repo: string, file: string, n = 1) {
  for (let i = 0; i < n; i++) {
    await writeFile(join(repo, `${file}-${i}.txt`), `${file} ${i}\n`)
    await run('git', ['-C', repo, 'add', '-A'])
    await run('git', ['-C', repo, 'commit', '-q', '-m', `${file} ${i}`])
  }
  await run('git', ['-C', repo, 'push', '-q', 'origin', 'main'])
}

/** A room with an origin and two chats with Rowan, set up and idle. Sends are recorded, not run. */
async function syncedRoom() {
  const { repo, bare } = await withOrigin()
  const k = await boot(await dirs())
  k.sessions.send = async () => ({ queued: false })
  const room = await k.rooms.addRoom(repo)
  const a = await k.lead.newLeadChat(room.id, { prompt: '' })
  const b = await k.lead.newLeadChat(room.id, { prompt: '' })
  const [wa, wb] = [await setUp(k, a.id), await setUp(k, b.id)]
  return { k, repo, bare, room, a, b, wa, wb }
}

const syncNotes = (k: Kernel, roomId: string) => k.store.activity(roomId, 500).filter((x) => x.actor === 'kernel' && /^(updated|didn't update) Rowan's worktree/.test(x.text)).reverse()

describe("keeping each chat's worktree on the latest main (KERNEL-181, KERNEL-405)", () => {
  it('fast-forwards each idle chat on its own branch, logs one line each, and does nothing once it is current', async () => {
    const { k, repo, room, wa, wb } = await syncedRoom()
    await landOnMain(repo, 'merged', 3)
    await k.lead.syncLead(room.id)
    for (const w of [wa, wb]) {
      expect(await sha(w.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
      expect(await branchOf(w.path)).toBe(w.branch)
    }
    await k.lead.syncLead(room.id)
    expect(syncNotes(k, room.id).map((x) => [x.workspaceId, x.text]).sort()).toEqual([wa.id, wb.id].map((id) => [id, "updated Rowan's worktree to origin/main, 3 new commits"]).sort())
  })

  it('moves only the chat that is idle, and a turn that ends syncs only its own chat', async () => {
    const { k, repo, room, a, b, wa, wb } = await syncedRoom()
    const was = await sha(wa.path, 'HEAD')
    await landOnMain(repo, 'while-running')
    const isRunning = k.sessions.isRunning.bind(k.sessions)
    k.sessions.isRunning = (id) => id === a.id || isRunning(id)
    await k.lead.syncLead(room.id)
    expect(await sha(wa.path, 'HEAD')).toBe(was)
    expect(await sha(wb.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
    k.sessions.isRunning = isRunning
    const sync = vi.spyOn(k.lead, 'syncLead')
    ;(k.sessions as unknown as { d: { onTurnDone: (...x: unknown[]) => void } }).d.onTurnDone(wa, a, { ok: true, interrupted: false, by: 'user' })
    expect(sync).toHaveBeenCalledWith(room.id, { workspaceId: wa.id })
    await Promise.all(sync.mock.results.map((r) => r.value))
    expect(await sha(wa.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
    expect(b.id).toBeTruthy()
  })

  it('fetches once when a PR in the room merges, then moves every chat', async () => {
    const { k, bare, room, wa, wb } = await syncedRoom()
    const kai = await k.workspaces.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    const merged = await pushElsewhere(bare, 'merged')
    const sync = vi.spyOn(k.lead, 'syncLead')
    bus.push({ type: 'pr', workspaceId: kai.id, state: 'merged' })
    expect(sync.mock.calls).toEqual([[room.id, { fetch: true }]])
    await Promise.all(sync.mock.results.map((r) => r.value))
    expect(await sha(wa.path, 'HEAD')).toBe(merged)
    expect(await sha(wb.path, 'HEAD')).toBe(merged)
  })

  it('moves nothing when tracked files have changes or the chat has commits of its own, and logs each once per sha', async () => {
    const { k, repo, room, wa, wb } = await syncedRoom()
    const was = await sha(wa.path, 'HEAD')
    await writeFile(join(wa.path, 'README.md'), '# edited by Rowan\n')
    await writeFile(join(wb.path, 'rowan.txt'), 'Rowan committed\n')
    await run('git', ['-C', wb.path, 'add', '-A'])
    await run('git', ['-C', wb.path, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'own'])
    const own = await sha(wb.path, 'HEAD')
    await landOnMain(repo, 'first')
    await k.lead.syncLead(room.id)
    await k.lead.syncLead(room.id)
    expect(await sha(wa.path, 'HEAD')).toBe(was)
    expect(await sha(wb.path, 'HEAD')).toBe(own)
    expect(syncNotes(k, room.id).map((x) => [x.workspaceId, x.object]).sort()).toEqual([[wa.id, 'tracked files have changes'], [wb.id, 'it has a commit of its own']].sort())
    await landOnMain(repo, 'second')
    await k.lead.syncLead(room.id)
    expect(syncNotes(k, room.id)).toHaveLength(4)
  })

  it('leaves a chat that is setting up, or whose setup failed, where it is', async () => {
    const { k, repo, room, wa } = await syncedRoom()
    const was = await sha(wa.path, 'HEAD')
    k.store.saveWorkspace({ ...k.store.workspace(wa.id)!, status: 'failed' })
    await landOnMain(repo, 'merged')
    await k.lead.syncLead(room.id, { workspaceId: wa.id })
    expect(await sha(wa.path, 'HEAD')).toBe(was)
    await rm(join(repo, 'merged-0.txt'))
  })
})
