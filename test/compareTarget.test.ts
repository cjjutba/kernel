import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { CompareTarget } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { git } from '../src/main/services/exec'
import { changedFiles, mergeBase } from '../src/main/services/worktrees'
import { setUp, tempRepo } from './helpers'

// KERNEL-516: the Changes ⋯ menu compares a workspace with its base, another branch, its uncommitted changes or one commit.

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const TEAM = {
  'README.md': '# quarter\n',
  'src/old.ts': 'one\ntwo\nthree\nfour\nfive\n',
  'src/keep.ts': 'a\nb\nc\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

/** A PNG's first bytes. The zero bytes make git treat it as binary. */
const png = (n: number) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, n])

/** A clone of a repo with `main`, a kernel on it, and a ready workspace from `origin/main`. */
async function workspace() {
  const remote = await tempRepo(TEAM)
  const repo = join(await mkdtemp(join(tmpdir(), 'kernel-clone-')), 'quarter')
  await git(remote, 'clone', '-q', remote, repo)
  await git(repo, 'config', 'user.email', 't@t.dev')
  await git(repo, 'config', 'user.name', 'Test')
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'origin/main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const room = await k.rooms.addRoom(repo)
  const ws = await setUp(k, (await k.workspaces.createWorkspace(room.id, { prompt: 'Rename old', agentId: 'kai' })).id)
  return { k, remote, repo, ws, h: k.handlers() }
}

async function commit(path: string, message: string) {
  await git(path, 'add', '-A')
  await git(path, 'commit', '-qm', message)
  return (await git(path, 'rev-parse', 'HEAD')).trim()
}

/** The totals `git diff --shortstat` gives, to hold the tracked rows against. */
async function shortstat(path: string, ...args: string[]) {
  const out = await git(path, 'diff', '--shortstat', ...args)
  const n = (what: string) => Number(new RegExp(`(\\d+) ${what}`).exec(out)?.[1] ?? 0)
  return { files: n('files? changed'), added: n('insertions?'), removed: n('deletions?') }
}

/** The rows git diff lists itself: all but the untracked notes.txt. */
const tracked = <T extends { path: string }>(files: T[]) => files.filter((f) => f.path !== 'notes.txt')

const totals = (files: { added: number; removed: number }[]) => ({ files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) })

/**
 * The workspace's branch: commit A renames src/old.ts and adds a line to it, `other` branches from A and gets a commit of
 * its own, commit B changes a line of src/keep.ts. Then README.md is edited and notes.txt made, neither committed.
 */
async function work(repo: string, path: string) {
  await git(path, 'mv', 'src/old.ts', 'src/new.ts')
  await writeFile(join(path, 'src/new.ts'), 'one\ntwo\nthree\nfour\nfive\nsix\n')
  const a = await commit(path, 'Rename old to new')
  await git(path, 'branch', 'other')
  await git(repo, 'checkout', '-q', 'other')
  await writeFile(join(repo, 'theirs.txt'), 'theirs\n')
  await commit(repo, 'Their work')
  await git(repo, 'checkout', '-q', 'main')
  await writeFile(join(path, 'src/keep.ts'), 'a\nB\nc\n')
  const b = await commit(path, 'Edit keep')
  await writeFile(join(path, 'README.md'), '# quarter\nmore\n')
  await writeFile(join(path, 'notes.txt'), 'one\ntwo\n')
  return { a, b }
}

const README = { path: 'README.md', status: 'M', added: 1, removed: 0 }
const NOTES = { path: 'notes.txt', status: 'A', added: 2, removed: 0 }
const KEEP = { path: 'src/keep.ts', status: 'M', added: 1, removed: 1 }
const RENAMED = { path: 'src/new.ts', status: 'R', added: 1, removed: 0, from: 'src/old.ts' }

