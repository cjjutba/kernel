import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { git, run } from '../src/main/services/exec'
import { agentPrompt } from '../src/main/services/sessions'
import { slugify } from '../src/main/services/worktrees'
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
