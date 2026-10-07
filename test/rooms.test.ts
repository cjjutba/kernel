import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '../src/shared/ipc'
import type { RoomSetupStep } from '../src/shared/types'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { exec } from '../src/main/services/exec'
import { ago, agoShort, roomState } from '../src/renderer/src/screens/rooms/roomInfo'
import { assertFreeFolder, ensureRepoSettings, expandHome, inspectFolder, recentFolders, seatStarterTeam } from '../src/main/services/rooms'
import { tempRepo } from './helpers'

const starter = join(__dirname, '..', 'docs', 'starter-agents')

async function kernel() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir, home, starterDir: starter, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  return { k, home }
}

/** Resolves with the last `room.setup` steps once none is waiting or running. */
function setupDone(roomId: string): Promise<RoomSetupStep[]> {
  return new Promise((resolve) => {
    const on = (e: PushEvent) => {
      if (e.type !== 'room.setup' || e.roomId !== roomId || e.steps.some((s) => s.state === 'wait' || s.state === 'run')) return
      bus.off('push', on)
      resolve(e.steps)
    }
    bus.on('push', on)
  })
}

describe('rooms service', () => {
  it('reads a folder: git or not, branch, uncommitted files', async () => {
    const repo = await tempRepo()
    expect(await inspectFolder(repo)).toEqual({ path: repo, git: true, branch: 'main', dirty: 0 })
    await writeFile(join(repo, 'a.txt'), 'x')
    await writeFile(join(repo, 'b.txt'), 'x')
    expect((await inspectFolder(repo)).dirty).toBe(2)
    const plain = await mkdtemp(join(tmpdir(), 'plain-'))
    expect(await inspectFolder(plain)).toEqual({ path: plain, git: false })
    await expect(inspectFolder(join(plain, 'missing'))).rejects.toThrow('is not a folder')
  })

  it('lists project folders that are not rooms yet, and expands ~', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    await mkdir(join(home, 'Projects', 'one'), { recursive: true })
    await mkdir(join(home, 'Projects', 'two'), { recursive: true })
    await mkdir(join(home, 'Projects', '.hidden'), { recursive: true })
    const list = await recentFolders([join(home, 'Projects', 'one')], home)
    expect(list.map((f) => f.path)).toEqual([join(home, 'Projects', 'two')])
    expect(expandHome('~/Projects/x', home)).toBe(join(home, 'Projects', 'x'))
  })

  it('seats the Lead plus the picked starters, and writes settings.toml once', async () => {
    const repo = await tempRepo()
    expect(await seatStarterTeam(starter, repo, ['kai', 'nobody'])).toEqual(['rowan', 'kai'])
    expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['kai.md', 'rowan.md'])
    expect(await ensureRepoSettings(repo)).toBe(true)
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[files]\ncopy = []\n')
    expect(await ensureRepoSettings(repo)).toBe(false)
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toBe('[files]\ncopy = []\n')
  })

  it('refuses to clone into a folder that has files', async () => {
    const dir = await tempRepo()
    await expect(assertFreeFolder(dir)).rejects.toThrow('already exists and is not empty')
    await assertFreeFolder(join(dir, 'fresh'))
  })
})

describe('Kernel rooms', () => {
  it('creates a room from a folder, runs setup, then removes it without touching the folder', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n' })
    const done = (async () => { const room = await k.createRoom({ source: 'folder', name: 'Own app', desc: 'Nights', from: repo, team: ['kai'], autostart: false }); return { room, steps: await setupDone(room.id) } })()
    const { room, steps } = await done
    expect(room).toMatchObject({ name: 'Own app', kind: 'folder', path: repo })
    expect(steps.map((s) => [s.id, s.state])).toEqual([['clone', 'ok'], ['worktrees', 'ok'], ['install', 'ok'], ['copy', 'ok'], ['hooks', 'fail'], ['agents', 'ok']])
    expect(steps.find((s) => s.id === 'hooks')?.error).toContain('Check hooks')
    expect((await k.agents(room.id)).map((a) => a.id)).toEqual(['rowan', 'kai'])
    expect(await stat(join(repo, '.kernel', 'settings.toml'))).toBeTruthy()

    await expect(k.createRoom({ source: 'folder', name: 'Again', from: repo, team: [], autostart: false })).rejects.toThrow('already the room Own app')

    const hidden = await k.updateRoom(room.id, { hidden: true })
    expect(hidden.hidden).toBe(true)
    expect(k.store.room(room.id)?.hidden).toBe(true)

    await k.removeRoom(room.id, false)
    expect(k.store.room(room.id)).toBeUndefined()
    expect(await stat(join(repo, 'README.md'))).toBeTruthy()
    expect(await stat(join(repo, '.claude', 'agents', 'rowan.md'))).toBeTruthy()
    await k.stop()
  })

  it('asks before turning a plain folder into a repo, and initializes git when told to', async () => {
    const { k } = await kernel()
    const plain = await mkdtemp(join(tmpdir(), 'plain-'))
    await writeFile(join(plain, 'index.html'), '<p>hi</p>')
    await expect(k.createRoom({ source: 'folder', name: 'Plain', from: plain, team: [], autostart: false })).rejects.toThrow('not a git repository')
    const wait = (async () => { const room = await k.createRoom({ source: 'folder', name: 'Plain', from: plain, team: [], autostart: false, initGit: true }); await setupDone(room.id); return room })()
    const room = await wait
    expect((await exec('git', ['-C', plain, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main')
    expect(room.defaultBranch).toBe('main')
    await k.stop()
  })

  it('removes the worktrees of a room only when asked', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nHi' })
    const room = await k.addRoom(repo)
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(room.id, { prompt: 'Do a thing', title: 'Thing', mode: 'worktree', baseRef: 'main' })
    await k.removeRoom(room.id, true)
    await expect(stat(ws.path)).rejects.toThrow()
    expect(k.store.workspace(ws.id)).toBeUndefined()
    expect(await stat(repo)).toBeTruthy()
    await k.stop()
  })
})

describe('Rooms page helpers', () => {
  it('words the status and the age', () => {
    const room = { id: 'r', name: 'R', path: '/x', defaultBranch: 'main', paused: false, createdAt: 0 }
    const waiting = { id: 'a', kind: 'plan', source: 'sdk', roomId: 'r', title: '', status: 'pending', createdAt: 0 } as never
    expect(roomState(room, [waiting], { k: 'idle' })).toBe('you')
    expect(roomState(room, [], { k: 'working' })).toBe('working')
    expect(roomState(room, [], { k: 'idle' })).toBe('idle')
    expect(roomState({ ...room, archived: true }, [], {})).toBe('archived')
    const now = 1_000_000_000_000
    expect([120, 3600, 7200, 86400 * 2, 86400 * 21].map((s) => ago(now - s * 1000, now))).toEqual(['2 min ago', '1 hour ago', '2 hours ago', '2 days ago', '3 weeks ago'])
  })
})