describe('comparing a workspace with a chosen target (KERNEL-516)', () => {
  it('lists each target as git diff does, with the rename as one row', async () => {
    const { repo, ws, h } = await workspace()
    const { a, b } = await work(repo, ws.path)
    const changes = (target: CompareTarget) => h['workspaces.changes']({ workspaceId: ws.id, target })

    // origin/main: everything since the base, uncommitted files too.
    const main = await changes({ kind: 'branch', ref: 'origin/main' })
    expect(main).toEqual([NOTES, README, KEEP, RENAMED])
    expect(totals(tracked(main))).toEqual(await shortstat(ws.path, '--merge-base', 'origin/main'))

    // `other` holds commit A and a commit of its own, so only what came after A shows, and none of its work.
    const other = await changes({ kind: 'branch', ref: 'other' })
    expect(other).toEqual([NOTES, README, KEEP])
    expect(totals(tracked(other))).toEqual(await shortstat(ws.path, '--merge-base', 'other'))

    const uncommitted = await changes({ kind: 'uncommitted' })
    expect(uncommitted).toEqual([NOTES, README])
    expect(totals(tracked(uncommitted))).toEqual(await shortstat(ws.path, 'HEAD'))

    expect(await changes({ kind: 'commit', sha: a })).toEqual([RENAMED])
    expect(totals([RENAMED])).toEqual(await shortstat(ws.path, `${a}^`, a))
    expect(await changes({ kind: 'commit', sha: b.slice(0, 7) })).toEqual([KEEP])
  })

  it('shows a file diff for each target, and a renamed file as a rename', async () => {
    const { repo, ws, h } = await workspace()
    const { a } = await work(repo, ws.path)
    const diff = (target: CompareTarget, file?: string) => h['workspaces.diff']({ workspaceId: ws.id, target, file })

    const renamed = await diff({ kind: 'commit', sha: a }, 'src/new.ts')
    expect(renamed).toContain('rename from src/old.ts\nrename to src/new.ts')
    expect(renamed).toContain('+six\n')
    expect(renamed).not.toContain('new file mode')
    // A commit's diff is the commit alone, with nothing from the worktree.
    expect(await diff({ kind: 'commit', sha: a })).toBe(await git(ws.path, 'diff', `${a}^`, a))

    const uncommitted = await diff({ kind: 'uncommitted' })
    expect(uncommitted).toContain('+more\n')
    expect(uncommitted).toContain('diff --git a/notes.txt b/notes.txt')
    expect(uncommitted).not.toContain('src/keep.ts')
    expect(await diff({ kind: 'uncommitted' }, 'notes.txt')).toContain('+one\n+two\n')

    const other = await diff({ kind: 'branch', ref: 'other' }, 'src/keep.ts')
    expect(other).toContain('-b\n+B\n')
    expect(await diff({ kind: 'branch', ref: 'other' }, 'src/new.ts')).toBe('')
  })

  it('finds nothing uncommitted in a clean workspace', async () => {
    const { ws, h } = await workspace()
    expect(await h['workspaces.changes']({ workspaceId: ws.id, target: { kind: 'uncommitted' } })).toEqual([])
    expect(await h['workspaces.diff']({ workspaceId: ws.id, target: { kind: 'uncommitted' } })).toBe('')
  })

  it('keeps the default as it was, and only the default saves totals on the workspace', async () => {
    const { k, repo, ws, h } = await workspace()
    const { a } = await work(repo, ws.path)
    const before = k.store.workspace(ws.id)?.stat
    const pushed: unknown[] = []
    const on = (e: PushEvent) => { if (e.type === 'workspace' && e.workspace.id === ws.id) pushed.push(e.workspace.stat) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })

    for (const target of [{ kind: 'branch', ref: 'other' }, { kind: 'uncommitted' }, { kind: 'commit', sha: a }] as const) {
      await h['workspaces.changes']({ workspaceId: ws.id, target })
    }
    expect(k.store.workspace(ws.id)?.stat).toEqual(before)
    expect(pushed).toEqual([])

    const today = await changedFiles(ws.path, await mergeBase(ws.path, 'origin/main'))
    expect(await h['workspaces.changes']({ workspaceId: ws.id })).toEqual(today)
    expect(await h['workspaces.changes']({ workspaceId: ws.id, target: { kind: 'base' } })).toEqual(today)
    expect(pushed).toEqual([totals(today)])
    expect(await h['workspaces.diff']({ workspaceId: ws.id, file: 'src/keep.ts', target: { kind: 'base' } })).toBe(await h['workspaces.diff']({ workspaceId: ws.id, file: 'src/keep.ts' }))
  })

  it('lists the commits git log lists since the base, a merge included, and a merge diffs against its first parent', async () => {
    const { remote, repo, ws, h } = await workspace()
    await work(repo, ws.path)
    await writeFile(join(remote, 'landed.txt'), 'landed\n')
    await commit(remote, 'Land another PR')
    await git(ws.path, 'fetch', '-q', 'origin')
    await git(ws.path, 'merge', '-q', '--no-ff', '-m', 'Merge origin/main into the branch', 'origin/main')
    const merge = (await git(ws.path, 'rev-parse', 'HEAD')).trim()

    const log = (await git(ws.path, 'log', '--format=%H%x09%s%x09%an%x09%at', 'origin/main..HEAD')).trim().split('\n').map((l) => l.split('\t'))
    const commits = await h['workspaces.commits']({ workspaceId: ws.id })
    expect(commits).toEqual(log.map(([sha, subject, author, at]) => ({ sha, subject, author, time: Number(at) * 1000 })))
    expect(commits.map((c) => c.subject)).toEqual(['Merge origin/main into the branch', 'Edit keep', 'Rename old to new'])
    expect(commits[0].sha).toBe(merge)

    expect(await h['workspaces.changes']({ workspaceId: ws.id, target: { kind: 'commit', sha: merge } })).toEqual([{ path: 'landed.txt', status: 'A', added: 1, removed: 0 }])
  })

  it('diffs a root commit against nothing', async () => {
    const { ws, h } = await workspace()
    const root = (await git(ws.path, 'rev-list', '--max-parents=0', 'HEAD')).trim()
    const files = await h['workspaces.changes']({ workspaceId: ws.id, target: { kind: 'commit', sha: root } })
    expect(files.map((f) => f.path).sort()).toEqual((await git(ws.path, 'ls-tree', '-r', '--name-only', root)).trim().split('\n').sort())
    expect(files.every((f) => f.status === 'A' && f.removed === 0)).toBe(true)
  })

  it('reads an image as one commit had it, whatever is on disk now', async () => {
    const { ws, h } = await workspace()
    await writeFile(join(ws.path, 'logo.png'), png(1))
    await commit(ws.path, 'Logo')
    await writeFile(join(ws.path, 'logo.png'), png(2))
    const sha = await commit(ws.path, 'New logo')
    await writeFile(join(ws.path, 'logo.png'), png(3))
    const read = (at: 'base' | 'worktree') => h['workspaces.readImage']({ workspaceId: ws.id, path: 'logo.png', at, target: { kind: 'commit', sha } })
    const url = (n: number) => ({ dataUrl: `data:image/png;base64,${png(n).toString('base64')}` })
    expect(await read('base')).toEqual(url(1))
    expect(await read('worktree')).toEqual(url(2))
  })

  it('offers the base first and never the workspace branch, and refuses a branch or commit git cannot find', async () => {
    const { repo, ws, h } = await workspace()
    await work(repo, ws.path)
    const branches = await h['workspaces.compareBranches']({ workspaceId: ws.id })
    expect(branches[0]).toBe('origin/main')
    expect(branches).toEqual(expect.arrayContaining(['main', 'other']))
    expect(branches).not.toContain(ws.branch)
    expect(new Set(branches).size).toBe(branches.length)

    const changes = (target: CompareTarget) => h['workspaces.changes']({ workspaceId: ws.id, target })
    await expect(changes({ kind: 'branch', ref: 'gone' })).rejects.toThrow("can't find gone")
    await expect(changes({ kind: 'branch', ref: `--output=${join(ws.path, 'out.txt')}` })).rejects.toThrow("can't find --output")
    await expect(changes({ kind: 'commit', sha: 'HEAD' })).rejects.toThrow("can't find the commit HEAD")
    await expect(changes({ kind: 'commit', sha: 'deadbeef' })).rejects.toThrow("can't find the commit deadbeef")
  })
})
