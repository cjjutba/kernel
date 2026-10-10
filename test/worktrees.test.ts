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

  it('gives branches that share their first 80 characters their own folders (KERNEL-267)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-long-' + Date.now())
    const long = 'cjjutbaofficial/kernel-242-create-in-the-new-chat-modal-puts-the-brief-in-an-empty-lead'
    const first = await createWorktree({ repo, root, branch: long, baseRef: 'main' })
    const review = await createWorktree({ repo, root, branch: `${long}-review`, baseRef: 'main' })
    const again = await createWorktree({ repo, root, branch: `${long}-review-2`, baseRef: 'main' })
    expect(new Set([first, review, again]).size).toBe(3)
    for (const p of [first, review, again]) expect(basename(p).length).toBeLessThanOrEqual(80)
    expect(basename(review)).toMatch(/-2$/)
    expect(basename(again)).toMatch(/-3$/)
    const listed = await listWorktrees(repo)
    expect([long, `${long}-review`, `${long}-review-2`].every((b) => listed.some((w) => w.branch === b))).toBe(true)
  })

  it('never reuses a folder that is already on disk, or one git still has a record for (KERNEL-267)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-taken-' + Date.now())
    await mkdir(join(root, 'feat-taken'), { recursive: true })
    await writeFile(join(root, 'feat-taken', 'notes.md'), 'mine\n')
    const path = await createWorktree({ repo, root, branch: 'feat/taken', baseRef: 'main' })
    expect(basename(path)).toBe('feat-taken-2')
    expect(await readFile(join(root, 'feat-taken', 'notes.md'), 'utf8')).toBe('mine\n')
    // The folder is gone but git hasn't pruned its record, so `worktree add` would refuse that path.
    await rm(path, { recursive: true, force: true })
    await git(repo, 'branch', '-m', 'feat/taken', 'feat/old')
    const next = await createWorktree({ repo, root, branch: 'feat/taken', baseRef: 'main' })
    expect(basename(next)).toBe('feat-taken-3')
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
