import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setUp, tempRepo, freePort } from './helpers'
import { exec, git, run } from '../src/main/services/exec'
import { createWorktree, fastForward, snapshotBaseline } from '../src/main/services/worktrees'
import { clock, listCheckpoints, previewRevert, revertTo, snapshot, snapshotWithFiles, worktreeTree } from '../src/main/services/checkpoints'
import { Kernel } from '../src/main/kernel'
import { KEEP_CHECKPOINTS_MS } from '../src/main/features/archive'
import { revertNote } from '../src/main/features/checkpoints'

const read = (dir: string, f: string) => readFile(join(dir, f), 'utf8')
const exists = (dir: string, f: string) => stat(join(dir, f)).then(() => true, () => false)
/** Everything a snapshot must not move: HEAD, the staged index and the working tree status. */
const state = async (dir: string) => ({
  head: (await git(dir, 'rev-parse', 'HEAD')).trim(),
  staged: await git(dir, 'diff', '--cached', '--name-status'),
  status: await git(dir, 'status', '--porcelain', '--untracked-files=all')
})

describe('checkpoints', () => {
  it('snapshots the worktree, untracked files included, without touching the index, HEAD or the files', async () => {
    const dir = await tempRepo({ 'src/a.ts': 'a1\n', '.gitignore': 'node_modules\n' })
    const ws = { id: 'ws-1', name: 'invoice-table', path: dir }
    await writeFile(join(dir, 'src/a.ts'), 'a2\n')
    await writeFile(join(dir, 'staged.ts'), 's\n')
    await git(dir, 'add', 'staged.ts')
    await writeFile(join(dir, 'untracked.ts'), 'u1\nu2\n')
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules/x.js'), 'ignored\n')
    const before = await state(dir)

    const c = await snapshot(ws, { chatId: 'chat-1', title: 'Add the table\nand more', ts: 1000 })

    expect(await state(dir)).toEqual(before)
    expect(c).toMatchObject({ id: '0', ref: 'refs/kernel/checkpoints/ws-1/0', title: 'Add the table', chatId: 'chat-1', ts: 1000, current: true })
    expect(c.stat).toEqual({ files: 3, added: 4, removed: 1 })
    const files = (await git(dir, 'ls-tree', '-r', '--name-only', c.ref)).split('\n').filter(Boolean)
    expect(files.sort()).toEqual(['.gitignore', 'src/a.ts', 'staged.ts', 'untracked.ts'])
    expect(await git(dir, 'show', `${c.ref}:src/a.ts`)).toBe('a2\n')
    // Hidden refs: no new branch or tag.
    expect((await git(dir, 'branch', '--list')).trim()).toBe('* main')
  })

  it('sees a same-size edit that the index stat cache cannot tell apart', async () => {
    const dir = await tempRepo({ 'a.ts': 'a1\n' })
    // Make the stat cache blind: ignore ctime, and give the file and the real index the same old mtime, as when
    // the index was written in the same second as the file. Only git's racy-clean check catches the edit then.
    await git(dir, 'config', 'core.trustctime', 'false')
    const old = new Date(Date.now() - 60_000)
    await utimes(join(dir, 'a.ts'), old, old)
    await git(dir, 'update-index', '--refresh')
    await writeFile(join(dir, 'a.ts'), 'a2\n')
    await utimes(join(dir, 'a.ts'), old, old)
    await utimes(join(dir, '.git/index'), old, old)
    const c = await snapshot({ id: 'ws-racy', name: 'racy', path: dir }, { chatId: 'c', title: 'Edit' })
    expect(await git(dir, 'show', `${c.ref}:a.ts`)).toBe('a2\n')
  })

  it('lists turns newest first with what each turn changed', async () => {
    const dir = await tempRepo({ 'a.ts': '1\n' })
    const ws = { id: 'ws-2', name: 'list', path: dir }
    await snapshot(ws, { chatId: 'c', title: 'Build T-14 from the plan', start: true, ts: 1 })
    await snapshot(ws, { chatId: 'c', title: 'Read the plan', ts: 2 })
    await writeFile(join(dir, 'a.ts'), '1\n2\n3\n')
    await writeFile(join(dir, 'b.ts'), 'b\n')
    await snapshot(ws, { chatId: 'c', title: 'Sorting', ts: 3 })

    const list = await listCheckpoints(ws)
    expect(list.map((c) => [c.id, c.title, c.current, !!c.start])).toEqual([['2', 'Sorting', true, false], ['1', 'Read the plan', false, false], ['0', 'Build T-14 from the plan', false, true]])
    expect(list.map((c) => c.stat)).toEqual([{ files: 2, added: 3, removed: 0 }, { files: 0, added: 0, removed: 0 }, { files: 0, added: 0, removed: 0 }])
    expect(await listCheckpoints({ ...ws, id: 'other' })).toEqual([])
  })

  it('lists the files a turn added, edited and deleted, a binary one with 0 and 0 (KERNEL-584)', async () => {
    const dir = await tempRepo({ 'a.ts': '1\n2\n', 'gone.ts': 'g1\ng2\ng3\n', 'logo.png': '\0\x01png' })
    const ws = { id: 'ws-files', name: 'files', path: dir }
    await writeFile(join(dir, 'a.ts'), '1\n3\n4\n')
    await rm(join(dir, 'gone.ts'))
    await writeFile(join(dir, 'logo.png'), '\0\x02png')
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src/new file é.ts'), 'n\n')

    const { checkpoint, files } = await snapshotWithFiles(ws, { chatId: 'c', title: 'Edit' })

    expect(files).toEqual([
      { path: 'a.ts', status: 'M', added: 2, removed: 1 },
      { path: 'gone.ts', status: 'D', added: 0, removed: 3 },
      { path: 'logo.png', status: 'M', added: 0, removed: 0 },
      { path: 'src/new file é.ts', status: 'A', added: 1, removed: 0 }
    ])
    expect(checkpoint.stat).toEqual({ files: 4, added: 3, removed: 4 })
    // The next turn counts from this checkpoint: one that changed nothing has no files.
    expect((await snapshotWithFiles(ws, { chatId: 'c', title: 'Read' })).files).toEqual([])
  })

  it('gives the start checkpoint no files, even over changes the worktree already had', async () => {
    const dir = await tempRepo({ 'a.ts': '1\n' })
    await writeFile(join(dir, 'a.ts'), '2\n')
    const { checkpoint, files } = await snapshotWithFiles({ id: 'ws-start', name: 'start', path: dir }, { chatId: 'c', title: 'Go', start: true })
    expect(checkpoint.start).toBe(true)
    expect(files).toEqual([])
  })

  it('reverts: saves a backup branch first, then restores the files of the chosen turn', async () => {
    const dir = await tempRepo({ 'src/a.ts': 'a1\n', 'keep.ts': 'k\n' })
    const ws = { id: 'ws-3', name: 'invoice-table', path: dir }
    await writeFile(join(dir, 'src/a.ts'), 'a2\n')
    const first = await snapshot(ws, { chatId: 'c', title: 'Turn one' })

    // The next turn edits, adds, deletes and leaves an untracked file.
    await writeFile(join(dir, 'src/a.ts'), 'a3\n')
    await mkdir(join(dir, 'src/new'), { recursive: true })
    await writeFile(join(dir, 'src/new/b.ts'), 'b\n')
    await rm(join(dir, 'keep.ts'))
    await snapshot(ws, { chatId: 'c', title: 'Turn two' })
    const head = (await git(dir, 'rev-parse', 'HEAD')).trim()
    const staged = await git(dir, 'diff', '--cached', '--name-status')

    const r = await revertTo(ws, first.id, { now: new Date(2026, 9, 7, 10, 31, 5) })

    expect(r.backupBranch).toBe('kernel/backup/invoice-table-20261007-103105')
    expect(await git(dir, 'show', `${r.backupBranch}:src/a.ts`)).toBe('a3\n')
    expect(await git(dir, 'show', `${r.backupBranch}:src/new/b.ts`)).toBe('b\n')
    expect(await read(dir, 'src/a.ts')).toBe('a2\n')
    expect(await read(dir, 'keep.ts')).toBe('k\n')
    expect(await exists(dir, 'src/new/b.ts')).toBe(false)
    expect(await exists(dir, 'src/new')).toBe(false)
    expect((await git(dir, 'rev-parse', 'HEAD')).trim()).toBe(head)
    expect(await git(dir, 'diff', '--cached', '--name-status')).toBe(staged)
    expect((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main')

    const list = await listCheckpoints(ws)
    expect(list.find((c) => c.current)?.id).toBe(first.id)
    // The next turn after a revert counts from the reverted state.
    await writeFile(join(dir, 'src/a.ts'), 'a2\nmore\n')
    const next = await snapshot(ws, { chatId: 'c', title: 'Turn three' })
    expect(next.stat).toEqual({ files: 1, added: 1, removed: 0 })
    expect((await listCheckpoints(ws)).filter((c) => c.current).map((c) => c.id)).toEqual([next.id])
  })

  it('never reverts the baseline of a current-branch workspace', async () => {
    const dir = await tempRepo({ 'checkout.ts': 'line1\n', 'other.ts': 'o\n' })
    // The user's own work in progress, there before the workspace started.
    await writeFile(join(dir, 'checkout.ts'), 'line1\nmine\n')
    await writeFile(join(dir, 'notes.md'), 'my notes\n')
    await snapshotBaseline(dir)
    const ws = { id: 'ws-4', name: 'lead', path: dir }
    const start = await snapshot(ws, { chatId: 'c', title: 'Fix checkout', start: true })
    expect(start.start).toBe(true)

    // The agent edits a baseline file, the user's untracked notes and another file.
    await writeFile(join(dir, 'checkout.ts'), 'line1\nmine\nagent\n')
    await writeFile(join(dir, 'other.ts'), 'agent\n')
    await writeFile(join(dir, 'agent.ts'), 'new\n')
    await snapshot(ws, { chatId: 'c', title: 'Fix checkout' })

    const r = await revertTo(ws, start.id)

    expect(await read(dir, 'checkout.ts')).toBe('line1\nmine\n')
    expect(await read(dir, 'notes.md')).toBe('my notes\n')
    expect(await read(dir, 'other.ts')).toBe('o\n')
    expect(await exists(dir, 'agent.ts')).toBe(false)
    expect(await git(dir, 'show', `${r.backupBranch}:agent.ts`)).toBe('new\n')
    expect((await git(dir, 'status', '--porcelain', '--untracked-files=all')).split('\n').filter(Boolean).sort()).toEqual([' M checkout.ts', '?? notes.md'])
  })

  it('works in a git worktree and refuses an unknown checkpoint', async () => {
    const repo = await tempRepo({ 'a.ts': '1\n' })
    const path = await createWorktree({ repo, root: join(repo, '..', `wt-cp-${Date.now()}`), branch: 'feat/x', baseRef: 'main' })
    const ws = { id: 'ws-5', name: 'x', path }
    const c = await snapshot(ws, { chatId: 'c', title: 'One' })
    await writeFile(join(path, 'a.ts'), '2\n')
    await snapshot(ws, { chatId: 'c', title: 'Two' })
    await revertTo(ws, c.id)
    expect(await read(path, 'a.ts')).toBe('1\n')
    expect((await git(path, 'status', '--porcelain')).trim()).toBe('')
    await expect(revertTo(ws, '99')).rejects.toThrow('That checkpoint no longer exists.')
  })
})

/**
 * A room cloned from a bare remote, with a worktree on its own branch from origin/main. `land` pushes a commit to main from
 * another clone, as a merged PR does; `fetch` is Kernel's fetch in the room.
 */
async function remoteRoom(files: Record<string, string>) {
  const repo = await tempRepo(files)
  const bare = await mkdtemp(join(tmpdir(), 'kernel-bare-'))
  await run('git', ['init', '-q', '--bare', '-b', 'main', bare])
  await git(repo, 'remote', 'add', 'origin', bare)
  await git(repo, 'push', '-q', '-u', 'origin', 'main')
  const other = await mkdtemp(join(tmpdir(), 'kernel-other-'))
  await run('git', ['clone', '-q', bare, other])
  await git(other, 'config', 'user.email', 'o@t.dev')
  await git(other, 'config', 'user.name', 'Other')
  async function land(change: Record<string, string | null>) {
    for (const [f, c] of Object.entries(change)) {
      if (c === null) await rm(join(other, f))
      else { await mkdir(dirname(join(other, f)), { recursive: true }); await writeFile(join(other, f), c) }
    }
    await git(other, 'add', '-A')
    await git(other, 'commit', '-q', '-m', 'Merged PR')
    await git(other, 'push', '-q', 'origin', 'main')
  }
  const fetch = () => git(repo, 'fetch', '-q', 'origin')
  const path = await createWorktree({ repo, root: join(repo, '..', `wt-603-${Date.now()}`), branch: 'kernel/x', baseRef: 'origin/main' })
  const ws = (id: string) => ({ id, name: 'x', path, baseRef: 'origin/main' })
  return { repo, path, land, fetch, ws }
}

describe('a turn leaves out what arrived from the base (KERNEL-603)', () => {
  const message = (dir: string, ref: string) => git(dir, 'show', '-s', '--format=%B', ref)

  it('saves no files for a turn that edited nothing after Kernel fast-forwarded the worktree onto main', async () => {
    const { path, land, fetch, ws } = await remoteRoom({ 'a.ts': 'a\n', 'gone.ts': 'g\n' })
    const lead = ws('ws-ff')
    await snapshotWithFiles(lead, { chatId: 'c', title: 'Check the queue', start: true })
    await land({ 'a.ts': 'a\nmain\n', 'new.ts': 'n\n', 'gone.ts': null })
    await land({ 'a.ts': 'a\nmain\nmore\n' })
    await fetch()
    expect(await fastForward(path, 'origin/main')).toBe(true)

    const { checkpoint, files } = await snapshotWithFiles(lead, { chatId: 'c', title: 'Run the checks' })

    expect(files).toEqual([])
    expect(checkpoint.stat).toEqual({ files: 0, added: 0, removed: 0 })
    expect((await listCheckpoints(lead))[0].stat).toEqual(checkpoint.stat)
    // It records the base it is at now, so the next turn counts from there.
    expect(await message(path, checkpoint.ref)).toContain(`Kernel-Base: ${(await git(path, 'rev-parse', 'origin/main')).trim()}`)
  })

  it('lists only the files the agent touched in the first turn after a wait is released, and revert still restores them', async () => {
    const { path, land, fetch, ws } = await remoteRoom({ 'a.ts': 'a\n', 'api.ts': 'v1\n' })
    const w = ws('ws-wait')
    // The start checkpoint is saved while the brief waits for the PR.
    await snapshotWithFiles(w, { chatId: 'c', title: 'Build on the API', start: true })
    await land({ 'api.ts': 'v2\n', 'types.ts': 't\n' })
    await fetch()
    expect(await fastForward(path, 'origin/main')).toBe(true)
    await writeFile(join(path, 'a.ts'), 'a\nagent\n')
    await writeFile(join(path, 'ui.ts'), 'ui\n')

    const { checkpoint, files } = await snapshotWithFiles(w, { chatId: 'c', title: 'Build on the API' })

    expect(files).toEqual([{ path: 'a.ts', status: 'M', added: 1, removed: 0 }, { path: 'ui.ts', status: 'A', added: 1, removed: 0 }])
    expect((await listCheckpoints(w))[0].stat).toEqual({ files: 2, added: 2, removed: 0 })
    await writeFile(join(path, 'a.ts'), 'later\n')
    await revertTo(w, checkpoint.id)
    expect(await read(path, 'a.ts')).toBe('a\nagent\n')
    expect(await read(path, 'api.ts')).toBe('v2\n')
  })

  it.each([
    ['pull', [['pull', '-q', '--no-rebase', 'origin', 'main']]],
    ['rebase', [['fetch', '-q', 'origin'], ['rebase', '-q', 'origin/main']]],
    ['merge', [['fetch', '-q', 'origin'], ['merge', '-q', '--no-edit', 'origin/main']]]
  ])('lists only a.ts when the agent runs git %s from main and edits a.ts', async (how, steps) => {
    const { path, land, ws } = await remoteRoom({ 'a.ts': 'a\n', 'm.ts': 'm\n', 'gone.ts': 'g\n' })
    const w = ws(`ws-${how}`)
    await snapshotWithFiles(w, { chatId: 'c', title: 'Go', start: true })
    // A commit of the agent's own from an earlier turn, so main can't simply fast-forward under it.
    await writeFile(join(path, 'own.ts'), 'own\n')
    await git(path, 'add', 'own.ts')
    await git(path, 'commit', '-q', '-m', 'Own')
    expect((await snapshotWithFiles(w, { chatId: 'c', title: 'Own' })).files.map((f) => f.path)).toEqual(['own.ts'])
    await land({ 'm.ts': 'm2\n', 'n.ts': 'n\n', 'gone.ts': null })

    for (const step of steps) await git(path, ...step)
    await writeFile(join(path, 'a.ts'), 'a\nagent\n')
    const { checkpoint, files } = await snapshotWithFiles(w, { chatId: 'c', title: 'Catch up and edit' })

    expect(files).toEqual([{ path: 'a.ts', status: 'M', added: 1, removed: 0 }])
    expect(checkpoint.stat).toEqual({ files: 1, added: 1, removed: 0 })
  })

  it('lists an unpushed commit from the turn, and not again once it is pushed', async () => {
    const { path, land, ws } = await remoteRoom({ 'a.ts': 'a\n', 'm.ts': 'm\n' })
    const w = ws('ws-push')
    await snapshotWithFiles(w, { chatId: 'c', title: 'Go', start: true })
    // In one turn main moves, the agent pulls it, then commits a fix.
    await land({ 'm.ts': 'm2\n' })
    await git(path, 'pull', '-q', '--rebase', 'origin', 'main')
    await writeFile(join(path, 'a.ts'), 'a\nfix\n')
    await git(path, 'commit', '-q', '-am', 'Fix')
    expect((await snapshotWithFiles(w, { chatId: 'c', title: 'Fix it' })).files).toEqual([{ path: 'a.ts', status: 'M', added: 1, removed: 0 }])

    // The next turn pushes it, to its branch and to main, which moves the base onto the agent's commit.
    await git(path, 'push', '-q', 'origin', 'HEAD:kernel/x')
    await git(path, 'push', '-q', 'origin', 'HEAD:main')
    const { checkpoint, files } = await snapshotWithFiles(w, { chatId: 'c', title: 'Push it' })

    expect(files).toEqual([])
    expect(checkpoint.stat).toEqual({ files: 0, added: 0, removed: 0 })
  })

  it('lists a file main and the agent both changed, counted against the new base', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}\n`)
    const { path, land, ws } = await remoteRoom({ 'a.ts': lines.join('') })
    const w = ws('ws-both')
    await snapshotWithFiles(w, { chatId: 'c', title: 'Go', start: true })
    await land({ 'a.ts': ['one\n', ...lines.slice(1)].join('') })
    await writeFile(join(path, 'a.ts'), [...lines.slice(0, 9), 'ten\n'].join(''))
    await git(path, 'commit', '-q', '-am', 'Ten')
    await git(path, 'pull', '-q', '--rebase', 'origin', 'main')
    expect(await read(path, 'a.ts')).toBe(['one\n', ...lines.slice(1, 9), 'ten\n'].join(''))

    const { checkpoint, files } = await snapshotWithFiles(w, { chatId: 'c', title: 'Ten' })

    // Against the last checkpoint it would be +2 -2, main's line with the agent's.
    expect(files).toEqual([{ path: 'a.ts', status: 'M', added: 1, removed: 1 }])
    expect(checkpoint.stat).toEqual({ files: 1, added: 1, removed: 1 })
  })

  it.each(['main', 'origin/gone'])('lists every change, as before, with base %s: no remote, or a base ref that is gone', async (baseRef) => {
    const repo = await tempRepo({ 'a.ts': 'a\n' })
    const path = await createWorktree({ repo, root: join(repo, '..', `wt-603-local-${Date.now()}`), branch: 'feat/x', baseRef: 'main' })
    const w = { id: 'ws-local', name: 'x', path, baseRef }
    await snapshotWithFiles(w, { chatId: 'c', title: 'Go', start: true })
    // A merge into the local main, then the worktree catches up with it.
    await writeFile(join(repo, 'merged.ts'), 'm\n')
    await git(repo, 'add', 'merged.ts')
    await git(repo, 'commit', '-q', '-m', 'Merged')
    expect(await fastForward(path, 'main')).toBe(true)

    const { checkpoint, files } = await snapshotWithFiles(w, { chatId: 'c', title: 'Catch up' })

    expect(files).toEqual([{ path: 'merged.ts', status: 'A', added: 1, removed: 0 }])
    expect(await message(path, checkpoint.ref)).not.toContain('Kernel-Base')
  })

  it("lists the commits a chat on the main checkout makes to the base branch itself, and leaves out the ones it pulls", async () => {
    const { repo, land } = await remoteRoom({ 'a.ts': 'a\n', 'm.ts': 'm\n' })
    // A current-branch chat: its base is the local main it works on, which tracks origin/main.
    const w = { id: 'ws-current', name: 'lead', path: repo, baseRef: 'main' }
    await snapshotWithFiles(w, { chatId: 'c', title: 'Go', start: true })
    await land({ 'm.ts': 'm2\n' })
    await git(repo, 'pull', '-q', '--ff-only')
    await writeFile(join(repo, 'a.ts'), 'a\nlead\n')
    await git(repo, 'commit', '-q', '-am', 'Lead fix')

    expect((await snapshotWithFiles(w, { chatId: 'c', title: 'Fix' })).files).toEqual([{ path: 'a.ts', status: 'M', added: 1, removed: 0 }])
  })

  it('works out the base of a checkpoint saved before bases were recorded from its history', async () => {
    const { path, land, fetch, ws } = await remoteRoom({ 'a.ts': 'a\n' })
    // Saved by a Kernel that recorded no base.
    const old = await snapshotWithFiles({ id: 'ws-old', name: 'x', path }, { chatId: 'c', title: 'Go', start: true })
    expect(await message(path, old.checkpoint.ref)).not.toContain('Kernel-Base')
    await land({ 'a.ts': 'a\nmain\n', 'n.ts': 'n\n' })
    await fetch()
    expect(await fastForward(path, 'origin/main')).toBe(true)

    expect((await snapshotWithFiles(ws('ws-old'), { chatId: 'c', title: 'Check' })).files).toEqual([])
  })

  it('lists what a reset back from the base undid, since nothing arrived from it', async () => {
    const { path, land, fetch, ws } = await remoteRoom({ 'a.ts': 'a\n' })
    const lead = ws('ws-reset')
    await land({ 'a.ts': 'a\nmain\n' })
    await fetch()
    expect(await fastForward(path, 'origin/main')).toBe(true)
    await snapshotWithFiles(lead, { chatId: 'c', title: 'Go', start: true })
    await git(path, 'reset', '-q', '--hard', 'HEAD~1')

    expect((await snapshotWithFiles(lead, { chatId: 'c', title: 'Reset' })).files).toEqual([{ path: 'a.ts', status: 'M', added: 0, removed: 1 }])
  })
})

describe('what a revert would do (KERNEL-764)', () => {
  it('lists the files it would change and counts the commits since, none, local only, then pushed', async () => {
    const dir = await tempRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const bare = await mkdtemp(join(tmpdir(), 'kernel-bare-'))
    await run('git', ['init', '-q', '--bare', '-b', 'main', bare])
    await git(dir, 'remote', 'add', 'origin', bare)
    await git(dir, 'push', '-q', '-u', 'origin', 'main')
    const ws = { id: 'ws-preview', name: 'preview', path: dir }
    await snapshot(ws, { chatId: 'c', title: 'Go', start: true })
    await writeFile(join(dir, 'a.ts'), 'a\na2\n')
    await writeFile(join(dir, 'new.ts'), 'n\n')
    await rm(join(dir, 'b.ts'))
    const before = await state(dir)

    const none = await previewRevert(ws, '0')
    expect(none.files.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.ts', status: 'M', added: 0, removed: 1 }, { path: 'b.ts', status: 'A', added: 1, removed: 0 }, { path: 'new.ts', status: 'D', added: 0, removed: 1 }
    ])
    expect(none).toMatchObject({ stat: { files: 3, added: 1, removed: 2 }, commitsAhead: 0, pushed: false })
    // A preview changes nothing.
    expect(await state(dir)).toEqual(before)

    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-q', '-m', 'One')
    await snapshot(ws, { chatId: 'c', title: 'One' })
    await writeFile(join(dir, 'a.ts'), 'a\na2\na3\n')
    await git(dir, 'commit', '-q', '-am', 'Two')
    expect(await previewRevert(ws, '0')).toMatchObject({ commitsAhead: 2, pushed: false })
    // The checkpoint taken after the first commit counts only the one made since.
    expect(await previewRevert(ws, '1')).toMatchObject({ files: [{ path: 'a.ts', status: 'M', added: 0, removed: 1 }], commitsAhead: 1, pushed: false })

    await git(dir, 'push', '-q', 'origin', 'main')
    expect(await previewRevert(ws, '1')).toMatchObject({ commitsAhead: 1, pushed: true })
    await expect(previewRevert(ws, '9')).rejects.toThrow('no longer exists')
  })
})

describe('a revert keeps what arrived from the base (KERNEL-797)', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `${i + 1}\n`)
  /**
   * A checkpoint with a file of the agent's, then a commit of the agent's that also edits a.ts, then two merged PRs on main that
   * change, add and delete files, and `steps` to catch up with them.
   */
  async function caughtUp(id: string, steps: string[][]) {
    const { path, land, ws } = await remoteRoom({ 'a.ts': 'a\n', 'm.ts': 'm\n', 'gone.ts': 'g\n' })
    const w = ws(id)
    await snapshot(w, { chatId: 'c', title: 'Go', start: true })
    await writeFile(join(path, 'own.ts'), 'own\n')
    const target = await snapshot(w, { chatId: 'c', title: 'Own' })
    await writeFile(join(path, 'a.ts'), 'a\nlater\n')
    await git(path, 'add', '-A')
    await git(path, 'commit', '-q', '-m', 'Own and later')
    await land({ 'm.ts': 'm2\n', 'gone.ts': null })
    await land({ 'n.ts': 'n\n' })
    for (const step of steps) await git(path, ...step)
    return { path, w, target }
  }

  it.each([
    // The rebased copy of the agent's commit is the only one.
    ['rebase', [['fetch', '-q', 'origin'], ['rebase', '-q', 'origin/main']], 1],
    // The agent's commit and the merge commit; main's two stay out.
    ['merge', [['fetch', '-q', 'origin'], ['merge', '-q', '--no-edit', 'origin/main']], 2]
  ])('undoes only the agent\'s later edits after a %s of main, and counts only its commits', async (how, steps, commits) => {
    const { path, w, target } = await caughtUp(`ws-797-${how}`, steps as string[][])

    const preview = await previewRevert(w, target.id)
    expect(preview).toMatchObject({ files: [{ path: 'a.ts', status: 'M', added: 0, removed: 1 }], commitsAhead: commits, pushed: false, conflicts: [] })
    await git(path, 'push', '-q', 'origin', 'HEAD:kernel/x')
    expect(await previewRevert(w, target.id)).toMatchObject({ commitsAhead: commits, pushed: true })

    const r = await revertTo(w, target.id)
    expect([...r.restored, ...r.removed]).toEqual(['a.ts'])
    expect(await read(path, 'a.ts')).toBe('a\n')
    expect(await read(path, 'own.ts')).toBe('own\n')
    expect(await read(path, 'm.ts')).toBe('m2\n')
    expect(await read(path, 'n.ts')).toBe('n\n')
    expect(await exists(path, 'gone.ts')).toBe(false)
  })

  it('keeps the checkpoint\'s content of a file main changed too, and lists it in conflicts', async () => {
    const { path, land, ws } = await remoteRoom({ 'a.ts': ten.join(''), 'm.ts': 'm\n' })
    const w = ws('ws-797-both')
    await snapshot(w, { chatId: 'c', title: 'Go', start: true })
    const mine = [...ten.slice(0, 9), 'ten\n'].join('')
    await writeFile(join(path, 'a.ts'), mine)
    const target = await snapshot(w, { chatId: 'c', title: 'Ten' })
    await writeFile(join(path, 'a.ts'), mine + 'later\n')
    await git(path, 'commit', '-q', '-am', 'Ten and later')
    await land({ 'a.ts': ['one\n', ...ten.slice(1)].join(''), 'm.ts': 'm2\n' })
    await git(path, 'pull', '-q', '--rebase', 'origin', 'main')

    expect(await previewRevert(w, target.id)).toMatchObject({ files: [{ path: 'a.ts', status: 'M', added: 1, removed: 2 }], conflicts: ['a.ts'] })
    await revertTo(w, target.id)
    expect(await read(path, 'a.ts')).toBe(mine)
    expect(await read(path, 'm.ts')).toBe('m2\n')
  })

  it('writes the checkpoint whole when the base never moved, as before', async () => {
    const { path, ws } = await remoteRoom({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const w = ws('ws-797-still')
    await snapshot(w, { chatId: 'c', title: 'Go', start: true })
    await writeFile(join(path, 'a.ts'), 'a\nmine\n')
    await writeFile(join(path, 'own.ts'), 'own\n')
    const target = await snapshot(w, { chatId: 'c', title: 'Mine' })
    await git(path, 'add', '-A')
    await git(path, 'commit', '-q', '-m', 'Mine')
    await writeFile(join(path, 'a.ts'), 'later\n')
    await rm(join(path, 'b.ts'))

    expect(await previewRevert(w, target.id)).toMatchObject({ stat: { files: 2 }, commitsAhead: 1, conflicts: [] })
    await revertTo(w, target.id)
    expect(await worktreeTree(path)).toBe((await git(path, 'rev-parse', `${target.ref}^{tree}`)).trim())
  })
})

describe('checkpoints in the kernel', () => {
  it('saves the start and each turn, reverts with a note in the chat, and waits for a running agent', async () => {
    const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build T-14 from the plan', agentId: 'kai', title: 'Invoice table' })
    const chat = k.store.chats(ws.id)[0]
    const h = k.handlers()
    expect((await h['checkpoints.list']({ workspaceId: ws.id })).map((c) => [c.title, !!c.start])).toEqual([['Build T-14 from the plan', true]])

    // A turn ends: the engine saves the worktree under the turn's prompt.
    k.store.saveItem(chat.id, { kind: 'user', id: 'u1', ts: 1, parts: [{ type: 'text', text: 'Add the empty state' }] })
    await writeFile(join(ws.path, 'empty.tsx'), 'x\n')
    await k.checkpoint(ws, chat)
    const list = await h['checkpoints.list']({ workspaceId: ws.id })
    expect(list.map((c) => [c.title, c.current, c.stat.files])).toEqual([['Add the empty state', true, 1], ['Build T-14 from the plan', false, 0]])

    const running = k.sessions.isRunning
    k.sessions.isRunning = () => true
    await expect(h['checkpoints.revert']({ workspaceId: ws.id, checkpointId: '0' })).rejects.toThrow('Stop it, then revert')
    k.sessions.isRunning = running

    // A turn Kernel's team update started is titled for what it is, not by the update's first line (KERNEL-116).
    k.store.saveItem(chat.id, { kind: 'user', id: 'u2', ts: 2, from: 'kernel', parts: [{ type: 'text', text: 'Team update from Kernel, not from the user.' }], update: { rows: [] } })
    await writeFile(join(ws.path, 'empty.tsx'), 'y\n')
    await k.checkpoint(ws, chat)
    expect((await h['checkpoints.list']({ workspaceId: ws.id }))[0].title).toBe('Team update')

    const { backupBranch } = await h['checkpoints.revert']({ workspaceId: ws.id, checkpointId: '0' })
    expect(backupBranch).toMatch(/^kernel\/backup\/invoice-table-\d{8}-\d{6}$/)
    expect(await exists(ws.path, 'empty.tsx')).toBe(false)
    const note = k.store.items(chat.id).find((i) => i.kind === 'note')
    expect(note?.kind === 'note' && note.text).toBe(`Reverted files to the start of the chat. Later changes are saved on ${backupBranch}.`)
    await k.stop()
  })

  it('links each turn and the first message to their checkpoints, and tells only the next turn about a revert (KERNEL-764)', async () => {
    const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    // The brief becomes the chat's first message, as a real send makes it.
    k.sessions.send = async (chatId, parts) => { k.store.saveItem(chatId, { kind: 'user', id: 'brief', ts: 1, parts }); return { queued: false } }
    const room = await k.addRoom(repo)
    const ws = await setUp(k, (await k.createWorkspace(room.id, { prompt: 'Build T-14 from the plan', agentId: 'kai', title: 'Invoice table' })).id)
    const chat = k.store.chats(ws.id)[0]
    const row = (id: string) => k.store.items(chat.id).find((i) => i.id === id)
    // Linked just after the workspace counts as ready.
    await vi.waitFor(() => expect(row('brief')).toMatchObject({ kind: 'user', checkpointId: '0' }))

    // A turn that changed no files still gets its checkpoint.
    k.store.saveItem(chat.id, { kind: 'result', id: 'r1', ts: 2, durationMs: 1, ok: true })
    await k.checkpoints.checkpoint(ws, chat)
    expect(row('r1')).toEqual({ kind: 'result', id: 'r1', ts: 2, durationMs: 1, ok: true, checkpointId: '1' })

    k.store.saveItem(chat.id, { kind: 'user', id: 'u2', ts: 3, parts: [{ type: 'text', text: 'Add the empty state' }] })
    await writeFile(join(ws.path, 'empty.tsx'), 'x\n')
    k.store.saveItem(chat.id, { kind: 'result', id: 'r2', ts: 4, durationMs: 1, ok: true })
    const c = await k.checkpoints.checkpoint(ws, chat)
    expect(row('r2')).toMatchObject({ checkpointId: '2', files: [{ path: 'empty.tsx', status: 'A' }] })
    expect(row('u2')).not.toHaveProperty('checkpointId')

    // No revert yet, so no note.
    expect(k.checkpoints.turnNote(chat.id)).toBeUndefined()
    await k.handlers()['checkpoints.revert']({ workspaceId: ws.id, checkpointId: '1' })
    expect(k.checkpoints.turnNote(chat.id)).toBe(revertNote(clock((await listCheckpoints(ws)).find((x) => x.id === '1')!.ts)))
    expect(k.checkpoints.turnNote(chat.id)).toBeUndefined()
    expect(c.id).toBe('2')
  })

  it('links the start checkpoint when the brief goes out after it, at the end of the first turn (KERNEL-764)', async () => {
    const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    k.sessions.send = async () => ({ queued: true })
    const room = await k.addRoom(repo)
    const ws = await setUp(k, (await k.createWorkspace(room.id, { prompt: 'Build T-14 from the plan', agentId: 'kai', title: 'Invoice table' })).id)
    const chat = k.store.chats(ws.id)[0]
    // The brief is still waiting, so the start checkpoint waits for it.
    await vi.waitFor(() => expect((k.checkpoints as unknown as { starts: Map<string, string> }).starts.get(chat.id)).toBe('0'))
    k.store.saveItem(chat.id, { kind: 'user', id: 'brief', ts: 1, parts: [{ type: 'text', text: 'Build T-14 from the plan' }] })
    k.store.saveItem(chat.id, { kind: 'result', id: 'r1', ts: 2, durationMs: 1, ok: true })
    await k.checkpoints.checkpoint(ws, chat)
    expect(k.store.items(chat.id).map((i) => [i.id, 'checkpointId' in i ? i.checkpointId : undefined])).toEqual([['brief', '0'], ['r1', '1']])
  })
})

describe('checkpoints of archived workspaces (KERNEL-221)', () => {
  const DAY = 24 * 60 * 60 * 1000

  async function setup() {
    const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop().catch(() => undefined))
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    const refs = async (prefix = 'refs/kernel/') => (await git(repo, 'for-each-ref', '--format=%(refname)', prefix)).trim().split('\n').filter(Boolean)
    /** A workspace with a turn that left a file only its checkpoint holds, archived `daysAgo` days ago by a faked clock. */
    async function archived(title: string, daysAgo: number) {
      const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title })
      await writeFile(join(ws.path, 'draft.md'), `only in a checkpoint of ${title}\n`)
      const c = await snapshot(ws, { chatId: k.store.chats(ws.id)[0].id, title: 'Draft' })
      const blob = (await git(repo, 'rev-parse', `${c.ref}:draft.md`)).trim()
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - daysAgo * DAY })
      try { await k.archive.archiveWorkspace(ws.id, false) } finally { vi.useRealTimers() }
      await k.archive.trashEmptied()
      return { ws: k.store.workspace(ws.id)!, blob }
    }
    const done = () => k.store.meta<Record<string, number>>('checkpointsDropped') ?? {}
    return { repo, k, room, refs, archived, done }
  }

  it('drops the refs of a workspace archived 31 days ago, and git gc reclaims what only they held', async () => {
    const { repo, k, refs, archived, done } = await setup()
    const { ws, blob } = await archived('Old', 31)
    expect(await refs(`refs/kernel/checkpoints/${ws.id}/`)).toHaveLength(2)
    expect(KEEP_CHECKPOINTS_MS).toBe(30 * DAY)
    // While the refs are there, gc keeps the file only a checkpoint holds.
    await git(repo, 'gc', '--prune=now', '--quiet')
    expect((await exec('git', ['-C', repo, 'cat-file', '-e', blob])).code).toBe(0)

    await k.archive.dropOldCheckpoints()

    expect(await refs()).toEqual([])
    expect(done()).toEqual({ [ws.id]: ws.archivedAt })
    // The branch Restore needs stays.
    expect((await git(repo, 'branch', '--list', ws.branch)).trim()).not.toBe('')
    await git(repo, 'gc', '--prune=now', '--quiet')
    expect((await exec('git', ['-C', repo, 'cat-file', '-e', blob])).code).not.toBe(0)
  }, 30000)

  it('keeps the checkpoints of a workspace archived yesterday, and it restores with them', async () => {
    const { k, refs, archived, done } = await setup()
    const { ws } = await archived('Recent', 1)

    await k.archive.dropOldCheckpoints()

    expect(await refs(`refs/kernel/checkpoints/${ws.id}/`)).toHaveLength(2)
    expect(done()).toEqual({})
    await k.archive.restoreWorkspace(ws.id)
    await setUp(k, ws.id)
    expect((await k.handlers()['checkpoints.list']({ workspaceId: ws.id })).map((c) => c.title)).toEqual(['Draft', 'Go'])
  }, 30000)

  it('restores a workspace after the cleanup with no checkpoints, and new turns save again', async () => {
    const { k, archived, done } = await setup()
    const { ws } = await archived('Cleaned', 31)
    await k.archive.dropOldCheckpoints()

    await k.archive.restoreWorkspace(ws.id)
    const back = await setUp(k, ws.id)
    const h = k.handlers()
    expect(await h['checkpoints.list']({ workspaceId: ws.id })).toEqual([])
    await snapshot(back, { chatId: k.store.chats(ws.id)[0].id, title: 'Next' })
    expect((await h['checkpoints.list']({ workspaceId: ws.id })).map((c) => c.title)).toEqual(['Next'])
    // Restored, it leaves the list, so archiving it again counts from then.
    await k.archive.dropOldCheckpoints()
    expect(done()).toEqual({})
  }, 30000)

  it('skips the workspaces a run already did, and comes back to one archived again', async () => {
    const { repo, k, refs, archived } = await setup()
    const { ws } = await archived('Done', 31)
    await k.archive.dropOldCheckpoints()
    // A ref the next run would drop if it looked: it doesn't, since the workspace is done.
    await git(repo, 'update-ref', `refs/kernel/checkpoints/${ws.id}/7`, 'HEAD')

    await k.archive.dropOldCheckpoints()
    expect(await refs()).toEqual([`refs/kernel/checkpoints/${ws.id}/7`])

    // Archived again since, long enough ago: done from scratch.
    k.store.saveWorkspace({ ...ws, archivedAt: ws.archivedAt! + 1 })
    await k.archive.dropOldCheckpoints()
    expect(await refs()).toEqual([])
  }, 30000)

  it('skips a room whose folder is gone, and stops touching the store once Kernel stops', async () => {
    const { repo, k, refs, archived, done } = await setup()
    const { ws } = await archived('Moved', 31)
    await rename(repo, `${repo}-moved`)
    await k.archive.dropOldCheckpoints()
    expect(done()).toEqual({})
    await rename(`${repo}-moved`, repo)

    await k.stop()
    expect(k.archive['checkpointTimer']).toBeUndefined()
    // The database is closed: a run now returns before reading it, and leaves the refs.
    await k.archive.dropOldCheckpoints()
    expect(await refs(`refs/kernel/checkpoints/${ws.id}/`)).toHaveLength(2)
  }, 30000)
})
