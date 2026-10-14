import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import type { PushEvent } from '../src/shared/ipc'
import type { RoomSettings } from '../src/shared/types'
import { tempRepo } from './helpers'

// KERNEL-723: a room's Settings pages hear when .kernel/settings.toml or settings.local.toml changes on disk.

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

/** Longer than the 200 ms debounce, so a push that was coming has come. */
const settle = () => new Promise((r) => setTimeout(r, 700))

/** A started Kernel with one room whose settings the window has read, and the `settings.roomChanged` pushes it sends. */
async function watched() {
  const repo = await tempRepo()
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  const room = await k.rooms.addRoom(repo)
  const changed: RoomSettings[] = []
  const pushes: PushEvent[] = []
  const on = (e: PushEvent) => { pushes.push(e); if (e.type === 'settings.roomChanged' && e.roomId === room.id) changed.push(e.settings) }
  bus.on('push', on)
  cleanups.push(async () => { bus.off('push', on); await k.stop() })
  await mkdir(join(repo, '.kernel'), { recursive: true })
  await k.handlers()['settings.room']({ roomId: room.id })
  // An FSEvents stream takes a moment to start, and a write before then goes unheard.
  await settle()
  return { k, repo, room, changed, pushes, file: (name = 'settings.toml') => join(repo, '.kernel', name) }
}

describe('room settings files changed on disk', () => {
  it('pushes the new values after a hand edit of either file', async () => {
    const { changed, file } = await watched()
    await writeFile(file(), '[scripts]\nsetup = "pnpm install"\n')
    await vi.waitFor(() => expect(changed.at(-1)?.scripts.setup).toBe('pnpm install'), { timeout: 5000 })
    await writeFile(file('settings.local.toml'), '[scripts]\nsetup = "npm ci"\n')
    await vi.waitFor(() => expect(changed.at(-1)?.scripts.setup).toBe('npm ci'), { timeout: 5000 })
    expect(changed.at(-1)?.sources['scripts.setup']).toBe('override')
  })

  it("sends nothing for Kernel's own saves", async () => {
    const { k, room, changed } = await watched()
    const h = k.handlers()
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: 'make' } } })
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { run: 'pnpm dev' } }, shared: true })
    await h['settings.setAlwaysReview']({ roomId: room.id, paths: ['src/db/**'] })
    await h['settings.setReview']({ roomId: room.id, review: { rounds: 2 } })
    await settle()
    expect(changed).toEqual([])
  })

  it('warns about a file that stops parsing and keeps the last good values, then sends the fix', async () => {
    const { room, changed, pushes, file } = await watched()
    await writeFile(file(), '[scripts]\nsetup = "pnpm install"\n')
    await vi.waitFor(() => expect(changed).toHaveLength(1), { timeout: 5000 })
    await writeFile(file(), '[scripts]\nsetup = \n')
    await vi.waitFor(() => expect(pushes.some((e) => e.type === 'activity' && e.event.roomId === room.id && e.event.warn)).toBe(true), { timeout: 5000 })
    await settle()
    expect(changed).toHaveLength(1)
    await writeFile(file(), '[scripts]\nsetup = "bun install"\n')
    await vi.waitFor(() => expect(changed.at(-1)?.scripts.setup).toBe('bun install'), { timeout: 5000 })
  })

  it('falls back to the defaults when the file is deleted', async () => {
    const { changed, file } = await watched()
    await writeFile(file(), '[scripts]\nsetup = "pnpm install"\n')
    await vi.waitFor(() => expect(changed).toHaveLength(1), { timeout: 5000 })
    await unlink(file())
    await vi.waitFor(() => expect(changed).toHaveLength(2), { timeout: 5000 })
    expect(changed[1].scripts.setup).toBeUndefined()
  })

  it("doesn't watch a repo folder that is gone, and reading its settings doesn't throw", async () => {
    const { k, room, changed, repo, file } = await watched()
    k.config.unwatchRoom(room.id)
    await rm(repo, { recursive: true, force: true })
    await expect(k.handlers()['settings.room']({ roomId: room.id })).resolves.toBeDefined()
    expect(k.config.watching(room.id)).toBe(false)
    // The folder coming back isn't watched until the window reads the room's settings again.
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(file(), '[scripts]\nsetup = "pnpm install"\n')
    await settle()
    expect(changed).toEqual([])
  })

  it('stops watching when the room is archived, and when Kernel stops', async () => {
    const a = await watched()
    expect(a.k.config.watching(a.room.id)).toBe(true)
    await a.k.rooms.updateRoom(a.room.id, { archived: true })
    expect(a.k.config.watching(a.room.id)).toBe(false)
    await writeFile(a.file(), '[scripts]\nsetup = "pnpm install"\n')
    await settle()
    expect(a.changed).toEqual([])

    const b = await watched()
    await b.k.stop()
    expect(b.k.config.watching(b.room.id)).toBe(false)
    await writeFile(b.file(), '[scripts]\nsetup = "pnpm install"\n')
    await settle()
    expect(b.changed).toEqual([])
  })
})
