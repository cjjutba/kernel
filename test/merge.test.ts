import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, PrState, Workspace } from '@shared/types'
import { blockedText, gatingChecks, mergeBlock, mergeNeedsPr, reviewVerdicts } from '@shared/merge'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import { land, localMerge, LocalMergeError, localStatus, prepareMerge, type Refusal } from '../src/main/services/localMerge'
import { setUp, tempRepo } from './helpers'

// The one rule every Merge button and the Lead use for whether a PR can merge (KERNEL-115, KERNEL-349).

const A = 'a'.repeat(40), B = 'b'.repeat(40)
const v = (verdict: 'approved' | 'blockers', sha: string, ts: number, o: Partial<NonNullable<Workspace['reviews']>[number]> = {}) => ({ workspaceId: 'rev', agentId: 'theo', verdict, summary: '', sha, prNumber: 42, ts, ...o })
const ws = (o: Partial<Workspace> = {}) => ({ id: 'w', prState: 'ready', prNumber: 42, prHead: B, ...o }) as Workspace
const info = (o: Partial<PrInfo> = {}): PrInfo => ({ workspaceId: 'w', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], head: B, ...o })
const both = { requireGreen: true, requireReviewer: true }
const reviewer = { requireGreen: false, requireReviewer: true }
const name = (id: string) => (id === 'theo' ? 'Theo' : id)
const held = "Theo hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests)."
const notReady = 'This pull request is not ready to merge.'
const STATES = Object.keys({ none: 1, creating: 1, draft: 1, open: 1, checks: 1, cifail: 1, changes: 1, conflict: 1, resolving: 1, ready: 1, merging: 1, merged: 1, closed: 1 } satisfies Record<PrState, 1>) as PrState[]

describe('the PR state', () => {
  it('lets a ready PR merge', () => {
    expect(mergeBlock(ws({ prState: 'ready' }), info(), both)).toBeUndefined()
  })

  it('lets an open PR merge, one GitHub reports mergeable with no required checks', () => {
    expect(mergeBlock(ws({ prState: 'open' }), info({ state: 'open' }), both)).toBeUndefined()
  })

  it('refuses while a merge is already running', () => {
    expect(mergeBlock(ws({ prState: 'merging' }), info(), both)).toBe(notReady)
  })

  it('refuses every other state, whatever the settings', () => {
    for (const s of STATES.filter((s) => s !== 'ready' && s !== 'open')) {
      expect(mergeBlock(ws({ prState: s }), info(), both), s).toBe(notReady)
      expect(mergeBlock(ws({ prState: s }), undefined, { requireGreen: false, requireReviewer: false }), s).toBe(notReady)
    }
  })

  it('refuses a PR that last read ready while GitHub is still checking it for conflicts (KERNEL-376)', () => {
    for (const rules of [both, { requireGreen: false, requireReviewer: false }]) {
      expect(mergeBlock(ws({ prState: 'ready' }), info({ state: 'checks', conflictsUnknown: true }), rules)).toBe(notReady)
      expect(mergeBlock(ws({ prState: 'ready' }), info({ conflictsUnknown: true }), rules)).toBe(notReady)
    }
  })

  it('refuses when GitHub now reads the PR as anything but ready or open (KERNEL-376)', () => {
    const off = { requireGreen: false, requireReviewer: false }
    for (const s of STATES.filter((s) => s !== 'ready' && s !== 'open')) expect(mergeBlock(ws({ prState: 'ready' }), info({ state: s }), off), s).toBe(notReady)
    expect(mergeBlock(ws({ prState: 'ready' }), info({ state: 'open' }), off)).toBeUndefined()
    expect(mergeBlock(ws({ prState: 'open' }), info({ state: 'ready' }), off)).toBeUndefined()
  })
})

describe('GitHub and the checks', () => {
  it('needs the GitHub read only when green checks are required or a reviewer looked at the PR', () => {
    expect(mergeNeedsPr(ws(), { requireGreen: false, requireReviewer: true })).toBe(false)
    expect(mergeNeedsPr(ws({ reviews: [v('approved', B, 1)] }), reviewer)).toBe(true)
    expect(mergeNeedsPr(ws({ reviews: [v('approved', B, 1)] }), { requireGreen: false, requireReviewer: false })).toBe(false)
    expect(mergeNeedsPr(ws(), { requireGreen: true, requireReviewer: false })).toBe(true)
  })

  it('says why a PR cannot merge, in order: its state, GitHub, checks, then the review', () => {
    expect(mergeBlock(ws({ prState: 'checks' }), null, both)).toBe(notReady)
    expect(mergeBlock(ws(), null, both)).toBe('Could not read the pull request from GitHub.')
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info({ checks: [{ name: 'e2e', state: 'running' }] }), both)).toContain('Checks have not passed yet')
    expect(mergeBlock(ws(), info({ checks: [{ name: 'e2e', state: 'skipped' }] }), both)).toBeUndefined()
  })
})

