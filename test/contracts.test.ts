/// <reference path="../src/preload/index.d.ts" />
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNotImplemented } from '../src/shared/ipc'
import { Kernel, UNBUILT } from '../src/main/kernel'
import { fixtures } from '../fixtures'
import { fixtureHandlers } from '../src/main/fixtures'
import { actions, apply, getState } from '../src/renderer/src/store'
import { tempRepo } from './helpers'

describe('IPC contract', () => {
  it('unbuilt channels reject with NotImplemented naming the issue that builds them', async () => {
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')) })
    const h = k.handlers() as unknown as Record<string, (req: unknown) => Promise<unknown>>
    for (const [channel, issue] of Object.entries(UNBUILT as Record<string, string>)) {
      const err = await h[channel]({}).then(() => null, (e: unknown) => e)
      expect(isNotImplemented(err), channel).toBe(true)
      expect((err as Error).message).toBe(`Not built yet: ${channel} (${issue})`)
    }
    k.store.db.close()
  })

  it('every unbuilt channel names an issue that is still to come', () => {
    const build = new Set(Array.from({ length: 21 }, (_, i) => `KERNEL-${i + 10}`))
    expect(Object.entries(UNBUILT as Record<string, string>).filter(([, issue]) => !build.has(issue))).toEqual([])
  })

  it('fixture mode answers the same channels as the kernel', async () => {
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')) })
    expect(Object.keys(fixtureHandlers(fixtures.Workspace)).sort()).toEqual(Object.keys(k.handlers()).sort())
    k.store.db.close()
  })

  it('fixture mode answers the Linear channels from the fixture, empty without one', async () => {
    const empty = fixtureHandlers(fixtures.Workspace)
    expect(await empty['linear.issues']({ filter: { mine: false } })).toEqual([])
    expect(await empty['linear.scope']()).toEqual({ teams: [], projects: [], cycles: [] })
    const issue = {
      id: 'KERNEL-83', uuid: 'u', title: 'Issues screen', url: 'https://linear.app/x', branchName: 'cj/kernel-83', priority: 2, labels: [], updatedAt: '2026-10-09T10:00:00.000Z',
      state: { id: 's', name: 'Todo', type: 'unstarted' as const, position: 1 }, team: { id: 't', key: 'KERNEL', name: 'Kernel' }, assignee: { name: 'CJ', me: true },
      description: 'Build it.', comments: []
    }
    const h = fixtureHandlers({ ...fixtures.Workspace, linear: { issues: [issue, { ...issue, id: 'KERNEL-84', assignee: undefined }] } })
    expect((await h['linear.issues']({ filter: { mine: true } })).map((i) => i.id)).toEqual(['KERNEL-83'])
    expect(await h['linear.issues']({ filter: { mine: false, query: '84' } })).not.toContainEqual(expect.objectContaining({ description: expect.anything() }))
    expect((await h['linear.issue']({ id: 'KERNEL-83' })).description).toBe('Build it.')
  })

  it('fixture mode answers the room icon channels, with the icon fixtures showing a small PNG', async () => {
    const h = fixtureHandlers(fixtures.SettingsRoomIcon)
    expect(await h['rooms.icon']({ roomId: 'room-a' })).toMatch(/^data:image\/png;base64,iVBORw0KGgo/)
    expect(await h['rooms.icon']({ roomId: 'room-b' })).toBeNull()
    expect((await h['rooms.setIcon']({ roomId: 'room-b', icon: { kind: 'github' } })).icon?.kind).toBe('github')
    expect((await h['rooms.setIcon']({ roomId: 'room-a', icon: { kind: 'letter' } })).icon).toBeUndefined()
    expect(await fixtureHandlers(fixtures.HomeRoomIcon)['rooms.icon']({ roomId: 'room-b' })).toMatch(/^data:image\/png;base64,/)
    // The other screens draw letters, so no base fixture room carries an icon.
    expect(await fixtureHandlers(fixtures.Workspace)['rooms.icon']({ roomId: 'room-portfolio' })).toBeNull()
  })

  it('fixture mode answers files.preview from the room\'s local files, with the saved list or the given patterns (KERNEL-245)', async () => {
    expect(await fixtureHandlers(fixtures.Workspace)['files.preview']({ roomId: 'room-a' })).toEqual([])
    const localFiles = { 'room-a': [{ path: 'apps/web/.env', size: 64 }, { path: '.env.local', size: 48 }, { path: '.env', size: 120 }, { path: 'notes.txt', size: 3 }] }
    const h = fixtureHandlers({ ...fixtures.Workspace, localFiles, roomSettings: { 'room-a': { scripts: {}, files: { copy: ['.env'] }, workspace: {} } } })
    expect(await h['files.preview']({ roomId: 'room-a' })).toEqual([{ path: '.env', size: 120 }])
    expect((await h['files.preview']({ roomId: 'room-a', patterns: ['.env*', 'apps/**/.env'] })).map((f) => f.path)).toEqual(['.env', '.env.local', 'apps/web/.env'])
  })

  it('serves app and room settings', async () => {
    const repo = await tempRepo({ 'README.md': '# r\n', '.kernel/settings.toml': '[scripts]\nsetup = "pnpm install"\n' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900) }))
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    await k.start()
    const h = k.handlers()
    expect((await h['settings.get']()).experimental.floor3d).toBe(false)
    const room = await k.addRoom(repo)
    expect((await h['settings.room']({ roomId: room.id })).scripts.setup).toBe('pnpm install')
    expect((await h['settings.room']({ roomId: room.id })).sources).toEqual({ 'scripts.setup': 'shared' })
    await k.stop()
  })

  it('fixture mode answers the run script shapes: runScripts, a runScripts patch by name, and named Run and Stop (KERNEL-244)', async () => {
    const h = fixtureHandlers(structuredClone(fixtures.Workspace))
    const roomId = fixtures.Workspace.rooms[0].id
    const workspaceId = fixtures.Workspace.workspaces[0].id
    expect((await h['settings.room']({ roomId })).runScripts).toEqual([])
    const rs = await h['settings.setRoom']({ roomId, patch: { runScripts: { run: 'pnpm dev', web: 'pnpm web' } }, shared: true })
    expect(rs.runScripts).toEqual([{ name: 'run', command: 'pnpm dev' }, { name: 'web', command: 'pnpm web' }])
    expect(rs.scripts.run).toBe('pnpm dev')
    expect(rs.sources).toMatchObject({ 'runScripts.web': 'shared', 'runScripts.run': 'shared', 'scripts.run': 'shared' })
    // `RUN` is `run`, as in the engine.
    expect((await h['settings.setRoom']({ roomId, patch: { runScripts: { RUN: 'pnpm start' } }, shared: true })).runScripts[0]).toEqual({ name: 'run', command: 'pnpm start' })
    const after = await h['settings.setRoom']({ roomId, patch: { runScripts: { web: null } }, shared: true })
    expect(after.runScripts).toEqual([{ name: 'run', command: 'pnpm start' }])
    expect(after.sources['runScripts.web']).toBeUndefined()
    expect(await h['scripts.run']({ workspaceId, kind: 'run', name: 'web' })).toEqual({ ok: true })
    expect(await h['scripts.stop']({ workspaceId, kind: 'run', name: 'web' })).toEqual({ ok: true })
    expect(await h['scripts.stop']({ workspaceId, kind: 'run' })).toEqual({ ok: true })
  })

  it('fixture mode returns where room settings came from, and applies a patch to any group (KERNEL-190)', async () => {
    const h = fixtureHandlers(fixtures.Workspace)
    const roomId = fixtures.Workspace.rooms[0].id
    expect((await h['settings.room']({ roomId })).sources).toEqual({})
    const rs = await h['settings.setRoom']({ roomId, patch: { pr: { createInstructions: '# Mine' }, workspace: { remote: 'upstream' } } })
    expect(rs.pr).toEqual({ createInstructions: '# Mine' })
    expect(rs.sources).toEqual({ 'pr.createInstructions': 'local', 'workspace.remote': 'local' })
    expect((await h['settings.setRoom']({ roomId, patch: { workspace: { remote: 'fork' } }, shared: true })).sources['workspace.remote']).toBe('override')
    const after = await h['settings.setRoom']({ roomId, patch: { pr: { createInstructions: null } } })
    expect(after.pr).toEqual({})
    expect(after.sources).toEqual({ 'workspace.remote': 'override' })
  })
})

