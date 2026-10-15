import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { baseMessage, catchUpMessage, listFiles } from '../src/main/features/baseWatch'
import { sessionDeps } from '../src/main/features/sessionDeps'
import { git, run } from '../src/main/services/exec'
import { behindCount, FETCH_REUSE_MS, mergeTreeConflicts, snapshotCommit } from '../src/main/services/worktrees'
import { tempRepo, freePort } from './helpers'

// KERNEL-180: Kernel tells a teammate with no PR when main moves under its branch in a way that would conflict.

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 0 })
  })
}))

const REPO = {
  'README.md': '# client\n',
  'src/a.ts': 'one\ntwo\nthree\n',
  'src/b.ts': 'alpha\nbeta\ngamma\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

async function dirs() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  // No base set, so a workspace starts from origin/main.
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt') }))
  return { dataDir, home }
}

const commit = async (cwd: string, files: Record<string, string>, message = 'change') => {
  for (const [file, text] of Object.entries(files)) await writeFile(join(cwd, file), text)
  await run('git', ['-C', cwd, 'add', '-A'])
  await run('git', ['-C', cwd, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', message])
}

/** Main moves: a commit in the room's checkout, pushed, so `origin/main` is ahead there without a fetch. */
const landOnMain = async (repo: string, files: Record<string, string>) => {
  await commit(repo, files, 'on main')
  await run('git', ['-C', repo, 'push', '-q', 'origin', 'main'])
}

const SAME_LINE = (side: string) => `one\ntwo ${side}\nthree\n`

/** A room with an `origin`, and a Kai workspace started from origin/main. Messages to Kai are recorded, not run. */
async function setUp() {
  const repo = await tempRepo(REPO)
  const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', bare])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
  await run('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main'])
  const k = new Kernel(await dirs())
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const gh = { pr: null as PrInfo | null }
  k.github = { info: async (_cwd, _ref, workspaceId) => (gh.pr ? { ...gh.pr, workspaceId } : null), merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
  const room = await k.addRoom(repo)
  const kai = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
  expect(kai).toMatchObject({ status: 'ready', mode: 'worktree', baseRef: 'origin/main', prState: 'none' })
  const chat = k.store.chats(kai.id)[0]
  const posts: { chatId: string; text: string }[] = []
  const state = { busy: false }
  k.sessions.post = (chatId, parts) => {
    if (state.busy) return false
    posts.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') })
    return true
  }
  await k.baseWatch.check(room.id, { fetch: false })
  const check = (o: { fetch?: boolean; only?: string } = {}) => k.baseWatch.check(room.id, { fetch: o.fetch ?? false, ...(o.only ? { only: o.only } : {}) })
  const notes = () => k.store.activity(room.id, 500).filter((a) => a.actor === 'kernel' && a.text.startsWith('told ')).reverse()
  const saved = () => k.store.meta<Record<string, { sha: string; behind: number; conflicts: string[]; told?: string }>>('baseWatch') ?? {}
  return { k, repo, bare, room, kai, chat, posts, state, check, notes, saved, gh }
}

/** Kai committed a change to src/a.ts, and main changed the same line. */
async function conflictOnMain(s: Awaited<ReturnType<typeof setUp>>) {
  await commit(s.kai.path, { 'src/a.ts': SAME_LINE('kai') }, 'kai')
  await landOnMain(s.repo, { 'src/a.ts': SAME_LINE('main') })
}

const status = async (cwd: string) => (await git(cwd, 'status', '--porcelain')).trim()
const sha = async (cwd: string, ref: string) => (await git(cwd, 'rev-parse', ref)).trim()

describe('the message', () => {
  it('names the files, cuts the list at ten, and tells the teammate what to do', () => {
    expect(listFiles(['a.ts'])).toBe('a.ts')
    expect(listFiles(['a.ts', 'b.ts'])).toBe('a.ts and b.ts')
    expect(listFiles(['a.ts', 'b.ts', 'c.ts'])).toBe('a.ts, b.ts and c.ts')
    const twelve = Array.from({ length: 12 }, (_, i) => `f${i + 1}.ts`)
    expect(listFiles(twelve)).toBe('f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts, f8.ts, f9.ts, f10.ts and 2 more')
    expect(listFiles(twelve.slice(0, 10))).toBe('f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts, f8.ts, f9.ts and f10.ts')
    expect(baseMessage('origin/main', 4, ['src/main/kernel.ts', 'src/shared/types.ts'])).toBe(
      'origin/main moved 4 commits since your branch started, and merging it now would conflict in src/main/kernel.ts and src/shared/types.ts. '
      + 'At a stopping point, commit your work, rebase onto origin/main, resolve the conflicts and re-run the tests. Then carry on with your task.')
    expect(baseMessage('origin/dev', 1, ['a.ts'])).toContain('origin/dev moved 1 commit since')
  })

  it('asks a branch the remote has to merge the base in, since its rebase would need a force push (KERNEL-886)', () => {
    expect(baseMessage('origin/main', 1, ['a.ts'], 'origin')).toBe(
      'origin/main moved 1 commit since your branch started, and merging it now would conflict in a.ts. '
      + 'At a stopping point, commit your work, merge origin/main into your branch, resolve the conflicts and re-run the tests. '
      + 'Your branch is on origin, so merge rather than rebase. Then carry on with your task.')
    expect(catchUpMessage('origin/main', 2, 'origin')).toBe(
      "Kernel couldn't fetch when your workspace started, so your branch began from origin/main as last fetched. The fetch works now, and origin/main has 2 commits your branch doesn't. "
      + 'At a stopping point, commit your work, merge origin/main into your branch and re-run the tests. Your branch is on origin, so merge rather than rebase. Then carry on with your task.')
    expect(catchUpMessage('origin/main', 2)).toContain('commit your work, rebase onto origin/main and re-run the tests. Then carry on')
  })
})

describe('git helpers', () => {
  it('counts the commits the base has that the branch does not', async () => {
    const s = await setUp()
    expect(await behindCount(s.kai.path, 'origin/main')).toBe(0)
    await landOnMain(s.repo, { 'README.md': '# 1\n' })
    await landOnMain(s.repo, { 'README.md': '# 2\n' })
    expect(await behindCount(s.kai.path, 'origin/main')).toBe(2)
    expect(await behindCount(s.kai.path, 'origin/nope')).toBeUndefined()
  })

  it('finds the files a merge would conflict in, and says nothing when git cannot tell', async () => {
    const s = await setUp()
    await conflictOnMain(s)
    expect(await mergeTreeConflicts(s.kai.path, 'HEAD', 'origin/main')).toEqual(['src/a.ts'])
    expect(await mergeTreeConflicts(s.kai.path, 'HEAD', 'HEAD')).toEqual([])
    expect(await mergeTreeConflicts(s.kai.path, 'HEAD', 'origin/nope')).toBeUndefined()
    expect(await mergeTreeConflicts('/nowhere', 'HEAD', 'origin/main')).toBeUndefined()
  })

  it('makes a commit of the uncommitted changes without touching the worktree, the index or the stash list', async () => {
    const s = await setUp()
    expect(await snapshotCommit(s.kai.path)).toBe('HEAD')
    await writeFile(join(s.kai.path, 'src/a.ts'), SAME_LINE('dirty'))
    await run('git', ['-C', s.kai.path, 'add', 'src/a.ts'])
    await writeFile(join(s.kai.path, 'src/b.ts'), 'alpha\nbeta unstaged\ngamma\n')
    await writeFile(join(s.kai.path, 'untracked.txt'), 'new\n')
    const index = (await git(s.kai.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trim()
    const before = { status: await status(s.kai.path), head: await sha(s.kai.path, 'HEAD'), diff: await git(s.kai.path, 'diff', '--cached') }
    // Read after `git status`, which may refresh the index itself, so the snapshot is the only thing between the two reads.
    const file = { bytes: await readFile(index), at: (await stat(index)).mtimeMs }
    const made = await snapshotCommit(s.kai.path)
    expect({ bytes: await readFile(index), at: (await stat(index)).mtimeMs }).toEqual(file)
    expect(made).toMatch(/^[0-9a-f]{40,64}$/)
    expect(made).not.toBe(before.head)
    expect(await git(s.kai.path, 'show', `${made}:src/a.ts`)).toBe(SAME_LINE('dirty'))
    expect(await git(s.kai.path, 'show', `${made}:src/b.ts`)).toBe('alpha\nbeta unstaged\ngamma\n')
    // Tracked changes only, on top of HEAD.
    await expect(git(s.kai.path, 'cat-file', '-e', `${made}:untracked.txt`)).rejects.toThrow()
    expect((await git(s.kai.path, 'rev-parse', `${made}^`)).trim()).toBe(before.head)
    const after = { status: await status(s.kai.path), head: await sha(s.kai.path, 'HEAD'), diff: await git(s.kai.path, 'diff', '--cached') }
    expect(after).toEqual(before)
    expect((await git(s.kai.path, 'stash', 'list')).trim()).toBe('')
  })

  it('never takes the index lock, so a teammate running git at that moment is not turned away', async () => {
    const s = await setUp()
    await writeFile(join(s.kai.path, 'src/a.ts'), SAME_LINE('dirty'))
    const index = (await git(s.kai.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trim()
    // Another git command holds the lock, as `git add` or `git commit` does while it writes.
    await writeFile(`${index}.lock`, '')
    try {
      expect(await snapshotCommit(s.kai.path)).toMatch(/^[0-9a-f]{40,64}$/)
      await s.check()
      expect(await readFile(`${index}.lock`, 'utf8')).toBe('')
    } finally { await run('rm', ['-f', `${index}.lock`]) }
  })

  it('reads the committed work alone when the index has unmerged paths', async () => {
    const s = await setUp()
    await commit(s.kai.path, { 'src/a.ts': SAME_LINE('kai') }, 'kai')
    await landOnMain(s.repo, { 'src/a.ts': SAME_LINE('main') })
    await run('git', ['-C', s.kai.path, 'merge', 'origin/main'], ).catch(() => undefined)
    expect((await git(s.kai.path, 'ls-files', '--unmerged')).trim()).not.toBe('')
    expect(await snapshotCommit(s.kai.path)).toBe('HEAD')
    await run('git', ['-C', s.kai.path, 'merge', '--abort'])
  })
})

describe('telling a teammate that main moved (KERNEL-180)', () => {
  it('says nothing when the branch is behind but a merge would be clean', async () => {
    const s = await setUp()
    await commit(s.kai.path, { 'src/a.ts': SAME_LINE('kai') }, 'kai')
    await landOnMain(s.repo, { 'src/b.ts': 'alpha\nbeta main\ngamma\n' })
    await s.check()
    expect(s.posts).toEqual([])
    expect(s.notes()).toEqual([])
    expect(s.saved()[s.kai.id]).toMatchObject({ behind: 1, conflicts: [] })
  })

  it('sends one Kernel message naming the files and logs one line, and sends nothing for the same base commit again', async () => {
    const s = await setUp()
    await conflictOnMain(s)
    await s.check()
    expect(s.posts).toEqual([{ chatId: s.chat.id, text: baseMessage('origin/main', 1, ['src/a.ts']) }])
    expect(s.posts[0].text).toContain('origin/main moved 1 commit since your branch started, and merging it now would conflict in src/a.ts.')
    expect(s.notes().map((a) => [a.workspaceId, a.agentId, a.object])).toEqual([[s.kai.id, s.kai.agentId, 'src/a.ts']])
    expect(s.notes()[0].text).toMatch(/^told \w+ to rebase, since origin\/main moved 1 commit and would conflict in$/)
    expect(s.saved()[s.kai.id]).toEqual({ sha: await sha(s.repo, 'origin/main'), behind: 1, conflicts: ['src/a.ts'], told: await sha(s.repo, 'origin/main') })
    await s.check()
    await s.check({ only: s.kai.id })
    expect(s.posts).toHaveLength(1)
    expect(s.notes()).toHaveLength(1)
    // Main moves again and the conflict is still there: that is news.
    await landOnMain(s.repo, { 'README.md': '# more\n' })
    await s.check()
    expect(s.posts).toHaveLength(2)
    expect(s.posts[1].text).toContain('origin/main moved 2 commits since')
    expect(s.notes()).toHaveLength(2)
  })

  it('catches a conflict that exists only in uncommitted changes, and leaves status and the stash list alone', async () => {
    const s = await setUp()
    await writeFile(join(s.kai.path, 'src/a.ts'), SAME_LINE('kai, not committed'))
    await landOnMain(s.repo, { 'src/a.ts': SAME_LINE('main') })
    const before = { status: await status(s.kai.path), head: await sha(s.kai.path, 'HEAD'), stash: (await git(s.kai.path, 'stash', 'list')).trim() }
    expect(before.status).toBe('M src/a.ts')
    await s.check()
    expect(s.posts.map((p) => p.text)).toEqual([baseMessage('origin/main', 1, ['src/a.ts'])])
    expect({ status: await status(s.kai.path), head: await sha(s.kai.path, 'HEAD'), stash: (await git(s.kai.path, 'stash', 'list')).trim() }).toEqual(before)
    expect(await git(s.kai.path, 'show', ':src/a.ts')).toBe('one\ntwo\nthree\n')
  })

  it('tells a busy teammate at its next turn end, never mid-turn', async () => {
    const s = await setUp()
    await conflictOnMain(s)
    s.state.busy = true
    await s.check()
    expect(s.posts).toEqual([])
    expect(s.notes()).toEqual([])
    expect(s.saved()[s.kai.id]).toMatchObject({ conflicts: ['src/a.ts'] })
    expect(s.saved()[s.kai.id].told).toBeUndefined()
    // Still busy at the next check, as a long turn is.
    await s.check({ only: s.kai.id })
    expect(s.posts).toEqual([])
    // Its turn ends: the hook checks that workspace, without a fetch.
    s.state.busy = false
    const check = vi.spyOn(s.k.baseWatch, 'check')
    sessionDeps(s.k).onTurnDone!(s.k.store.workspace(s.kai.id)!, s.chat, { ok: true, interrupted: false, by: 'user' })
    expect(check).toHaveBeenCalledWith(s.room.id, { fetch: false, only: s.kai.id })
    await check.mock.results[0].value
    expect(s.posts).toHaveLength(1)
    expect(s.notes()).toHaveLength(1)
  })

  it("doesn't check the Lead's turn ends", async () => {
    const s = await setUp()
    const leadChat = await s.k.lead.leadChat(s.room.id)
    const lead = s.k.store.workspace(leadChat.workspaceId)!
    const check = vi.spyOn(s.k.baseWatch, 'check')
    sessionDeps(s.k).onTurnDone!(lead, leadChat, { ok: true, interrupted: false, by: 'user' })
    expect(check).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<Workspace>]>([
    ['one with a PR open', { prState: 'ready' }],
    ['one whose PR is a draft', { prState: 'draft' }],
    ['a review', { reviewOf: 'some-other-workspace' }],
    ['one on the current branch', { mode: 'current' }],
    ['one that is still in setup', { status: 'setup' }],
    ['an archived one', { status: 'archived' }]
  ])('never messages %s', async (_name, patch) => {
    const s = await setUp()
    await conflictOnMain(s)
    s.k.store.saveWorkspace({ ...s.kai, ...patch })
    await s.check()
    expect(s.posts).toEqual([])
    expect(s.saved()[s.kai.id]).toBeUndefined()
  })

  it("still tells a workspace whose PR is being opened", async () => {
    const s = await setUp()
    await conflictOnMain(s)
    s.k.store.saveWorkspace({ ...s.kai, prState: 'creating' })
    await s.check()
    expect(s.posts).toHaveLength(1)
  })

  it("never messages the Lead, even when its worktree would conflict, and doesn't wake it", async () => {
    const s = await setUp()
    const leadChat = await s.k.lead.leadChat(s.room.id)
    await s.k.workspaces.worktreeMade(leadChat.workspaceId)
    const lead = s.k.store.workspace(leadChat.workspaceId)!
    await writeFile(join(lead.path, 'src/a.ts'), SAME_LINE('lead, not committed'))
    await landOnMain(s.repo, { 'src/a.ts': SAME_LINE('main') })
    await s.check()
    expect(s.posts.filter((p) => p.chatId === leadChat.id)).toEqual([])
    expect(s.saved()[lead.id]).toBeUndefined()
    // Kai wasn't in conflict, so nobody was told anything.
    expect(s.posts).toEqual([])
  })

  it('tells a chat in Build here, as it tells a teammate, and checks at its turn ends (KERNEL-778)', async () => {
    const s = await setUp()
    const leadChat = await s.k.lead.leadChat(s.room.id)
    // Only a workspace whose setup finished is watched, and a slow machine is still setting it up once the worktree exists.
    await vi.waitFor(() => expect(s.k.store.workspace(leadChat.workspaceId)?.status).toBe('ready'), { timeout: 10_000, interval: 10 })
    s.k.lead.setMode(leadChat.workspaceId, 'build')
    const lead = s.k.store.workspace(leadChat.workspaceId)!
    await commit(lead.path, { 'src/a.ts': SAME_LINE('lead') }, 'lead')
    await landOnMain(s.repo, { 'src/a.ts': SAME_LINE('main') })
    await s.check()
    expect(s.posts).toEqual([{ chatId: leadChat.id, text: baseMessage('origin/main', 1, ['src/a.ts']) }])
    const check = vi.spyOn(s.k.baseWatch, 'check')
    sessionDeps(s.k).onTurnDone!(s.k.store.workspace(lead.id)!, leadChat, { ok: true, interrupted: false, by: 'user' })
    expect(check).toHaveBeenCalledWith(s.room.id, { fetch: false, only: lead.id })
  })

  it('stops quietly when the fetch fails, and checks again once it works', async () => {
    const s = await setUp()
    await conflictOnMain(s)
    await run('git', ['-C', s.repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'kernel-no-such-remote')])
    await expect(s.check({ fetch: true })).resolves.toBeUndefined()
    expect(s.posts).toEqual([])
    expect(s.saved()[s.kai.id]).toBeUndefined()
    await run('git', ['-C', s.repo, 'remote', 'set-url', 'origin', s.bare])
    await s.check({ fetch: true })
    expect(s.posts).toHaveLength(1)
  })

  it('fetches first when asked, so a merge made elsewhere is seen', async () => {
    const s = await setUp()
    await commit(s.kai.path, { 'src/a.ts': SAME_LINE('kai') }, 'kai')
    const other = await mkdtemp(join(tmpdir(), 'kernel-clone-'))
    await run('git', ['clone', '-q', '-b', 'main', s.bare, other])
    await commit(other, { 'src/a.ts': SAME_LINE('elsewhere') }, 'elsewhere')
    await run('git', ['-C', other, 'push', '-q', 'origin', 'main'])
    await s.check()
    expect(s.posts).toEqual([])
    await s.check({ fetch: true })
    expect(s.posts.map((p) => p.text)).toEqual([baseMessage('origin/main', 1, ['src/a.ts'])])
  })

  it('skips a git that does not know merge-tree --write-tree, exit 129', async () => {
    const s = await setUp()
    await conflictOnMain(s)
    const realGit = (await run('sh', ['-c', 'command -v git'])).trim()
    const bin = await mkdtemp(join(tmpdir(), 'kernel-bin-'))
    await writeFile(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = merge-tree ] && { echo 'usage: git merge-tree' >&2; exit 129; }; done\nexec ${realGit} "$@"\n`)
    await chmod(join(bin, 'git'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      expect(await mergeTreeConflicts(s.kai.path, 'HEAD', 'origin/main')).toBeUndefined()
      await expect(s.check()).resolves.toBeUndefined()
    } finally { process.env.PATH = path }
    expect(s.posts).toEqual([])
    expect(s.saved()[s.kai.id]).toBeUndefined()
    // With a git that can, the same check tells it.
    await s.check()
    expect(s.posts).toHaveLength(1)
  })

  it('clears what it saved once the branch has caught up', async () => {
    const s = await setUp()
    await conflictOnMain(s)
    await s.check()
    expect(s.saved()[s.kai.id]).toBeDefined()
    await run('git', ['-C', s.kai.path, 'reset', '-q', '--hard', 'origin/main'])
    await s.check()
    expect(s.saved()[s.kai.id]).toBeUndefined()
    // A new conflict at a new base commit is told again, with nothing left over from the old one.
    await commit(s.kai.path, { 'src/a.ts': SAME_LINE('kai again') }, 'kai again')
    await landOnMain(s.repo, { 'src/a.ts': SAME_LINE('main again') })
    await s.check()
    expect(s.posts).toHaveLength(2)
  })

  it('forgets a workspace that is gone', async () => {
    const s = await setUp()
    await conflictOnMain(s)
    await s.check()
    expect(Object.keys(s.saved())).toEqual([s.kai.id])
    s.k.store.saveWorkspace({ ...s.kai, status: 'archived' })
    await s.check()
    expect(s.saved()).toEqual({})
  })
})

describe('what starts a check', () => {
  it("runs after a PR in the room merges, with a fetch", async () => {
    const s = await setUp()
    const check = vi.spyOn(s.k.baseWatch, 'check').mockResolvedValue(undefined)
    const pr = (state: PrInfo['state']): PrInfo => ({ workspaceId: s.kai.id, number: 7, url: 'https://github.com/o/r/pull/7', title: 'feat: build', state, baseRef: 'main', checks: [], comments: [], conflicts: [] })
    s.gh.pr = pr('ready')
    await s.k.refreshPr(s.kai.id)
    expect(check).not.toHaveBeenCalled()
    s.gh.pr = pr('merged')
    await s.k.refreshPr(s.kai.id)
    expect(check).toHaveBeenCalledWith(s.room.id, { fetch: true })
  })

  it('runs after a new workspace fetched, and not when the fetch failed', async () => {
    const s = await setUp()
    const check = vi.spyOn(s.k.baseWatch, 'check').mockResolvedValue(undefined)
    await s.k.createWorkspace(s.room.id, { prompt: 'More', agentId: 'kai', title: 'More' })
    expect(check).toHaveBeenCalledWith(s.room.id, { fetch: false, fetched: true })
    check.mockClear()
    await run('git', ['-C', s.repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'kernel-no-such-remote')])
    // Past the minute a fetch that passed is reused for (KERNEL-542).
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => { vi.useRealTimers() })
    vi.setSystemTime(Date.now() + FETCH_REUSE_MS + 1)
    await s.k.createWorkspace(s.room.id, { prompt: 'Again', agentId: 'kai', title: 'Again' })
    expect(check).not.toHaveBeenCalled()
  })
})

describe('a branch already on the remote (KERNEL-886)', () => {
  it('is asked to merge the base in, not to rebase, and the log says so', async () => {
    const s = await setUp()
    await commit(s.kai.path, { 'src/a.ts': SAME_LINE('kai') }, 'kai')
    await run('git', ['-C', s.kai.path, 'push', '-q', '-u', 'origin', 'HEAD'])
    await landOnMain(s.repo, { 'src/a.ts': SAME_LINE('main') })
    await s.check()
    expect(s.posts).toEqual([{ chatId: s.chat.id, text: baseMessage('origin/main', 1, ['src/a.ts'], 'origin') }])
    expect(s.posts[0].text).not.toContain('rebase onto')
    expect(s.notes()[0].text).toMatch(/^told \w+ to merge origin\/main in, since origin\/main moved 1 commit and would conflict in$/)
  })
})

describe('catching up a workspace that started when the fetch failed (KERNEL-653)', () => {
  /** A Kai workspace made while origin was unreachable, with origin back afterwards. */
  async function staleWorkspace(s: Awaited<ReturnType<typeof setUp>>) {
    await run('git', ['-C', s.repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'kernel-no-such-remote')])
    const ws = await s.k.createWorkspace(s.room.id, { prompt: 'Stale', agentId: 'kai', title: 'Stale' })
    expect(ws.fetchFailed).toMatch(/^Fetching origin failed/)
    await run('git', ['-C', s.repo, 'remote', 'set-url', 'origin', s.bare])
    return { ws, chat: s.k.store.chats(ws.id)[0] }
  }
  const chatNotes = (s: Awaited<ReturnType<typeof setUp>>, chatId: string) => s.k.store.items(chatId).flatMap((i) => i.kind === 'note' ? [i.text] : [])

  it('fast-forwards one with no work of its own once a fetch passes, clears fetchFailed and says so in the chat', async () => {
    const s = await setUp()
    const { ws, chat } = await staleWorkspace(s)
    await landOnMain(s.repo, { 'README.md': '# moved\n' })
    await s.check({ fetch: true })
    expect(await sha(ws.path, 'HEAD')).toBe(await sha(s.repo, 'origin/main'))
    expect(s.k.store.workspace(ws.id)!.fetchFailed).toBeUndefined()
    expect(chatNotes(s, chat.id)).toContain('Fetched origin, so this workspace now starts from the latest origin/main.')
    expect(s.posts).toEqual([])
  })

  it('sends one rebase message to one with commits of its own, and leaves its branch alone', async () => {
    const s = await setUp()
    const { ws, chat } = await staleWorkspace(s)
    await commit(ws.path, { 'src/b.ts': 'alpha\nbeta kai\ngamma\n' }, 'kai')
    const head = await sha(ws.path, 'HEAD')
    await landOnMain(s.repo, { 'README.md': '# moved\n' })
    await s.check({ fetch: true })
    expect(s.posts).toEqual([{ chatId: chat.id, text: catchUpMessage('origin/main', 1) }])
    expect(await sha(ws.path, 'HEAD')).toBe(head)
    expect(s.k.store.workspace(ws.id)!.fetchFailed).toBeUndefined()
    await s.check({ fetch: true })
    expect(s.posts).toHaveLength(1)
    expect(s.notes()[0].text).toMatch(/^told \w+ to rebase onto origin\/main, since its workspace started from it as last fetched$/)
  })

  it('asks one already on the remote to merge the base in instead (KERNEL-886)', async () => {
    const s = await setUp()
    const { ws, chat } = await staleWorkspace(s)
    await commit(ws.path, { 'src/b.ts': 'alpha\nbeta kai\ngamma\n' }, 'kai')
    await run('git', ['-C', ws.path, 'push', '-q', '-u', 'origin', 'HEAD'])
    await landOnMain(s.repo, { 'README.md': '# moved\n' })
    await s.check({ fetch: true })
    expect(s.posts).toEqual([{ chatId: chat.id, text: catchUpMessage('origin/main', 1, 'origin') }])
    expect(s.notes()[0].text).toMatch(/^told \w+ to merge origin\/main in, since its workspace started from it as last fetched$/)
  })

  it('never moves a busy one mid-turn, and catches it up at its turn end with a fetch of its own', async () => {
    const s = await setUp()
    const { ws, chat } = await staleWorkspace(s)
    const before = await sha(ws.path, 'HEAD')
    await landOnMain(s.repo, { 'README.md': '# moved\n' })
    const running = vi.spyOn(s.k.sessions, 'isRunning').mockImplementation((id) => id === chat.id)
    await s.check({ fetch: true })
    expect(await sha(ws.path, 'HEAD')).toBe(before)
    expect(s.k.store.workspace(ws.id)!.fetchFailed).toBeDefined()
    // Its turn ends: that alone tries the fetch again, a real event rather than a timer.
    running.mockReturnValue(false)
    const check = vi.spyOn(s.k.baseWatch, 'check')
    sessionDeps(s.k).onTurnDone!(s.k.store.workspace(ws.id)!, chat, { ok: true, interrupted: false, by: 'user' })
    expect(check).toHaveBeenCalledWith(s.room.id, { fetch: false, only: ws.id })
    await check.mock.results[0].value
    expect(await sha(ws.path, 'HEAD')).toBe(await sha(s.repo, 'origin/main'))
    expect(s.k.store.workspace(ws.id)!.fetchFailed).toBeUndefined()
  })

  it('keeps fetchFailed while the fetch at the turn end still fails', async () => {
    const s = await setUp()
    const { ws, chat } = await staleWorkspace(s)
    await run('git', ['-C', s.repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'kernel-no-such-remote')])
    await s.check({ only: ws.id })
    expect(s.k.store.workspace(ws.id)!.fetchFailed).toBeDefined()
    expect(chatNotes(s, chat.id).filter((n) => n.startsWith('Fetched'))).toEqual([])
  })
})