describe("the repo's own rules (KERNEL-388)", () => {
  const green = { requireGreen: true, requireReviewer: false }

  it("counts only the checks that decide the PR, so a failing optional check doesn't hold the merge", () => {
    const checks: PrInfo['checks'] = [{ name: 'Release note', state: 'pass' }, { name: 'Test', state: 'fail', optional: true }, { name: 'Vercel', state: 'running', optional: true }]
    expect(gatingChecks(checks)).toEqual([{ name: 'Release note', state: 'pass' }])
    expect(mergeBlock(ws(), info({ checks }), green)).toBeUndefined()
    expect(mergeBlock(ws(), info({ checks: [{ name: 'Release note', state: 'running' }, ...checks.slice(1)] }), green)).toContain('Checks have not passed yet')
  })

  it("refuses a PR GitHub won't merge yet with GitHub's reason, after the checks", () => {
    expect(mergeBlock(ws(), info({ blocked: 'review' }), green)).toBe('GitHub needs an approving review before this pull request can merge.')
    expect(mergeBlock(ws(), info({ blocked: 'behind' }), green)).toBe('This branch is behind main, and GitHub needs it up to date before it can merge.')
    expect(mergeBlock(ws(), info({ blocked: 'rules' }), green)).toBe("GitHub's branch rules block this merge.")
    expect(mergeBlock(ws(), info({ blocked: 'review', checks: [{ name: 'e2e', state: 'fail' }] }), green)).toContain('Checks have not passed yet')
  })

  it('goes by the last poll when the merge read nothing, and by the read when it did', () => {
    const off = { requireGreen: false, requireReviewer: false }
    expect(mergeBlock(ws({ prBlocked: 'behind' }), undefined, off)).toBe(blockedText('behind', ''))
    expect(blockedText('behind', '')).toContain('behind its base')
    expect(mergeBlock(ws({ prBlocked: 'behind' }), info(), off)).toBeUndefined()
  })
})

describe('the review', () => {
  it('keeps the verdicts on this PR, and marks those on its head commit current', () => {
    const out = reviewVerdicts(ws({ reviews: [v('approved', A, 1), v('approved', B, 2, { workspaceId: 'r2' }), v('approved', B, 3, { prNumber: 7 })] }))
    expect(out.verdicts.map((x) => x.ts)).toEqual([1, 2])
    expect(out.current.map((x) => x.ts)).toEqual([2])
  })

  it('merges a PR nobody reviewed', () => {
    expect(mergeBlock(ws(), undefined, reviewer)).toBeUndefined()
    expect(mergeBlock(ws({ reviews: [] }), info(), both)).toBeUndefined()
    // A review on another PR from this branch doesn't count.
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1, { prNumber: 7 })] }), info(), both)).toBeUndefined()
  })

  it('merges on an approval of the head commit', () => {
    expect(mergeBlock(ws({ reviews: [v('approved', B, 1)] }), info(), both, name)).toBeUndefined()
    // A later approval of the head commit clears earlier blockers on an older one.
    expect(mergeBlock(ws({ reviews: [v('blockers', A, 1), v('approved', B, 2, { workspaceId: 'r2' })] }), info(), both, name)).toBeUndefined()
  })

  it('holds on an approval of an earlier commit', () => {
    expect(mergeBlock(ws({ reviews: [v('approved', A, 1)] }), info(), both, name)).toBe(held)
    // GitHub's head wins over the one the last poll saw.
    expect(mergeBlock(ws({ prHead: A, reviews: [v('approved', A, 1)] }), info({ head: B }), both, name)).toBe(held)
  })

  it('holds on blockers on the head commit, naming the reviewer who found them', () => {
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), both, name)).toBe(held)
    expect(mergeBlock(ws({ reviews: [v('approved', B, 1, { agentId: 'ivy', workspaceId: 'r2' }), v('blockers', B, 2)] }), info(), both, name)).toBe(held)
    // Without a name lookup it falls back to the agent id.
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), both)).toContain("theo hasn't approved")
  })

  it('ignores the review when Reviewer approval is not required', () => {
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), { requireGreen: true, requireReviewer: false }, name)).toBeUndefined()
  })
})

