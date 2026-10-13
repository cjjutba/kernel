/// <reference path="../src/preload/index.d.ts" />
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNotImplemented } from '../src/shared/ipc'
import { Kernel, UNBUILT } from '../src/main/kernel'
import { fixtures } from '../fixtures'
import { fixtureHandlers, fixturePush } from '../src/main/fixtures'
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

  it('fixture mode answers the shared file channels from the fixture, empty without one (KERNEL-302)', async () => {
    const empty = fixtureHandlers(fixtures.Workspace)
    expect(await empty['shared.list']({})).toEqual([])
    expect(await empty['shared.thumb']({ sharedId: 'x', version: 1 })).toBeNull()
    const v = { n: 1, at: 1, file: 'a.html', mime: 'text/html', bytes: 4, sha256: 'x' }
    const file = (id: string, workspaceId: string, updatedAt: number) => ({ id, roomId: 'room-a', workspaceId, agentId: 'kai', source: `${id}.html`, title: id, kind: 'html' as const, versions: [v], createdAt: 1, updatedAt })
    const h = fixtureHandlers({ ...fixtures.Workspace, shared: [file('a', 'w1', 1), file('b', 'w2', 2)], sharedData: { a: { 1: { text: '<p>', thumb: 'data:image/png;base64,AA' } } } })
    expect((await h['shared.list']({ roomId: 'room-a' })).map((f) => f.id)).toEqual(['b', 'a'])
    expect((await h['shared.list']({ workspaceId: 'w1' })).map((f) => f.id)).toEqual(['a'])
    expect(await h['shared.read']({ sharedId: 'a', version: 1 })).toEqual({ kind: 'html', mime: 'text/html', text: '<p>' })
    expect(await h['shared.thumb']({ sharedId: 'a', version: 1 })).toBe('data:image/png;base64,AA')
    await expect(h['shared.read']({ sharedId: 'a', version: 2 })).rejects.toThrow()
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

  it('fixture mode answers env names and files only, with no value to reveal (KERNEL-247)', async () => {
    const h = fixtureHandlers({ ...fixtures.Workspace, env: { app: ['B', 'A'], rooms: { 'room-a': { names: ['TOKEN'], files: [{ path: '.env', missing: true }] } } } })
    expect(await h['env.get']({})).toEqual({ names: ['A', 'B'], files: [] })
    expect(await h['env.get']({ roomId: 'room-a' })).toEqual({ names: ['TOKEN'], files: [{ path: '.env', missing: true }] })
    await expect(h['env.reveal']({ roomId: 'room-a', name: 'TOKEN' })).rejects.toThrow('no values')
    expect(await fixtureHandlers(fixtures.Workspace)['env.get']({ roomId: 'room-a' })).toEqual({ names: [], files: [] })
  })

  it('fixture mode answers terminal.presets and opens a terminal tab with a preset (KERNEL-248)', async () => {
    const codex = { id: 'codex', name: 'Codex', command: 'codex', builtin: true, skipsPermissions: false }
    expect((await fixtureHandlers(fixtures.Workspace)['terminal.presets']()).map((p) => p.id)).toEqual(['claude', 'claude-skip', 'shell'])
    const h = fixtureHandlers({ ...fixtures.Workspace, terminalClis: [codex] })
    await h['settings.set']({ patch: { terminal: { custom: [{ id: 'logs', name: 'Dev server logs', command: 'tail -f logs/dev.log' }] } } })
    expect((await h['terminal.presets']()).map((p) => p.id)).toEqual(['claude', 'claude-skip', 'shell', 'codex', 'logs'])
    const workspaceId = fixtures.Workspace.workspaces[0].id
    expect(await h['chats.create']({ workspaceId, kind: 'terminal', preset: 'codex' })).toMatchObject({ kind: 'terminal', title: 'Terminal (codex)', terminal: { preset: 'codex', command: 'codex' } })
    expect((await h['chats.create']({ workspaceId })).terminal).toBeUndefined()
    await h['settings.set']({ patch: { terminal: { enabled: false } } })
    await expect(h['chats.create']({ workspaceId, kind: 'terminal' })).rejects.toThrow('Big terminal tabs are off')
  })

  it('serves app and room settings', async () => {
    const repo = await tempRepo({ 'README.md': '# r\n', '.kernel/settings.toml': '[scripts]\nsetup = "pnpm install"\n' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900) }))
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    await k.start()
    const h = k.handlers()
    expect((await h['settings.get']()).experimental.sharing).toBe(true)
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

  it('fixture mode answers with the URL one workspace\'s run script printed, and preview URLs round trip (KERNEL-246)', async () => {
    const f = structuredClone(fixtures.Workspace)
    const found = fixturePush(f).filter((e) => e.type === 'script.url')
    expect(found).toEqual([{ type: 'script.url', workspaceId: expect.any(String), name: 'run', url: 'http://localhost:4312' }])
    // Right after the line that printed it, as the engine pushes it.
    const push = fixturePush(f)
    const at = push.findIndex((e) => e.type === 'script.url')
    expect(push[at - 1]).toMatchObject({ type: 'script.output', workspaceId: found[0].workspaceId, lines: [{ line: 'Next.js ready on http://localhost:4312' }] })
    // An exit clears it.
    const ws = found[0].workspaceId
    expect(fixturePush({ ...f, push: [...f.push, { type: 'script.exit', workspaceId: ws, kind: 'run', code: 0 }] }).filter((e) => e.type === 'script.url').map((e) => e.type === 'script.url' && e.url))
      .toEqual(['http://localhost:4312', null])
    const h = fixtureHandlers(f)
    const roomId = f.rooms[0].id
    expect((await h['settings.room']({ roomId })).preview).toEqual({ urls: [] })
    const urls = [{ name: 'Web', url: 'http://localhost:$KERNEL_PORT' }, { name: 'API', url: 'http://localhost:$((KERNEL_PORT + 1))' }]
    const rs = await h['settings.setRoom']({ roomId, patch: { preview: { urls } } })
    expect(rs.preview.urls).toEqual(urls)
    expect(rs.sources['preview.urls']).toBe('local')
    expect((await h['settings.setRoom']({ roomId, patch: { preview: { urls: null } } })).preview.urls).toEqual([])
    // An empty list, or all blank rows, removes the key as in the engine.
    await h['settings.setRoom']({ roomId, patch: { preview: { urls } } })
    const blank = await h['settings.setRoom']({ roomId, patch: { preview: { urls: [{ name: '', url: ' ' }] } } })
    expect(blank.preview.urls).toEqual([])
    expect(blank.sources['preview.urls']).toBeUndefined()
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
    .filter((c) => c.length === 8 && c[0] !== 'Screen' && !c[0].startsWith('---'))

  it('lists every PNG in design/screens and every settings board fixture once, each with a route and a component file', () => {
    // KERNEL-680: a Settings fixture drawn on the settings canvas has its row with the board's PNG instead.
    const boards = Object.keys(JSON.parse(readFileSync('design/settings-redesign/boards.json', 'utf8')))
    const pngs = [...readdirSync('design/screens').filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)), ...boards]
    expect(rows.map((r) => r[0]).sort()).toEqual(pngs.sort())
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

  it('unfolding a chat also drops the ids its fold was saved under before threads', () => {
    actions.ui.foldChat('t1', true)
    actions.ui.foldChat('t2', true)
    actions.ui.foldChat('old-a', true)
    actions.ui.foldChat('t1', false, ['old-a', 'old-b'])
    expect(getState().ui.foldedChats).toEqual(['t2'])
    actions.ui.foldChat('t2', false)
  })

  it('forgets the last tab of a thread when the thread closes', () => {
    apply({ type: 'thread', thread: { id: 'tc', roomId: 'a', title: 'Closing', createdAt: 1 } })
    const tab = { id: 'tc1', workspaceId: 'lead-ws', title: 'tc1', kind: 'chat' as const, model: 'claude-opus-5-5' as const, effort: 'high' as const, plan: false, createdAt: 1, threadId: 'tc' }
    apply({ type: 'chat', chat: tab })
    actions.ui.openTab('lead-ws', 'tc1')
    expect(getState().lastTabs.tc).toBe('tc1')
    apply({ type: 'thread', thread: { id: 'tc', roomId: 'a', title: 'Closing', createdAt: 1, closedAt: 9 } })
    expect(getState().lastTabs.tc).toBeUndefined()
  })

  it('keeps the threads the thread push brings, closed ones too', () => {
    apply({ type: 'thread', thread: { id: 't1', roomId: 'a', title: 'Plan the login', createdAt: 1 } })
    apply({ type: 'thread', thread: { id: 't1', roomId: 'a', title: 'Plan the login', createdAt: 1, closedAt: 5 } })
    apply({ type: 'thread', thread: { id: 't2', roomId: 'a', title: 'Fix the build', createdAt: 2 } })
    expect(Object.keys(getState().threads)).toEqual(expect.arrayContaining(['t1', 't2']))
    expect(getState().threads.t1.closedAt).toBe(5)
  })

  it('remembers the last tab shown in each thread, and leaves it alone for file tabs', () => {
    const tab = (id: string, threadId?: string) => ({ id, workspaceId: 'lead-ws', title: id, kind: 'chat' as const, model: 'claude-opus-5-5' as const, effort: 'high' as const, plan: false, createdAt: 1, ...(threadId ? { threadId } : {}) })
    for (const c of [tab('a1', 't1'), tab('a2', 't1'), tab('b1', 't2')]) apply({ type: 'chat', chat: c })
    actions.ui.openTab('lead-ws', 'a2')
    actions.ui.openTab('lead-ws', 'b1')
    actions.ui.openTab('lead-ws', 'file:src/a.ts')
    expect(getState().lastTabs).toMatchObject({ t1: 'a2', t2: 'b1' })
    actions.ui.openTab('lead-ws', 'a1')
    expect(getState().lastTabs).toMatchObject({ t1: 'a1', t2: 'b1' })
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

  it('shows a toast main pushes (KERNEL-288)', () => {
    apply({ type: 'toast', toast: { title: 'Kernel reloaded' } })
    expect(getState().ui.toasts.at(-1)).toMatchObject({ title: 'Kernel reloaded' })
  })
})