describe('docs/SCREENS.md', () => {
  const rows = readFileSync('docs/SCREENS.md', 'utf8').split('\n')
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((c) => c.length === 9 && c[0] !== 'Screen' && !c[0].startsWith('---'))

  it('lists all 142 screens, each with a route and a component file', () => {
    expect(rows).toHaveLength(142)
    for (const [screen, , , , , , route, component] of rows) {
      expect(route, screen).not.toBe('')
      expect(component, screen).toMatch(/^`[\w/.-]+\.(tsx|css)`(, `[\w/.-]+\.tsx`)*$/)
    }
  })
})

describe('renderer store', () => {
  it('navigating closes the modal and menu', () => {
    actions.ui.openModal({ name: 'search' })
    actions.ui.toggleMenu('account')
    expect(getState().ui.menu).toBe('account')
    actions.ui.go({ name: 'settings', page: 'git' })
    expect(getState().ui).toMatchObject({ route: { name: 'settings', page: 'git' }, modal: null, menu: null })
  })

  it('toggles a menu closed and keeps toasts until dismissed', () => {
    actions.ui.toggleMenu('pr')
    actions.ui.toggleMenu('pr')
    expect(getState().ui.menu).toBeNull()
    const id = actions.ui.toast({ title: 'Copied' }, 0)
    expect(getState().ui.toasts.map((t) => t.title)).toEqual(['Copied'])
    actions.ui.dismissToast(id)
    expect(getState().ui.toasts).toEqual([])
  })

  it('foldChat adds and removes the id, and an unfold leaves no empty entry', () => {
    actions.ui.foldChat('c1', true)
    actions.ui.foldChat('c2', true)
    actions.ui.foldChat('c1', true)
    expect(getState().ui.foldedChats).toEqual(['c2', 'c1'])
    actions.ui.foldChat('c1', false)
    actions.ui.foldChat('c3', false)
    expect(getState().ui.foldedChats).toEqual(['c2'])
    actions.ui.foldChat('c2', false)
    expect(getState().ui.foldedChats).toEqual([])
  })

  it('applies push events to their slices', () => {
    const ws = fixtures.Workspace.workspaces[1]
    apply({ type: 'workspace', workspace: ws })
    apply({ type: 'pr', workspaceId: ws.id, state: 'merging' })
    apply({ type: 'chat.queue', chatId: 'c1', queue: [{ id: 'q1', chatId: 'c1', parts: [{ type: 'text', text: 'Also add a skeleton' }], ts: 1 }] })
    apply({ type: 'room.setup', roomId: 'r1', steps: [{ id: 'clone', title: 'Clone', detail: '', state: 'run' }] })
    apply({ type: 'retry', chatId: 'c1', retry: { attempt: 2, of: 5, nextAt: 1 } })
    apply({ type: 'retry', chatId: 'c1', retry: null })
    const s = getState()
    expect(s.workspaces.find((w) => w.id === ws.id)?.prState).toBe('merging')
    expect(s.queue.c1).toHaveLength(1)
    expect(s.roomSetup.r1[0].state).toBe('run')
    expect(s.retry.c1).toBeUndefined()
  })
})