// KERNEL-467: a room with no GitHub merges its branches on the Mac, with git plumbing and a compare-and-swap on the base.

const git = (dir: string, ...args: string[]) => run('git', ['-C', dir, ...args])
const sha = async (dir: string, ref: string) => (await git(dir, 'rev-parse', ref)).trim()

/** Writes the files in `dir` and commits them. `author` sets who wrote the commit. */
async function commit(dir: string, files: Record<string, string>, message: string, author?: string) {
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c)
  await git(dir, 'add', '-A')
  await run('git', ['-C', dir, 'commit', '-q', '-m', message], author ? { env: { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@t.dev` } } : {})
}

/**
 * A repo with `main` checked out in its folder, and `feat/x` in a worktree beside it with two commits: one changes a.txt and
 * one adds c.txt. `moved` puts one more commit on main, which changes b.txt, so the branch is one behind.
 */
async function repoWithBranch(o: { moved?: boolean } = {}) {
  const repo = await tempRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const wt = join(await mkdtemp(join(tmpdir(), 'kernel-wt-')), 'x')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'main')
  await commit(wt, { 'a.txt': 'one!\n' }, 'feat: louder a', 'Kai')
  await commit(wt, { 'c.txt': 'three\n' }, 'feat: add c', 'Kai')
  if (o.moved) await commit(repo, { 'b.txt': 'two!\n' }, 'fix: b on main')
  return { repo, wt, main: await sha(repo, 'main'), head: await sha(repo, 'feat/x') }
}

/** The refusal a merge threw, so a test can check that nothing moved after it. */
async function refused(p: Promise<unknown>): Promise<LocalMergeError> {
  const e = await p.then(() => undefined, (e: unknown) => e)
  expect(e).toBeInstanceOf(LocalMergeError)
  return e as LocalMergeError
}

const reason = (e: LocalMergeError): Refusal => e.reason
const clean = async (dir: string) => (await git(dir, 'status', '--porcelain')).trim()

describe('reading a branch before a local merge', () => {
  it('counts ahead and behind, finds no conflict, and gives the diff stat and the clean checkout of the base', async () => {
    const { repo } = await repoWithBranch({ moved: true })
    const s = await localStatus(repo, 'feat/x', 'main')
    expect(s).toMatchObject({ base: 'main', ahead: 2, behind: 1, conflicts: [], stat: { files: 2, added: 2, removed: 1 } })
    expect(s.checkout).toEqual({ path: await realpath(repo), dirty: [] })
  })

  it('names the files that would conflict', async () => {
    const { repo } = await repoWithBranch()
    await commit(repo, { 'a.txt': 'uno\n' }, 'fix: a on main')
    expect((await localStatus(repo, 'feat/x', 'main')).conflicts).toEqual(['a.txt'])
  })

  it('merges into the local branch when the base is a remote ref', async () => {
    const { repo, wt } = await repoWithBranch()
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
    expect((await localStatus(repo, 'feat/x', 'origin/main')).base).toBe('main')
    await expect(localStatus(wt, 'feat/x', 'origin/nope')).rejects.toThrow("Kernel merges into a branch in this repo, and origin/nope isn't one.")
  })
})

describe('the local merge, by method', () => {
  it('squashes the branch into one commit on the base, and fast-forwards the clean checkout of main', async () => {
    const { repo, main } = await repoWithBranch({ moved: true })
    const done = await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash', title: 'Louder a, and c' })
    expect(done).toEqual({ sha: await sha(repo, 'main'), base: 'main' })
    expect((await git(repo, 'rev-list', '--parents', '-n', '1', 'main')).trim().split(' ').slice(1)).toEqual([main])
    expect(await git(repo, 'log', '-1', '--format=%B', 'main')).toBe('Louder a, and c\n\n* feat: louder a\n* feat: add c\n\n')
    // The folder with main checked out follows, with main's own change kept.
    expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('three\n')
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one!\n')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('two!\n')
    expect(await clean(repo)).toBe('')
  })

  it("keeps a single commit's own message when squashing it", async () => {
    const repo = await tempRepo({ 'a.txt': 'one\n' })
    await git(repo, 'branch', 'feat/y')
    const wt = join(await mkdtemp(join(tmpdir(), 'kernel-wt-')), 'y')
    await git(repo, 'worktree', 'add', '-q', wt, 'feat/y')
    await commit(wt, { 'a.txt': 'two\n' }, 'fix: two not one\n\nThe body stays.')
    await localMerge({ repo, branch: 'feat/y', base: 'main', method: 'squash', title: 'Ignored' })
    expect(await git(repo, 'log', '-1', '--format=%B', 'main')).toBe('fix: two not one\n\nThe body stays.\n\n')
  })

  it('makes a merge commit with the base and the branch as parents', async () => {
    const { repo, main, head } = await repoWithBranch({ moved: true })
    await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'merge', title: 'Louder a, and c' })
    expect((await git(repo, 'rev-list', '--parents', '-n', '1', 'main')).trim().split(' ').slice(1)).toEqual([main, head])
    expect(await git(repo, 'log', '-1', '--format=%B', 'main')).toBe("Merge branch 'feat/x' into main\n\nLouder a, and c\n\n")
    expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('three\n')
    expect(await clean(repo)).toBe('')
  })

  it('rebases each commit onto the moved base, keeping its author and message', async () => {
    const { repo, main, head } = await repoWithBranch({ moved: true })
    const done = await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'rebase' })
    expect(done.sha).not.toBe(head)
    expect(await sha(repo, 'main~2')).toBe(main)
    expect((await git(repo, 'log', '--format=%an|%s', `${main}..main`)).trim().split('\n')).toEqual(['Kai|feat: add c', 'Kai|feat: louder a'])
    expect((await git(repo, 'rev-list', '--merges', `${main}..main`)).trim()).toBe('')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('two!\n')
    expect(await clean(repo)).toBe('')
  })

  it('fast-forwards a rebase onto a base that never moved, so the commits stay the same', async () => {
    const { repo, head } = await repoWithBranch()
    expect(await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'rebase' })).toEqual({ sha: head, base: 'main' })
    expect(await sha(repo, 'main')).toBe(head)
  })

  it('stops a rebase at the commit that conflicts, even when the branch as a whole merges cleanly', async () => {
    const { repo, wt } = await repoWithBranch()
    // The branch changes a.txt and changes it back, so as a whole it leaves a.txt alone. main changes the same line.
    await commit(wt, { 'a.txt': 'one\n' }, 'revert: quiet a')
    await commit(repo, { 'a.txt': 'uno\n' }, 'fix: a on main')
    const main = await sha(repo, 'main')
    expect((await localStatus(repo, 'feat/x', 'main')).conflicts).toEqual([])
    const e = await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method: 'rebase' }))
    expect(reason(e)).toBe('conflict')
    expect(e.message).toMatch(/^Rebasing onto main would conflict at [0-9a-f]{7} \(feat: louder a\) in a\.txt\. Nothing was merged\.$/)
    expect(await sha(repo, 'main')).toBe(main)
  })

  it('moves only the branch when no folder has the base checked out', async () => {
    const { repo } = await repoWithBranch({ moved: true })
    await git(repo, 'checkout', '-q', '-b', 'other')
    const done = await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' })
    expect(await sha(repo, 'main')).toBe(done.sha)
    expect(await sha(repo, 'HEAD')).not.toBe(done.sha)
    expect(await clean(repo)).toBe('')
  })
})

describe('what stops a local merge', () => {
  it('refuses while the checkout of the base has uncommitted changes, and leaves them as they were', async () => {
    const { repo, main } = await repoWithBranch({ moved: true })
    await writeFile(join(repo, 'b.txt'), 'mine\n')
    const e = await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' }))
    expect(reason(e)).toBe('dirty')
    expect(e.files).toEqual(['b.txt'])
    expect(e.message).toBe(`The main checkout at ${await realpath(repo)} has uncommitted changes, so nothing was merged. Commit or stash b.txt there, then try again.`)
    expect(await sha(repo, 'main')).toBe(main)
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('mine\n')
    expect((await localStatus(repo, 'feat/x', 'main')).checkout?.dirty).toEqual([{ status: 'M', path: 'b.txt' }])
  })

  it('counts an untracked file only where the merge would write', async () => {
    const { repo } = await repoWithBranch()
    await writeFile(join(repo, 'notes.md'), 'scratch\n')
    expect((await localStatus(repo, 'feat/x', 'main')).checkout?.dirty).toEqual([])
    await writeFile(join(repo, 'c.txt'), 'in the way\n')
    expect((await localStatus(repo, 'feat/x', 'main')).checkout?.dirty).toEqual([{ status: '??', path: 'c.txt' }])
    expect(reason(await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' })))).toBe('dirty')
    expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('in the way\n')
  })

  it('refuses a branch that conflicts with the base, naming the files', async () => {
    const { repo } = await repoWithBranch()
    await commit(repo, { 'a.txt': 'uno\n' }, 'fix: a on main')
    const main = await sha(repo, 'main')
    for (const method of ['squash', 'merge', 'rebase'] as const) {
      const e = await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method }))
      expect(reason(e)).toBe('conflict')
      expect(e.files).toEqual(['a.txt'])
      expect(e.message).toBe('Merging into main would conflict in 1 file: a.txt. Nothing was merged.')
    }
    expect(await sha(repo, 'main')).toBe(main)
    expect(await clean(repo)).toBe('')
  })

  it('refuses a branch with nothing the base lacks', async () => {
    const repo = await tempRepo()
    await git(repo, 'branch', 'feat/empty')
    expect(reason(await refused(localMerge({ repo, branch: 'feat/empty', base: 'main', method: 'squash' })))).toBe('empty')
  })

  it("lands nothing when the base moved after the merge was made, and keeps the base's new commit", async () => {
    const { repo } = await repoWithBranch()
    const p = await prepareMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' })
    await commit(repo, { 'b.txt': 'two, from someone else\n' }, 'fix: b meanwhile')
    const theirs = await sha(repo, 'main')
    const e = await refused(land(p))
    expect(reason(e)).toBe('moved')
    expect(e.message).toBe('main moved while Kernel was merging, so nothing was merged. Try again.')
    expect(await sha(repo, 'main')).toBe(theirs)
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('two, from someone else\n')
    expect(await clean(repo)).toBe('')
  })
})

describe('a local merge through the PR feature', () => {
  const kernels: Kernel[] = []
  afterEach(async () => { for (const k of kernels.splice(0)) await k.stop() })

  it("reads the branch as ready, merges it with the room's method, and marks the workspace merged", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
    const k = new Kernel({ dataDir, home })
    kernels.push(k)
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const repo = await tempRepo({ 'README.md': '# shop\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.', '.kernel/settings.toml': '[pr]\nmerge_method = "merge"\n' })
    const room = await k.addRoom(repo)
    k.store.saveRoom({ ...room, host: 'local' })
    const ws = await setUp(k, (await k.workspaces.createWorkspace(room.id, { prompt: 'Build the cart', agentId: 'kai', title: 'Cart' })).id)
    await expect(k.prs.createPr(ws.id)).rejects.toThrow('This room merges on this Mac')
    await commit(ws.path, { 'cart.ts': 'export const cart = []\n' }, 'feat: cart')

    const ready = await k.prs.refreshPr(ws.id)
    expect(ready).toMatchObject({ prState: 'ready', prHead: await sha(repo, ws.branch) })
    expect(ready.prNumber).toBeUndefined()
    const info = await k.handlers()['pr.get']({ workspaceId: ws.id })
    expect(info?.local).toMatchObject({ ahead: 1, behind: 0, stat: { files: 1, added: 1, removed: 0 }, method: 'merge' })

    const merged = await k.prs.mergePr(ws.id)
    const main = await sha(repo, 'main')
    expect(merged).toMatchObject({ prState: 'merged', mergeCommit: main })
    expect(merged.mergedAt).toBeTypeOf('number')
    expect((await git(repo, 'rev-list', '--parents', '-n', '1', 'main')).trim().split(' ')).toHaveLength(3)
    expect(await readFile(join(repo, 'cart.ts'), 'utf8')).toBe('export const cart = []\n')
    const notes = k.store.items(k.store.chats(ws.id)[0].id).flatMap((i) => (i.kind === 'note' ? [i.text] : []))
    expect(notes).toContain(`Merged into main as ${main.slice(0, 7)}.`)
    // The branch still reads as ahead of main, and the workspace stays merged.
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('merged')
    // The merged push archives the workspace, as a merge on GitHub does.
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.status).toBe('archived'), { timeout: 10_000, interval: 20 })
  })
})
