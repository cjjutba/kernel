import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomSettings } from '@shared/types'

// KERNEL-249: run scripts in the renderer. Each script keeps its own lines and exit, the Run tab lists what is running, and a save shows at once.

vi.mock('../src/renderer/src/api', () => ({ call: vi.fn() }))
const { actions, apply, getState, scriptKey, setState } = await import('../src/renderer/src/store')
const { applyRunScripts } = await import('../src/renderer/src/screens/settings/useSettings')
const { pickerNames, runningRuns } = await import('../src/renderer/src/screens/workspace/runScripts')

const line = (name: string | undefined, text: string, kind: 'run' | 'setup' = 'run') => ({ kind, name, line: text, stream: 'stdout' as const })
const out = (name: string) => getState().scripts.w1.filter((l) => l.name === name).map((l) => l.line)

beforeEach(() => setState({ scripts: {}, scriptExit: {}, scriptUrl: {} }))

describe('scriptKey', () => {
  it('keeps setup and archive under their kind, the default run script under run and the others under run:<name>', () => {
    expect(scriptKey('setup')).toBe('setup')
    expect(scriptKey('archive')).toBe('archive')
    expect(scriptKey('run')).toBe('run')
    expect(scriptKey('run', 'run')).toBe('run')
    expect(scriptKey('run', 'frontend')).toBe('run:frontend')
  })

  it('does not mix a run script named setup with the setup script', () => {
    expect(scriptKey('run', 'setup')).toBe('run:setup')
    actions.workspaces.scriptExited('w1', 'run', 'setup', 0)
    expect(getState().scriptExit.w1).toEqual({ 'run:setup': 0 })
    actions.workspaces.scriptExited('w1', 'setup', undefined, 1)
    expect(getState().scriptExit.w1).toEqual({ 'run:setup': 0, setup: 1 })
    actions.workspaces.clearScriptExit('w1', 'run', 'setup')
    expect(getState().scriptExit.w1).toEqual({ 'run:setup': undefined, setup: 1 })
  })
})

describe('script.url', () => {
  it('keeps the URL each run script printed per workspace, and drops it when the push says null', () => {
    apply({ type: 'script.url', workspaceId: 'w1', name: 'run', url: 'http://localhost:4305' })
    apply({ type: 'script.url', workspaceId: 'w1', name: 'frontend', url: 'http://localhost:4306' })
    apply({ type: 'script.url', workspaceId: 'w2', name: 'run', url: 'http://localhost:4315' })
    expect(getState().scriptUrl).toEqual({ w1: { run: 'http://localhost:4305', frontend: 'http://localhost:4306' }, w2: { run: 'http://localhost:4315' } })
    apply({ type: 'script.url', workspaceId: 'w1', name: 'run', url: null })
    expect(getState().scriptUrl.w1).toEqual({ frontend: 'http://localhost:4306' })
  })
})

describe('script lines', () => {
  it('names a run line without a name run, and leaves setup lines unnamed', () => {
    actions.workspaces.appendScript('w1', line(undefined, 'a'))
    actions.workspaces.appendScript('w1', line(undefined, 'b', 'setup'))
    expect(getState().scripts.w1.map((l) => l.name)).toEqual(['run', undefined])
  })

  it("keeps 400 lines for each script, so a chatty one drops its own oldest line and nobody else's", () => {
    actions.workspaces.appendScript('w1', line('backend', 'b-first'))
    for (let i = 0; i < 401; i++) actions.workspaces.appendScript('w1', line('frontend', `f${i}`))
    actions.workspaces.appendScript('w1', line('backend', 'b-last'))
    expect(out('frontend')).toHaveLength(400)
    expect(out('frontend')[0]).toBe('f1')
    expect(out('frontend')[399]).toBe('f400')
    expect(out('backend')).toEqual(['b-first', 'b-last'])
  })

  it('counts a run script named setup apart from the setup script', () => {
    for (let i = 0; i < 400; i++) actions.workspaces.appendScript('w1', line('setup', `r${i}`))
    actions.workspaces.appendScript('w1', line(undefined, 'install', 'setup'))
    expect(getState().scripts.w1).toHaveLength(401)
  })
})

