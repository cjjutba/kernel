import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { git } from '../src/main/services/exec'
import { createWorktree, snapshotBaseline } from '../src/main/services/worktrees'
import { listCheckpoints, revertTo, snapshot } from '../src/main/services/checkpoints'
import { Kernel } from '../src/main/kernel'

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
    // CJ's own work in progress, there before the workspace started.
    await writeFile(join(dir, 'checkout.ts'), 'line1\nmine\n')
    await writeFile(join(dir, 'notes.md'), 'my notes\n')
    await snapshotBaseline(dir)
    const ws = { id: 'ws-4', name: 'lead', path: dir }
    const start = await snapshot(ws, { chatId: 'c', title: 'Fix checkout', start: true })
    expect(start.start).toBe(true)

    // The agent edits a baseline file, CJ's untracked notes and another file.
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

describe('checkpoints in the kernel', () => {
  it('saves the start and each turn, reverts with a note in the chat, and waits for a running agent', async () => {
    const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
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

    const { backupBranch } = await h['checkpoints.revert']({ workspaceId: ws.id, checkpointId: '0' })
    expect(backupBranch).toMatch(/^kernel\/backup\/invoice-table-\d{8}-\d{6}$/)
    expect(await exists(ws.path, 'empty.tsx')).toBe(false)
    const note = k.store.items(chat.id).find((i) => i.kind === 'note')
    expect(note?.kind === 'note' && note.text).toBe(`Reverted files to the start of the chat. Later changes are saved on ${backupBranch}.`)
    await k.stop()
  })
})
