import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, trustRoom } from './helpers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import { blocksOverlap } from '../src/main/services/scripts'
import { branchExists } from '../src/main/services/worktrees'

// KERNEL-702: archive saves `archived` first, and the archive script, the worktree and the branch go after, in the background.

// A plain sh starts fast, as in runScripts.test.ts.
process.env.SHELL = '/bin/sh'

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'

async function boot(dataDir: string, home: string) {
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  onTestFinished(() => k.stop().catch(() => undefined))
  return k
}

/** A room whose archive script is `script`, trusted, with one workspace whose branch is pushed nowhere. */
async function setup(script?: string, app: object = {}) {
  const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': KAI, ...(script ? { '.kernel/settings.toml': `[scripts]\narchive = ${JSON.stringify(script)}\n` } : {}) })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...app }))
  const k = await boot(dataDir, home)
  const room = await k.addRoom(repo)
  await trustRoom(k, room.id)
  const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
  return { k, repo, room, ws, dataDir, home }
}

/** A file the archive script waits for, so the test decides when the cleanup goes on. */
async function gate() {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-gate-'))
  const file = join(dir, 'open')
  return { script: `while [ ! -f ${file} ]; do sleep 0.05; done`, open: () => writeFile(file, '') }
}

const warnings = (k: Kernel, roomId: string, id: string) => k.store.activity(roomId).filter((a) => a.kind === 'note' && a.workspaceId === id && a.warn)

describe('archive returns before its cleanup (KERNEL-702)', () => {
  it('saves archived while the archive script still runs, and the folder goes once the cleanup ends', async () => {
    const g = await gate()
    const { k, ws } = await setup(g.script)
    await k.archiveWorkspace(ws.id)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    expect(existsSync(ws.path)).toBe(true)
    expect(k.archive.archivingNow(ws.id)).toBe(true)
    await g.open()
    await k.archive.cleanedUp(ws.id)
    expect(existsSync(ws.path)).toBe(false)
    expect(k.archive.archivingNow(ws.id)).toBe(false)
    expect(k.store.meta('cleanups')).toEqual({})
  })

  it('keeps the port block and the folder taken until the cleanup ends', async () => {
    const g = await gate()
    const { k, room, ws } = await setup(g.script)
    await k.archiveWorkspace(ws.id)
    expect(k.workspaces.reservedPorts.has(ws.port)).toBe(true)
    const next = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    expect(blocksOverlap(next.port, ws.port)).toBe(false)
    expect(next.path).not.toBe(ws.path)
    await g.open()
    await k.archive.cleanedUp(ws.id)
    expect(k.workspaces.reservedPorts.has(ws.port)).toBe(false)
  })

  it('restores only once the cleanup has ended, then brings the kept branch back', async () => {
    const g = await gate()
    const { k, repo, ws } = await setup(g.script)
    await writeFile(join(ws.path, 'work.ts'), 'work\n')
    await run('git', ['-C', ws.path, 'add', '-A'])
    await run('git', ['-C', ws.path, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'work'])
    await k.archiveWorkspace(ws.id)
    let restored = false
    const back = k.restoreWorkspace(ws.id).then((w) => { restored = true; return w })
    await new Promise((r) => setTimeout(r, 200))
    expect(restored).toBe(false)
    await g.open()
    expect(await back).toMatchObject({ status: 'setup', branch: ws.branch, path: ws.path })
    expect(await branchExists(repo, ws.branch)).toBe(true)
    expect(await readFile(join(ws.path, 'work.ts'), 'utf8')).toBe('work\n')
  })

  it('finishes a cleanup a quit cut short at the next start', async () => {
    const g = await gate()
    const { k, repo, ws, dataDir, home } = await setup(g.script, { workspace: { baseRef: 'main', deleteBranchOnArchive: true } })
    await k.archiveWorkspace(ws.id, true)
    expect(k.store.meta('cleanups')).toEqual({ [ws.id]: { deleteBranch: true } })
    await k.stop()
    expect(existsSync(ws.path)).toBe(true)
    await g.open()
    const again = await boot(dataDir, home)
    await again.archive.cleanedUp(ws.id)
    expect(existsSync(ws.path)).toBe(false)
    expect(await branchExists(repo, ws.branch)).toBe(false)
    expect(again.store.meta('cleanups')).toEqual({})
    expect(warnings(again, ws.roomId, ws.id)).toEqual([])
  })

  it('says so in a warning note when the archive script fails, and still removes the worktree', async () => {
    const { k, room, ws } = await setup('exit 3')
    await k.archiveWorkspace(ws.id)
    await k.archive.cleanedUp(ws.id)
    expect(warnings(k, room.id, ws.id).map((a) => `${a.text} ${a.object}`)).toEqual([`saw the archive script fail with exit code 3 in ${ws.name}`])
    expect(existsSync(ws.path)).toBe(false)
  })

  it('says so in a warning note when the archive script times out', async () => {
    const { k, room, ws } = await setup('sleep 600')
    // Below the setting's one minute floor, so the test doesn't wait one.
    k.settings.scripts.timeoutMinutes = 0.01
    await k.archiveWorkspace(ws.id)
    await k.archive.cleanedUp(ws.id)
    expect(warnings(k, room.id, ws.id).map((a) => `${a.text} ${a.object}`)).toEqual([`stopped the archive script after 0.01 minutes in ${ws.name}`])
    expect(existsSync(ws.path)).toBe(false)
  })

  it('turns a failed worktree removal into a warning note, not a throw', async () => {
    const { k, room, repo, ws } = await setup()
    await run('git', ['-C', repo, 'worktree', 'lock', ws.path])
    onTestFinished(async () => { await run('git', ['-C', repo, 'worktree', 'unlock', ws.path]).catch(() => undefined) })
    await k.archiveWorkspace(ws.id)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    await k.archive.cleanedUp(ws.id)
    expect(warnings(k, room.id, ws.id)).toMatchObject([{ text: "couldn't finish cleaning up after archiving", object: ws.name, quote: expect.stringMatching(/locked/) }])
    expect(existsSync(ws.path)).toBe(true)
  })

  it('makes a second archive wait for the cleanup, and still deletes the branch it asks to', async () => {
    const g = await gate()
    const { k, repo, ws } = await setup(g.script)
    await k.archiveWorkspace(ws.id, false)
    let second = false
    const again = k.archiveWorkspace(ws.id, true).then(() => { second = true })
    await new Promise((r) => setTimeout(r, 200))
    expect(second).toBe(false)
    expect(await branchExists(repo, ws.branch)).toBe(true)
    await g.open()
    await again
    expect(existsSync(ws.path)).toBe(false)
    expect(await branchExists(repo, ws.branch)).toBe(false)
    // One archive, one cleanup.
    expect(k.store.activity(ws.roomId).filter((a) => a.kind === 'workspace.archived' && a.workspaceId === ws.id)).toHaveLength(1)
  })
})
