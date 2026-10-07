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
    for (const [channel, issue] of Object.entries(UNBUILT)) {
      const err = await h[channel]({}).then(() => null, (e: unknown) => e)
      expect(isNotImplemented(err), channel).toBe(true)
      expect((err as Error).message).toBe(`Not built yet: ${channel} (${issue})`)
    }
    k.store.db.close()
  })

  it('every unbuilt channel names an issue that is still to come', () => {
    const build = new Set(Array.from({ length: 21 }, (_, i) => `KERNEL-${i + 10}`))
    expect(Object.entries(UNBUILT).filter(([, issue]) => !build.has(issue))).toEqual([])
  })

  it('fixture mode answers the same channels as the kernel', async () => {
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')) })
    expect(Object.keys(fixtureHandlers(fixtures.Workspace)).sort()).toEqual(Object.keys(k.handlers()).sort())
    k.store.db.close()
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
    await k.stop()
  })
})

describe('docs/SCREENS.md', () => {
  const rows = readFileSync('docs/SCREENS.md', 'utf8').split('\n')
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((c) => c.length === 9 && c[0] !== 'Screen' && !c[0].startsWith('---'))

  it('lists all 119 screens, each with a route and a component file', () => {
    expect(rows).toHaveLength(119)
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
