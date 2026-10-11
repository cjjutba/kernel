import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { tempRepo } from './helpers'
import { branchExists, branchName, branchType, capBranch, changedFiles, createWorktree, detachWorktree, freeBranch, listWorktrees, mergeBase, overlaps, removeWorktree, reviewBranch, shortSlug, slugify, snapshotBaseline, taskToken } from '../src/main/services/worktrees'
import { git } from '../src/main/services/exec'

// Lets a test make the next N branch checks fail as if git couldn't start. Everything else runs for real.
const spawnFailures = vi.hoisted(() => ({ left: 0 }))
vi.mock('../src/main/services/exec', async (original) => {
  const real = await original<typeof import('../src/main/services/exec')>()
  return {
    ...real,
    exec: (cmd: string, args: string[], opts?: Parameters<typeof real.exec>[2]) => {
      if (spawnFailures.left > 0 && args.includes('rev-parse') && args.includes('--verify')) {
        spawnFailures.left--
        return Promise.resolve({ code: 127, stdout: '', stderr: 'Error: spawn git ENOENT' })
      }
      return real.exec(cmd, args, opts)
    },
  }
})
function failNextBranchChecks(n: number) {
  spawnFailures.left = n
  onTestFinished(() => { spawnFailures.left = 0 })
}

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