describe('the Run tab names', () => {
  const lines = (...names: string[]) => names.forEach((n) => actions.workspaces.appendScript('w1', line(n, 'x')))

  it('lists a script that is running, and not one that exited', () => {
    lines('frontend', 'backend')
    actions.workspaces.scriptExited('w1', 'run', 'backend', 0)
    expect(runningRuns(getState(), 'w1')).toEqual(['frontend'])
  })

  it("keeps a running script that Settings no longer lists, after the room's own", () => {
    lines('frontend')
    expect(pickerNames(['run', 'web'], runningRuns(getState(), 'w1'))).toEqual(['run', 'web', 'frontend'])
  })

  it("knows the default script is running before the room's settings load", () => {
    lines('run')
    expect(pickerNames([], runningRuns(getState(), 'w1'))).toEqual(['run'])
  })

  it('starts a script clean: clearing its exit brings it back', () => {
    lines('frontend')
    actions.workspaces.scriptExited('w1', 'run', 'frontend', 1)
    expect(runningRuns(getState(), 'w1')).toEqual([])
    actions.workspaces.clearScriptExit('w1', 'run', 'frontend')
    expect(runningRuns(getState(), 'w1')).toEqual(['frontend'])
  })

  it('does not take a finished setup for a run script', () => {
    actions.workspaces.appendScript('w1', line(undefined, 'install', 'setup'))
    expect(runningRuns(getState(), 'w1')).toEqual([])
  })
})

describe('applyRunScripts', () => {
  const list: RoomSettings['runScripts'] = [{ name: 'run', command: 'pnpm dev' }, { name: 'web', command: 'pnpm web' }, { name: 'api', command: 'pnpm api' }]
  const sources = (): RoomSettings['sources'] => ({ 'runScripts.run': 'override', 'runScripts.web': 'shared', 'runScripts.api': 'local' })

  it('adds a new script as a personal one', () => {
    const s = sources()
    expect(applyRunScripts(list, s, { docs: 'pnpm docs' }).map((r) => r.name)).toEqual(['run', 'web', 'api', 'docs'])
    expect(s['runScripts.docs']).toBe('local')
  })

  it('turns an edit of a shared script into an override', () => {
    const s = sources()
    expect(applyRunScripts(list, s, { web: 'pnpm web --host' }).find((r) => r.name === 'web')?.command).toBe('pnpm web --host')
    expect(s['runScripts.web']).toBe('override')
  })

  it('removing an override falls back to the shared source and keeps the script listed', () => {
    const s = sources()
    expect(applyRunScripts(list, s, { run: null }).map((r) => r.name)).toEqual(['run', 'web', 'api'])
    expect(s['runScripts.run']).toBe('shared')
  })

  it('removes a personal script, and an empty command counts as removing', () => {
    const s = sources()
    expect(applyRunScripts(list, s, { api: '' }).map((r) => r.name)).toEqual(['run', 'web'])
    expect(s['runScripts.api']).toBeUndefined()
  })

  it('leaves a script only settings.toml defines when asked to remove it', () => {
    const s = sources()
    expect(applyRunScripts(list, s, { web: null }).map((r) => r.name)).toEqual(['run', 'web', 'api'])
    expect(s['runScripts.web']).toBe('shared')
  })

  it('reads RUN as run, and keeps run first', () => {
    const s = sources()
    const next = applyRunScripts([{ name: 'web', command: 'pnpm web' }], s, { RUN: 'pnpm dev' })
    expect(next).toEqual([{ name: 'run', command: 'pnpm dev' }, { name: 'web', command: 'pnpm web' }])
    expect(s['runScripts.run']).toBe('override')
    expect(s['runScripts.RUN']).toBeUndefined()
  })
})
