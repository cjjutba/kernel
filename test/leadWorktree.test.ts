import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { git, run } from '../src/main/services/exec'
import { agentPrompt } from '../src/main/services/sessions'
import { slugify } from '../src/main/services/worktrees'
import { bus } from '../src/main/bus'
import { tempRepo, trustRoom } from './helpers'

// KERNEL-355: each room's Lead works in its own worktree, detached at the latest main, instead of the main checkout.

const sdk = vi.hoisted(() => ({ calls: [] as { options: any }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
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

async function dirs() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  return { dataDir, home }
}

/** A started Kernel on `where`, stopped when the test ends. Sends are recorded, not run, unless `live`. */
async function boot(where: { dataDir: string; home: string }, o: { live?: boolean } = {}) {
  const k = new Kernel(where)
  await k.start()
  onTestFinished(() => k.stop())
  if (!o.live) k.sessions.send = async () => ({ queued: false })
  return k
}

const sha = async (repo: string, ref: string) => (await git(repo, 'rev-parse', ref)).trim()

describe("the Lead's worktree (KERNEL-355)", () => {
  it("makes a new room's Lead a detached worktree under worktreeRoot, at the default branch, with nothing in Changes", async () => {
    const repo = await tempRepo(REPO)
    const where = await dirs()
    const k = await boot(where)
    const room = await k.addRoom(repo)
    // The checkout's own untracked files are not the Lead's.
    await writeFile(join(repo, 'notes.txt'), 'mine\n')
    const ws = k.store.workspace((await k.lead.leadChat(room.id)).workspaceId)!
    expect(ws).toMatchObject({ name: 'lead', mode: 'worktree', lead: true, branch: 'HEAD', baseRef: 'main', path: join(where.home, 'wt', slugify(room.name), 'lead'), status: 'ready' })
    expect(ws.baselineRef).toBeUndefined()
    expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('HEAD')
    expect(await sha(ws.path, 'HEAD')).toBe(await sha(repo, 'main'))
    expect(await k.workspaces.changes(ws.id)).toEqual([])
    // No branch was made for it.
    expect((await git(repo, 'branch', '--format=%(refname:short)')).trim()).toBe('main')
  })

  it('starts from <remote>/<default> as last fetched, not the local branch', async () => {
    const repo = await tempRepo(REPO)
    const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await run('git', ['init', '-q', '--bare', bare])
    await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
    await run('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main'])
    await writeFile(join(repo, 'local.txt'), 'not pushed\n')
    await run('git', ['-C', repo, 'add', '-A'])
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'local only'])
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const ws = k.store.workspace((await k.lead.leadChat(room.id)).workspaceId)!
    expect(ws.baseRef).toBe('origin/main')
    expect(await sha(ws.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
    expect(existsSync(join(ws.path, 'local.txt'))).toBe(false)
  })

  it('makes one worktree when a brief and Ask Rowan arrive together', async () => {
    const repo = await tempRepo(REPO)
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const [brief, ask] = await Promise.all([k.lead.leadChat(room.id), k.lead.askLead(room.id, 'How is it going?'), k.handlers()['lead.open']({ roomId: room.id })])
    expect(k.store.chat(ask.chatId)!.workspaceId).toBe(brief.workspaceId)
    expect(k.store.workspaces(room.id).filter((w) => w.lead)).toHaveLength(1)
    expect((await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(2)
  })

  it('keeps the Lead on the checkout in a repo with no commit yet', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-'))
    await run('git', ['init', '-q', '-b', 'main', repo])
    for (const [f, c] of Object.entries(REPO)) { await mkdir(join(repo, f, '..'), { recursive: true }); await writeFile(join(repo, f), c) }
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const ws = k.store.workspace((await k.lead.leadChat(room.id)).workspaceId)!
    expect(ws).toMatchObject({ mode: 'current', path: repo, lead: true })
  })

  it("moves an existing room's Lead at startup, and a move that fails stays on the checkout and tries again at the next start", async () => {
    const repo = await tempRepo(REPO)
    const where = await dirs()
    let k = await boot(where)
    const room = await k.addRoom(repo)
    const chat = await k.lead.leadChat(room.id)
    const made = k.store.workspace(chat.workspaceId)!
    // As the Lead was before: on the checkout, with a baseline and a checkpoint of it, a plan written there and a chat
    // that has a session.
    await run('git', ['-C', repo, 'worktree', 'remove', '--force', made.path])
    k.store.saveWorkspace({ ...made, mode: 'current', path: repo, branch: 'main', baseRef: 'main', baselineRef: await sha(repo, 'HEAD') })
    k.store.saveChat({ ...chat, sessionId: 'session-before-the-move' })
    await run('git', ['-C', repo, 'update-ref', `refs/kernel/checkpoints/${made.id}/1`, 'HEAD'])
    await mkdir(join(repo, '.kernel', 'plans'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'plans', 'export-pdf.md'), '# Export PDF\n')
    // A file where the room's worktree folder goes makes the move fail.
    const root = join(where.home, 'wt', slugify(room.name))
    await rm(root, { recursive: true, force: true })
    await writeFile(root, 'in the way')
    await k.stop()

    k = await boot(where)
    expect(k.store.workspace(made.id)).toMatchObject({ mode: 'current', path: repo, baselineRef: await sha(repo, 'HEAD') })
    await k.stop()

    await rm(root)
    k = await boot(where)
    const moved = k.store.workspace(made.id)!
    expect(moved).toMatchObject({ mode: 'worktree', path: join(root, 'lead'), branch: 'HEAD', baseRef: 'main', lead: true })
    expect(moved.baselineRef).toBeUndefined()
    expect(k.team.isLeadWorkspace(moved)).toBe(true)
    // The plan is copied, since current-branch teammates write there too.
    expect(await readFile(join(moved.path, '.kernel', 'plans', 'export-pdf.md'), 'utf8')).toBe('# Export PDF\n')
    expect(existsSync(join(repo, '.kernel', 'plans', 'export-pdf.md'))).toBe(true)
    expect((await git(repo, 'for-each-ref', `refs/kernel/checkpoints/${made.id}/`)).trim()).toBe('')
    // The chat resumes by its session id from the worktree (KERNEL-348).
    expect(k.store.chat(chat.id)).toMatchObject({ workspaceId: made.id, sessionId: 'session-before-the-move' })
    expect((await k.lead.leadChat(room.id)).id).toBe(chat.id)
  })

  it("makes the Lead's worktree again where it was when its folder is deleted, on the next call and at startup", async () => {
    const repo = await tempRepo(REPO)
    const where = await dirs()
    let k = await boot(where)
    const room = await k.addRoom(repo)
    const chat = await k.lead.leadChat(room.id)
    const ws = k.store.workspace(chat.workspaceId)!
    // Deleted outside Kernel: git still lists it until a prune.
    await rm(ws.path, { recursive: true, force: true })
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain('prunable')
    expect((await k.lead.leadChat(room.id)).id).toBe(chat.id)
    expect(k.store.workspace(ws.id)).toMatchObject({ mode: 'worktree', path: ws.path, branch: 'HEAD', baseRef: 'main' })
    expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('HEAD')
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable')

    await rm(ws.path, { recursive: true, force: true })
    await k.stop()
    k = await boot(where)
    expect(existsSync(join(ws.path, 'README.md'))).toBe(true)
    expect(k.store.workspace(ws.id)).toMatchObject({ mode: 'worktree', path: ws.path })
    expect((await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(2)
  })

  it("uses lead-2 again after a move cut short there, instead of making lead-3, when another room's folder has lead", async () => {
    const repo = await tempRepo(REPO)
    const where = await dirs()
    let k = await boot(where)
    const room = await k.addRoom(repo)
    // Another room with the same name has the `lead` folder.
    const root = join(where.home, 'wt', slugify(room.name))
    await mkdir(join(root, 'lead'), { recursive: true })
    await writeFile(join(root, 'lead', 'theirs.txt'), 'another room\n')
    const made = k.store.workspace((await k.lead.leadChat(room.id)).workspaceId)!
    expect(made.path).toBe(join(root, 'lead-2'))
    // The move made the worktree and stopped before it saved the record.
    k.store.saveWorkspace({ ...made, mode: 'current', path: repo, branch: 'main', baseRef: 'main' })
    await k.stop()

    k = await boot(where)
    expect(k.store.workspace(made.id)).toMatchObject({ mode: 'worktree', path: join(root, 'lead-2') })
    expect(existsSync(join(root, 'lead-3'))).toBe(false)
    expect(await readFile(join(root, 'lead', 'theirs.txt'), 'utf8')).toBe('another room\n')
    expect((await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(2)
  })

  it('refuses to archive the Lead, and removing the room deletes no branch', async () => {
    const repo = await tempRepo(REPO)
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    const ws = k.store.workspace((await k.lead.leadChat(room.id)).workspaceId)!
    await expect(k.archiveWorkspace(ws.id, true)).rejects.toThrow("The Lead's workspace stays as long as its room")
    expect(k.store.workspace(ws.id)!.status).toBe('ready')
    const branches = await git(repo, 'branch', '--format=%(refname:short)')
    await k.removeRoom(room.id, true)
    expect(k.store.workspace(ws.id)?.status ?? 'archived').toBe('archived')
    expect(existsSync(ws.path)).toBe(false)
    expect(await git(repo, 'branch', '--format=%(refname:short)')).toBe(branches)
  })

  it("reads the room's env files from the checkout, since nothing is copied into the Lead's worktree", async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.toml': '[env]\nfiles = [".env.local"]\n' })
    await writeFile(join(repo, '.env.local'), 'FROM_CHECKOUT=1\n')
    const k = await boot(await dirs())
    const room = await k.addRoom(repo)
    await trustRoom(k, room.id)
    const ws = k.store.workspace((await k.lead.leadChat(room.id)).workspaceId)!
    expect(existsSync(join(ws.path, '.env.local'))).toBe(false)
    expect(k.env.envFor(ws)).toMatchObject({ FROM_CHECKOUT: '1', KERNEL_WORKSPACE: ws.path, KERNEL_ROOT_PATH: repo })
  })

  it("runs Lead sessions in the worktree with the checkout's project config, and tells the Lead where it is", async () => {
    const repo = await tempRepo(REPO)
    const k = await boot(await dirs(), { live: true })
    const room = await k.addRoom(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Plan the PDF export' })
    const ws = k.store.workspace(chat.workspaceId)!
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(1))
    expect(sdk.calls[0].options).toMatchObject({ cwd: ws.path, projectConfigRoot: repo })
    expect(sdk.calls[0].options.systemPrompt.append).toContain(`You are working in your own git worktree at ${ws.path}, detached at main, not on a branch.`)
    expect(sdk.calls[0].options.systemPrompt.append).not.toContain('main checkout at')

    const kai = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(2))
    expect(sdk.calls[1].options.cwd).toBe(kai.path)
    expect(sdk.calls[1].options).not.toHaveProperty('projectConfigRoot')
    expect(agentPrompt(undefined, kai)).toContain(`on branch ${kai.branch}, created from main`)
  })
})

// KERNEL-181: the Lead's worktree follows the latest main.

/** A room whose repo has an `origin`, and its Lead's worktree, made at origin/main. */
async function syncedRoom() {
  const repo = await tempRepo(REPO)
  const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', bare])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
  await run('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main'])
  const k = await boot(await dirs())
  const room = await k.addRoom(repo)
  const chat = await k.lead.leadChat(room.id)
  const ws = k.store.workspace(chat.workspaceId)!
  expect(ws.baseRef).toBe('origin/main')
  return { k, repo, bare, room, chat, ws }
}

/** Commits on main in `repo` and pushes, so origin/main moves there without a fetch. */
async function landOnMain(repo: string, file: string, n = 1) {
  for (let i = 0; i < n; i++) {
    await writeFile(join(repo, `${file}-${i}.txt`), `${file} ${i}\n`)
    await run('git', ['-C', repo, 'add', '-A'])
    await run('git', ['-C', repo, 'commit', '-q', '-m', `${file} ${i}`])
  }
  await run('git', ['-C', repo, 'push', '-q', 'origin', 'main'])
}

/** Someone else pushes a commit to main on the remote, which the room hasn't fetched. Its sha. */
async function pushElsewhere(bare: string, file: string) {
  const other = await mkdtemp(join(tmpdir(), 'kernel-clone-'))
  await run('git', ['clone', '-q', '-b', 'main', bare, other])
  await writeFile(join(other, `${file}.txt`), `${file}\n`)
  await run('git', ['-C', other, 'add', '-A'])
  await run('git', ['-C', other, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', file])
  await run('git', ['-C', other, 'push', '-q', 'origin', 'main'])
  return sha(other, 'HEAD')
}

const syncNotes = (k: Kernel, roomId: string) => k.store.activity(roomId, 500).filter((a) => a.actor === 'kernel' && /^(updated|didn't update) Rowan's worktree/.test(a.text)).reverse()

describe("keeping the Lead's worktree on the latest main (KERNEL-181)", () => {
  it('fast-forwards a worktree that is behind and idle, logs one line, and does nothing once it is current', async () => {
    const { k, repo, room, ws } = await syncedRoom()
    await landOnMain(repo, 'merged', 3)
    await k.lead.syncLead(room.id)
    expect(await sha(ws.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
    expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('HEAD')
    await k.lead.syncLead(room.id)
    expect(syncNotes(k, room.id).map((a) => a.text)).toEqual(["updated Rowan's worktree to origin/main, 3 new commits"])
  })

  it("moves the worktree before a new Lead chat's first turn, without fetching", async () => {
    const { k, repo, bare, room, ws } = await syncedRoom()
    await landOnMain(repo, 'fetched')
    // Pushed by someone else and not fetched yet: a new chat doesn't wait for it.
    const elsewhere = await pushElsewhere(bare, 'elsewhere')
    let atSend = ''
    k.sessions.send = async () => { atSend = await sha(ws.path, 'HEAD'); return { queued: false } }
    await k.lead.startLeadChat(room.id, { prompt: 'What changed?' })
    expect(atSend).toBe(await sha(repo, 'origin/main'))
    expect(atSend).not.toBe(elsewhere)
  })

  it('fetches and moves the worktree when a PR in the room merges', async () => {
    const { k, bare, room, ws } = await syncedRoom()
    const kai = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    const merged = await pushElsewhere(bare, 'merged')
    const sync = vi.spyOn(k.lead, 'syncLead')
    bus.push({ type: 'pr', workspaceId: kai.id, state: 'merged' })
    expect(sync).toHaveBeenCalledWith(room.id, { fetch: true })
    await Promise.all(sync.mock.results.map((r) => r.value))
    expect(await sha(ws.path, 'HEAD')).toBe(merged)
  })

  it('moves nothing while a Lead chat is running or has messages queued, and catches up when the last Lead turn ends', async () => {
    const { k, repo, room, chat, ws } = await syncedRoom()
    const was = await sha(ws.path, 'HEAD')
    await landOnMain(repo, 'while-running')
    const isRunning = k.sessions.isRunning.bind(k.sessions)
    const queued = k.sessions.queued.bind(k.sessions)
    k.sessions.isRunning = (id) => id === chat.id || isRunning(id)
    await k.lead.syncLead(room.id)
    expect(await sha(ws.path, 'HEAD')).toBe(was)
    k.sessions.isRunning = isRunning
    k.sessions.queued = (id) => (id === chat.id ? [{ id: 'q', chatId: id, parts: [{ type: 'text', text: 'next' }], ts: Date.now() }] : queued(id))
    await k.lead.syncLead(room.id)
    expect(await sha(ws.path, 'HEAD')).toBe(was)
    // A turn that starts while the sync's git runs: the check before the fast-forward sees it.
    k.sessions.queued = queued
    let reads = 0
    k.sessions.isRunning = (id) => (id === chat.id ? ++reads > 1 : isRunning(id))
    await k.lead.syncLead(room.id)
    expect(reads).toBe(2)
    expect(await sha(ws.path, 'HEAD')).toBe(was)
    expect(syncNotes(k, room.id)).toEqual([])
    k.sessions.isRunning = isRunning
    // The turn ends: Sessions calls back with the chat idle, and the sync that starts catches up.
    const sync = vi.spyOn(k.lead, 'syncLead')
    ;(k.sessions as unknown as { d: { onTurnDone: (...a: unknown[]) => void } }).d.onTurnDone(ws, chat, { ok: true, interrupted: false, by: 'user' })
    expect(sync).toHaveBeenCalledWith(room.id)
    await Promise.all(sync.mock.results.map((r) => r.value))
    expect(await sha(ws.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
  })

  it('moves nothing when tracked files have changes, and logs that once per origin/main sha', async () => {
    const { k, repo, room, ws } = await syncedRoom()
    const was = await sha(ws.path, 'HEAD')
    await writeFile(join(ws.path, 'README.md'), '# edited by the Lead\n')
    await landOnMain(repo, 'first')
    await k.lead.syncLead(room.id)
    await k.lead.syncLead(room.id)
    expect(await sha(ws.path, 'HEAD')).toBe(was)
    expect(await readFile(join(ws.path, 'README.md'), 'utf8')).toBe('# edited by the Lead\n')
    expect(syncNotes(k, room.id).map((a) => [a.text, a.object])).toEqual([["didn't update Rowan's worktree to origin/main:", 'tracked files have changes']])
    // main moved again, so the same refusal is news.
    await landOnMain(repo, 'second')
    await k.lead.syncLead(room.id)
    await k.lead.syncLead(room.id)
    expect(syncNotes(k, room.id)).toHaveLength(2)
    expect(await sha(ws.path, 'HEAD')).toBe(was)
  })

  it('moves nothing when the worktree has commits of its own, and never merges or rebases', async () => {
    const { k, repo, room, ws } = await syncedRoom()
    await writeFile(join(ws.path, 'lead.txt'), 'the Lead committed\n')
    await run('git', ['-C', ws.path, 'add', '-A'])
    await run('git', ['-C', ws.path, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'own'])
    const own = await sha(ws.path, 'HEAD')
    await landOnMain(repo, 'merged')
    await k.lead.syncLead(room.id)
    await k.lead.syncLead(room.id)
    expect(await sha(ws.path, 'HEAD')).toBe(own)
    expect((await git(ws.path, 'rev-list', '--count', 'HEAD')).trim()).toBe('2')
    expect(syncNotes(k, room.id).map((a) => a.object)).toEqual(['it has a commit of its own'])
  })
})
