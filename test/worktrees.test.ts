import { describe, expect, it, onTestFinished } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { tempRepo } from './helpers'
import { branchExists, branchName, changedFiles, createWorktree, freeBranch, listWorktrees, mergeBase, overlaps, removeWorktree, slugify, snapshotBaseline } from '../src/main/services/worktrees'
import { git } from '../src/main/services/exec'

describe('naming', () => {
  it('slugifies task titles', () => {
    expect(slugify('Export invoices as PDF!')).toBe('export-invoices-as-pdf')
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu')
    expect(slugify('')).toBe('workspace')
  })
  it('fills branch patterns', () => {
    expect(branchName('feat/{slug}', { slug: 'invoice-table' })).toBe('feat/invoice-table')
    expect(branchName('feat/{task}-{slug}', { slug: 'invoice-table', task: 'T-14' })).toBe('feat/t-14-invoice-table')
    expect(branchName('feat/{task}-{slug}', { slug: 'x' })).toBe('feat/x')
  })
})

describe('worktrees', () => {
  it('creates, lists, diffs and removes a worktree', async () => {
    const repo = await tempRepo({ 'src/a.ts': 'export const a = 1\n' })
    const branch = await freeBranch(repo, 'feat/invoice-table')
    const path = await createWorktree({ repo, root: join(repo, '..', 'wt-' + Date.now()), branch, baseRef: 'main' })
    expect((await listWorktrees(repo)).some((w) => w.branch === branch)).toBe(true)
    await writeFile(join(path, 'src/a.ts'), 'export const a = 2\nexport const b = 3\n')
    await writeFile(join(path, 'src/new.ts'), 'x\ny\n')
    const files = await changedFiles(path, await mergeBase(path, 'main'))
    expect(files).toEqual([
      { path: 'src/a.ts', status: 'M', added: 2, removed: 1 },
      { path: 'src/new.ts', status: 'A', added: 2, removed: 0 }
    ])
    expect(await freeBranch(repo, branch)).toBe(branch + '-2')
    await removeWorktree(repo, path, { force: true, deleteBranch: branch })
    expect((await listWorktrees(repo)).some((w) => w.branch === branch)).toBe(false)
  })

  it('treats a deleted worktree folder as removed, and still deletes its branch when asked (KERNEL-109)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-gone-' + Date.now())
    const kept = await createWorktree({ repo, root, branch: 'feat/kept', baseRef: 'main' })
    const dropped = await createWorktree({ repo, root, branch: 'feat/dropped', baseRef: 'main' })
    await rm(dropped, { recursive: true, force: true })
    // git still has a record for `dropped` and drops it on `remove`. Once a prune (or gc) has dropped the record too,
    // `remove` exits 128 "is not a working tree", which is what blocked archive.
    await git(repo, 'worktree', 'prune')
    await rm(kept, { recursive: true, force: true })
    await removeWorktree(repo, kept, { force: true })
    // Resolving at all proves `worktree remove` was skipped for `dropped`: with its record pruned, it would exit 128.
    await removeWorktree(repo, dropped, { force: true, deleteBranch: 'feat/dropped' })
    const paths = (await git(repo, 'worktree', 'list', '--porcelain'))
    expect(paths).not.toContain(basename(kept))
    expect(paths).not.toContain(basename(dropped))
    expect(await branchExists(repo, 'feat/kept')).toBe(true)
    expect(await branchExists(repo, 'feat/dropped')).toBe(false)
  })

  it('still refuses a folder that exists but is not a worktree', async () => {
    const repo = await tempRepo()
    const folder = await mkdtemp(join(tmpdir(), 'kernel-not-a-worktree-'))
    await writeFile(join(folder, 'notes.md'), 'mine\n')
    await expect(removeWorktree(repo, folder, { force: true })).rejects.toThrow()
    expect(await readFile(join(folder, 'notes.md'), 'utf8')).toBe('mine\n')
  })

  it('refuses a worktree it cannot read, rather than taking it for gone', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-locked-' + Date.now())
    const path = await createWorktree({ repo, root, branch: 'feat/locked', baseRef: 'main' })
    await writeFile(join(path, 'draft.ts'), 'export {}\n')
    await chmod(root, 0o000)
    onTestFinished(() => chmod(root, 0o755))
    // stat fails with EACCES, not ENOENT, so the files may still be there and git's record must stay.
    await expect(removeWorktree(repo, path, { force: true })).rejects.toThrow(/EACCES/)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(basename(path))
  })

  it('gives branches that share their first 80 characters different folders, keeping the suffix in 80 (KERNEL-178)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-long-' + Date.now())
    const stem = 'cjjutbaofficial/kernel-206-anyone-on-the-mac-can-post-to-kernels-hook-server-and-'
    const a = await createWorktree({ repo, root, branch: stem + 'one', baseRef: 'main' })
    const b = await createWorktree({ repo, root, branch: stem + 'two', baseRef: 'main' })
    const c = await createWorktree({ repo, root, branch: stem + 'three', baseRef: 'main' })
    expect(basename(b)).toBe(basename(a).slice(0, 78) + '-2')
    expect(basename(c)).toBe(basename(a).slice(0, 78) + '-3')
    for (const p of [a, b, c]) expect(basename(p).length).toBeLessThanOrEqual(80)
    const byPath = new Map((await listWorktrees(repo)).map((w) => [basename(w.path), w.branch]))
    expect([byPath.get(basename(a)), byPath.get(basename(b)), byPath.get(basename(c))]).toEqual([stem + 'one', stem + 'two', stem + 'three'])
  })

  it('skips a folder that is on disk, or that git still has registered after it was deleted (KERNEL-178)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-taken-' + Date.now())
    await mkdir(join(root, 'feat-x'), { recursive: true })
    await writeFile(join(root, 'feat-x', 'notes.md'), 'mine\n')
    const gone = await createWorktree({ repo, root, branch: 'feat/x-2', baseRef: 'main' })
    await rm(gone, { recursive: true, force: true })
    const path = await createWorktree({ repo, root, branch: 'feat/x', baseRef: 'main' })
    expect(basename(path)).toBe('feat-x-3')
    expect(await readFile(join(root, 'feat-x', 'notes.md'), 'utf8')).toBe('mine\n')
  })

  it('starts a review of a workspace whose branch is longer than 80 characters (KERNEL-178)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-review-' + Date.now())
    const authored = 'cjjutbaofficial/kernel-206-anyone-on-the-mac-can-post-to-kernels-hook-server-and-read-its-events'
    const author = await createWorktree({ repo, root, branch: authored, baseRef: 'main' })
    // The review path in createWorkspace: a free `<branch>-review` branch, started from the reviewed branch.
    const branch = await freeBranch(repo, `${authored}-review`)
    const review = await createWorktree({ repo, root, branch, baseRef: authored })
    expect(review).not.toBe(author)
    expect((await git(review, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(`${authored}-review`)
    expect((await git(author, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(authored)
  })

  it('leaves no new branch behind when git cannot add the worktree (KERNEL-178)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-readonly-' + Date.now())
    await createWorktree({ repo, root, branch: 'feat/first', baseRef: 'main' })
    // git makes the branch, then fails to create the folder in a root it cannot write to.
    await chmod(root, 0o555)
    onTestFinished(() => chmod(root, 0o755))
    await expect(createWorktree({ repo, root, branch: 'feat/second', baseRef: 'main' })).rejects.toThrow()
    expect(await branchExists(repo, 'feat/second')).toBe(false)
    // A branch that was already there stays when `-b` refuses it.
    await chmod(root, 0o755)
    await expect(createWorktree({ repo, root, branch: 'feat/first', baseRef: 'main' })).rejects.toThrow(/already exists/)
    expect(await branchExists(repo, 'feat/first')).toBe(true)
  })

  it('hides pre-existing changes for current-branch workspaces', async () => {
    const repo = await tempRepo({ 'checkout.ts': 'line1\n', 'other.ts': 'o\n' })
    await writeFile(join(repo, 'checkout.ts'), 'line1\nmine\n')
    await writeFile(join(repo, 'scratch.txt'), 'notes\n')
    const base = await snapshotBaseline(repo)
    expect(base.untracked).toEqual(['scratch.txt'])
    expect((await git(repo, 'status', '--porcelain')).trim()).not.toBe('')
    await writeFile(join(repo, 'other.ts'), 'o\nagent\n')
    const files = await changedFiles(repo, base.ref, base.untracked)
    expect(files.map((f) => f.path)).toEqual(['other.ts'])
  })

  it('reports overlapping files between workspaces', () => {
    expect(overlaps([{ path: 'a', status: 'M', added: 1, removed: 0 }], [{ path: 'a', status: 'M', added: 2, removed: 0 }, { path: 'b', status: 'A', added: 1, removed: 0 }])).toEqual(['a'])
  })
})