describe('short branch names (KERNEL-275)', () => {
  it('keeps a few words of a title, without apostrophes or filler', () => {
    expect(shortSlug("A review can't start when the reviewed branch name is long")).toBe('review-cant-start-reviewed-branch')
    expect(shortSlug('Create in the New chat modal puts the brief in an empty Lead')).toBe('create-in-new-chat-modal-puts-brief')
    expect(shortSlug('Export invoices as PDF')).toBe('export-invoices-as-pdf')
    expect(shortSlug('Fix ' + 'x'.repeat(50))).toBe('fix')
    expect(shortSlug('y'.repeat(50))).toBe('y'.repeat(35))
    expect(shortSlug('When is the a')).toBe('when-is-the-a')
    expect(shortSlug('')).toBe('workspace')
    expect(shortSlug("'?!")).toBe('workspace')
    expect(shortSlug('Rename the thing', 10)).toBe('rename')
  })
  it('turns a key into a branch token', () => {
    expect(taskToken('KERNEL-267')).toBe('kernel-267')
    expect(taskToken('#41')).toBe('41')
    expect(taskToken('T_14 x')).toBe('t14x')
  })
  it('cuts a name to 60 characters at its last dash or slash', () => {
    const lead = 'cjjutbaofficial/kernel-267-a-review-cant-start-when-the-reviewed-branch-name-is-long'
    expect(capBranch(lead)).toBe('cjjutbaofficial/kernel-267-a-review-cant-start-when-the')
    expect(capBranch(lead).length).toBeLessThanOrEqual(60)
    expect(capBranch('feat/short-name')).toBe('feat/short-name')
    expect(capBranch(`feat/${'a'.repeat(55)}-b`)).toBe(`feat/${'a'.repeat(55)}`)
    expect(capBranch(`fix/${'a'.repeat(70)}`)).toBe('fix')
    expect(capBranch('z'.repeat(70))).toBe('z'.repeat(60))
    expect(capBranch(`feat/${'a'.repeat(54)}.-${'b'.repeat(10)}`)).toBe(`feat/${'a'.repeat(54)}`)
  })
  it('picks fix for a Bug label in any case, else feat', () => {
    expect(branchType(['Engine', 'Bug'])).toBe('fix')
    expect(branchType(['bug'])).toBe('fix')
    expect(branchType(['Engine', 'Bugfix'])).toBe('feat')
    expect(branchType([])).toBe('feat')
    expect(branchType()).toBe('feat')
  })
  it('fills {type} and cuts the result', () => {
    expect(branchName('{type}/{task}-{slug}', { slug: 'issues-screen', task: 'KERNEL-83', type: 'fix' })).toBe('fix/kernel-83-issues-screen')
    expect(branchName('{type}/{task}-{slug}', { slug: 'issues-screen', task: 'KERNEL-83' })).toBe('feat/kernel-83-issues-screen')
    expect(branchName('{type}/{task}-{slug}', { slug: 'export-invoices-as-pdf' })).toBe('feat/export-invoices-as-pdf')
    expect(branchName('{type}/{task}-{slug}', { slug: 'a'.repeat(35), task: `KERNEL-${'9'.repeat(30)}` }).length).toBeLessThanOrEqual(60)
  })
  it('names a review after the issue, or a few words of the reviewed title', () => {
    expect(reviewBranch('Create in the New chat modal puts the brief in an empty Lead', 'KERNEL-242')).toBe('review/kernel-242')
    expect(reviewBranch('Remove the Try section')).toBe('review/remove-try-section')
    expect(reviewBranch('Sidebar', '#41')).toBe('review/41')
    expect(reviewBranch('Sidebar', '#')).toBe('review/sidebar')
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

  it('leaves no new branch behind when git cannot add the worktree (KERNEL-276)', async () => {
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

  it('keeps a branch that was already there when git could not say so before a failed add (KERNEL-276)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-unknown-' + Date.now())
    await git(repo, 'branch', 'feat/kept')
    // The check before the add can't start git, so it doesn't know feat/kept is there. `-b` then refuses it.
    failNextBranchChecks(1)
    await expect(createWorktree({ repo, root, branch: 'feat/kept', baseRef: 'main' })).rejects.toThrow(/already exists/)
    expect(await branchExists(repo, 'feat/kept')).toBe(true)
  })

  it('never calls a branch name free when git cannot say whether it is taken (KERNEL-276)', async () => {
    const repo = await tempRepo()
    await git(repo, 'branch', 'feat/taken')
    failNextBranchChecks(1)
    await expect(freeBranch(repo, 'feat/taken')).rejects.toThrow(/couldn't check whether the branch feat\/taken exists/)
    expect(await freeBranch(repo, 'feat/taken')).toBe('feat/taken-2')
    // Outside a repo git exits 128, not 1, so that's unknown too.
    const notRepo = await mkdtemp(join(tmpdir(), 'kernel-not-repo-'))
    onTestFinished(() => rm(notRepo, { recursive: true, force: true }))
    await expect(freeBranch(notRepo, 'feat/x')).rejects.toThrow(/couldn't check/)
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

  it('detaches a worktree by moving it into .trash, then prunes it and deletes its branch (KERNEL-284)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-detach-' + Date.now())
    const path = await createWorktree({ repo, root, branch: 'feat/detach', baseRef: 'main' })
    await writeFile(join(path, 'draft.ts'), 'export {}\n')
    const moved = await detachWorktree(repo, path, { force: true, deleteBranch: 'feat/detach' })
    expect(moved).toMatch(new RegExp(`^${join(root, '.trash', 'feat-detach-')}\\d+$`))
    expect(await readFile(join(moved!, 'draft.ts'), 'utf8')).toBe('export {}\n')
    await expect(stat(path)).rejects.toThrow(/ENOENT/)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('feat-detach')
    expect(await branchExists(repo, 'feat/detach')).toBe(false)
    // A gone folder has nothing to move: it only prunes, and the branch follows what was asked (KERNEL-109).
    const gone = await createWorktree({ repo, root, branch: 'feat/gone', baseRef: 'main' })
    await rm(gone, { recursive: true, force: true })
    expect(await detachWorktree(repo, gone, { force: true })).toBeUndefined()
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('feat-gone')
    expect(await branchExists(repo, 'feat/gone')).toBe(true)
  })

  it('detach refuses a folder that is not a worktree, the repo itself, and one it cannot read (KERNEL-284)', async () => {
    const repo = await tempRepo()
    const folder = await mkdtemp(join(tmpdir(), 'kernel-not-a-worktree-'))
    await writeFile(join(folder, 'notes.md'), 'mine\n')
    await expect(detachWorktree(repo, folder, { force: true })).rejects.toThrow(/not a worktree/)
    expect(await readFile(join(folder, 'notes.md'), 'utf8')).toBe('mine\n')
    await expect(detachWorktree(repo, repo, { force: true })).rejects.toThrow(/not a worktree/)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('# demo\n')

    const root = join(repo, '..', 'wt-detach-locked-' + Date.now())
    const path = await createWorktree({ repo, root, branch: 'feat/locked', baseRef: 'main' })
    await chmod(root, 0o000)
    onTestFinished(() => chmod(root, 0o755))
    await expect(detachWorktree(repo, path, { force: true })).rejects.toThrow(/EACCES/)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(basename(path))
  })

  it('detach refuses a locked worktree, since prune would keep its record (KERNEL-284)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-detach-lock-' + Date.now())
    const path = await createWorktree({ repo, root, branch: 'feat/held', baseRef: 'main' })
    await git(repo, 'worktree', 'lock', path)
    await expect(detachWorktree(repo, path, { force: true, deleteBranch: 'feat/held' })).rejects.toThrow(/locked/)
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(await branchExists(repo, 'feat/held')).toBe(true)
  })

  it('detach falls back to git worktree remove when the folder cannot move (KERNEL-284)', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-detach-fallback-' + Date.now())
    const path = await createWorktree({ repo, root, branch: 'feat/fallback', baseRef: 'main' })
    // A file where the .trash folder would go stops the move.
    await writeFile(join(root, '.trash'), '')
    const saved: string[] = []
    expect(await detachWorktree(repo, path, { force: true, moving: (p) => saved.push(p) })).toBeUndefined()
    expect(saved).toHaveLength(1)
    await expect(stat(path)).rejects.toThrow(/ENOENT/)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('feat-fallback')
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
