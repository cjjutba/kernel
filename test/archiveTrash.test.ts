import { describe, expect, it, onTestFinished } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { git } from '../src/main/services/exec'
import { linkNodeModules } from '../src/main/services/scripts'
import { branchExists } from '../src/main/services/worktrees'

async function setup() {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = await boot(dataDir, home)
  const room = await k.addRoom(repo)
  return { repo, dataDir, home, k, room }
}

async function boot(dataDir: string, home: string) {
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  onTestFinished(() => k.stop().catch(() => undefined))
  return k
}

/** A worktree heavy enough that deleting it takes many trips to the disk. */
async function fill(path: string) {
  for (let d = 0; d < 20; d++) {
    await mkdir(join(path, 'deps', `pkg${d}`), { recursive: true })
    await Promise.all(Array.from({ length: 50 }, (_, f) => writeFile(join(path, 'deps', `pkg${d}`, `f${f}.js`), 'module.exports = 1\n')))
  }
}

const trash = (k: Kernel) => k.store.meta<string[]>('trash') ?? []

describe('archive moves the worktree aside and deletes it later (KERNEL-284)', () => {
  it('resolves before the folder is deleted, and the folder goes once the queue drains', async () => {
    const { repo, k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    await fill(ws.path)
    // Hold the delete queue: archive resolving anyway shows it doesn't wait for the delete.
    let release = () => {}
    ;(k as unknown as { emptying: Promise<void> }).emptying = new Promise<void>((r) => { release = r })
    await k.archiveWorkspace(ws.id, false)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    await expect(stat(ws.path)).rejects.toThrow(/ENOENT/)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(basename(ws.path))
    // Delete branch on archive was off, so the branch stays for Restore.
    expect(await branchExists(repo, ws.branch)).toBe(true)
    // Still on disk and still saved: the delete runs after archive has resolved.
    const [moved] = trash(k)
    expect(dirname(moved)).toBe(join(dirname(ws.path), '.trash'))
    expect((await stat(join(moved, 'deps', 'pkg0', 'f0.js'))).isFile()).toBe(true)

    release()
    await k.trashEmptied()
    await expect(stat(moved)).rejects.toThrow(/ENOENT/)
    expect(trash(k)).toEqual([])
  }, 30000)

  it('deletes the link to a symlinked node_modules and leaves the folder it points to', async () => {
    const { repo, k, room } = await setup()
    await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    expect(await linkNodeModules(repo, ws.path)).toBe(true)
    await k.archiveWorkspace(ws.id, true)
    await k.trashEmptied()
    expect(await readdir(join(dirname(ws.path), '.trash'))).toEqual([])
    expect(await readFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    // Nothing unpushed and Delete branch asked for, so the branch goes too (KERNEL-70).
    expect(await branchExists(repo, ws.branch)).toBe(false)
  }, 30000)

  it('finishes a delete a quit cut short at the next start, and keeps one that fails for the start after', async () => {
    const { dataDir, home, k } = await setup()
    const left = await mkdtemp(join(tmpdir(), 'kernel-trash-'))
    await fill(left)
    // A file in a folder Kernel can't write to can't be deleted.
    const stuck = await mkdtemp(join(tmpdir(), 'kernel-trash-stuck-'))
    await mkdir(join(stuck, 'locked'))
    await writeFile(join(stuck, 'locked', 'a.js'), 'x\n')
    await chmod(join(stuck, 'locked'), 0o555)
    onTestFinished(() => chmod(join(stuck, 'locked'), 0o755))
    k.store.saveMeta('trash', [left, stuck])
    await k.stop()
    const next = await boot(dataDir, home)
    await next.trashEmptied()
    await expect(stat(left)).rejects.toThrow(/ENOENT/)
    expect(trash(next)).toEqual([stuck])
  }, 30000)

  it('restores right after archive, while the old folder is still being deleted', async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    await fill(ws.path)
    await k.archiveWorkspace(ws.id, false)
    const back = await k.restoreWorkspace(ws.id)
    expect(back.status).toBe('ready')
    await k.trashEmptied()
    expect(await readFile(join(ws.path, 'README.md'), 'utf8')).toBe('# client\n')
    expect(await readdir(join(dirname(ws.path), '.trash'))).toEqual([])
  }, 30000)

  it('moves aside and deletes the worktrees of a removed room when asked to delete them', async () => {
    const { repo, k, room } = await setup()
    const a = await k.createWorkspace(room.id, { prompt: 'One', agentId: 'kai', title: 'One' })
    const b = await k.createWorkspace(room.id, { prompt: 'Two', agentId: 'kai', title: 'Two' })
    await k.removeRoom(room.id, true)
    for (const ws of [a, b]) await expect(stat(ws.path)).rejects.toThrow(/ENOENT/)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toMatch(new RegExp(`${basename(a.path)}|${basename(b.path)}`))
    await k.trashEmptied()
    expect(await readdir(join(dirname(a.path), '.trash'))).toEqual([])
  }, 30000)

  it('keeps the workspace open when the worktree cannot be read', async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    await chmod(dirname(ws.path), 0o000)
    onTestFinished(() => chmod(dirname(ws.path), 0o755))
    await expect(k.archiveWorkspace(ws.id, false)).rejects.toThrow(/EACCES/)
    expect(k.store.workspace(ws.id)?.status).not.toBe('archived')
    expect(trash(k)).toEqual([])
  }, 30000)
})
