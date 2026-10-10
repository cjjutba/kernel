import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, trustRoom } from './helpers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { RoomIcons } from '../src/main/services/roomIcons'
import type { PushEvent } from '../src/shared/ipc'

// KERNEL-256: the integration pass on room settings and the Conductor features. These cover the paths no other suite reaches.

vi.mock('../src/renderer/src/api', () => ({ call: vi.fn() }))
process.env.SHELL = '/bin/sh'

const kai = { 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' }
const events: PushEvent[] = []
bus.on('push', (e) => { if (e.type === 'script.output') events.push(e) })
const kernels: Kernel[] = []
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop()
  events.length = 0
})

async function kernelWith(...tomls: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  kernels.push(k)
  k.sessions.send = async () => ({ queued: false })
  const rooms = []
  for (const toml of tomls) {
    const room = await k.addRoom(await tempRepo({ ...kai, '.kernel/settings.toml': toml }))
    await trustRoom(k, room.id)
    rooms.push(room)
  }
  return { k, h: k.handlers(), rooms, dataDir }
}

const until = async (ok: () => boolean, what: string, ms = 15000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('two rooms keep their own scripts', () => {
  it('reads, saves and runs each room\'s scripts without touching the other', async () => {
    const { k, h, rooms: [a, b] } = await kernelWith(
      '[scripts]\nrun = "echo room-a-$KERNEL_PORT"\n',
      '[scripts]\nrun = "echo room-b-$KERNEL_PORT"\n\n[run_scripts]\nweb = "echo web-b"\n'
    )
    expect((await h['settings.room']({ roomId: a.id })).scripts.run).toBe('echo room-a-$KERNEL_PORT')
    expect((await h['settings.room']({ roomId: b.id })).scripts.run).toBe('echo room-b-$KERNEL_PORT')

    // A personal change in room A stays in room A.
    await h['settings.setRoom']({ roomId: a.id, patch: { scripts: { run: 'echo mine-a' } } })
    expect((await h['settings.room']({ roomId: a.id })).scripts.run).toBe('echo mine-a')
    const untouched = await h['settings.room']({ roomId: b.id })
    expect(untouched.scripts.run).toBe('echo room-b-$KERNEL_PORT')
    expect(untouched.sources['scripts.run']).toBe('shared')

    // Each room's workspace runs its own room's script.
    const wsA = await k.createWorkspace(a.id, { prompt: 'a', agentId: 'kai', title: 'A' })
    const wsB = await k.createWorkspace(b.id, { prompt: 'b', agentId: 'kai', title: 'B' })
    await h['scripts.run']({ workspaceId: wsA.id, kind: 'run' })
    await h['scripts.run']({ workspaceId: wsB.id, kind: 'run' })
    const said = (id: string, line: string) => events.some((e) => e.type === 'script.output' && e.workspaceId === id && e.line === line)
    await until(() => said(wsA.id, 'mine-a') && said(wsB.id, `room-b-${wsB.port}`), 'both rooms to print their own line')
    expect(events.some((e) => e.type === 'script.output' && e.workspaceId === wsA.id && e.line.startsWith('room-b'))).toBe(false)
    expect(events.some((e) => e.type === 'script.output' && e.workspaceId === wsB.id && e.line === 'mine-a')).toBe(false)
  })
})

describe('a personal override in a room', () => {
  it('is labelled "Overriding settings.toml" while it differs, and Reset brings back "From settings.toml"', async () => {
    const { sourceLine } = await import('../src/renderer/src/screens/settings/kit')
    const { h, rooms: [room] } = await kernelWith('[scripts]\nsetup = "pnpm install"\n')
    const path = 'scripts.setup'
    expect(sourceLine(await h['settings.room']({ roomId: room.id }), path)).toBe('From settings.toml')

    const overridden = await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: 'npm ci' } } })
    expect(overridden.scripts.setup).toBe('npm ci')
    expect(sourceLine(overridden, path)).toBe('Overriding settings.toml')

    // Reset is a null on the personal file.
    const reset = await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: null } } })
    expect(reset.scripts.setup).toBe('pnpm install')
    expect(sourceLine(reset, path)).toBe('From settings.toml')
  })

  it('says nothing for a value that only the personal file sets, or for no room', async () => {
    const { sourceLine } = await import('../src/renderer/src/screens/settings/kit')
    expect(sourceLine(null, 'scripts.setup')).toBeUndefined()
    expect(sourceLine({ sources: { 'scripts.setup': 'local' } } as never, 'scripts.setup')).toBeUndefined()
  })
})

describe('a room icon whose file has gone', () => {
  it('serves null, so the renderer shows the letter, and a bad file does too', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-icons-'))
    const icons = new RoomIcons(dataDir)
    expect(await icons.dataUrl(undefined)).toBeNull()
    expect(await icons.dataUrl({ kind: 'github', file: 'room-1-1.png', at: 1 } as never)).toBeNull()

    await rm(join(dataDir, 'room-icons'), { recursive: true, force: true })
    expect(await icons.dataUrl({ kind: 'github', file: '../../etc/passwd', at: 1 } as never)).toBeNull()
  })
})
