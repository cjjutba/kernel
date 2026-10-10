import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, trustRoom } from './helpers'
import { git } from '../src/main/services/exec'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { BLOCK_STARTS, blocksOverlap, portBlock, runningRuns } from '../src/main/services/scripts'
import { configuredRemote, loadRepoSettings, saveRepoSettings } from '../src/main/services/settings'
import { listBranches } from '../src/main/services/worktrees'
import { fixtureHandlers } from '../src/main/fixtures'
import { fixtures } from '../fixtures'
import type { PushEvent } from '../src/shared/ipc'
import { PORT_BLOCK, type Workspace } from '../src/shared/types'

// A plain sh starts fast. A login zsh with a full profile, several at once, slows the other suites' timing (KERNEL-244).
process.env.SHELL = '/bin/sh'

const kai = { 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' }

/** Every `script.output` and `script.exit` while the test runs. */
const events: PushEvent[] = []
const record = (e: PushEvent) => { if (e.type === 'script.output' || e.type === 'script.exit') events.push(e) }
bus.on('push', record)
const kernels: Kernel[] = []
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop()
  events.length = 0
})

async function kernelOn(files: Record<string, string>, app: object = {}) {
  const repo = await tempRepo({ ...kai, ...files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...app }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  kernels.push(k)
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)
  // The repo brings its run scripts, which the user trusts before they run (KERNEL-209).
  await trustRoom(k, room.id)
  return { k, h: k.handlers(), room, repo }
}

const until = async (ok: () => boolean, what: string, ms = 15000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const printed = (ws: Workspace, name: string, line: string) => events.some((e) => e.type === 'script.output' && e.workspaceId === ws.id && e.name === name && e.line === line)
const exited = (ws: Workspace, name: string) => events.some((e) => e.type === 'script.exit' && e.workspaceId === ws.id && e.name === name)

const scripts = (toml: string) => ({ '.kernel/settings.toml': toml })
const LONG = 'echo started-$KERNEL_PORT; sleep 30'

describe('run scripts in .kernel/settings.toml (KERNEL-244)', () => {
  it('reads [run_scripts] in file order after run, and leaves out bad names, run and blank commands', async () => {
    const repo = await tempRepo({
      '.kernel/settings.toml': '[scripts]\nrun = "pnpm dev"\n\n[run_scripts]\nweb = "pnpm web"\napiServer = "pnpm api"\nrun = "ignored"\n"-bad" = "x"\nblank = " "\n',
      '.kernel/settings.local.toml': '[run_scripts]\nworker = "pnpm worker"\nweb = "pnpm web --mine"\n'
    })
    const rs = await loadRepoSettings(repo)
    expect(rs.runScripts).toEqual([
      { name: 'run', command: 'pnpm dev' }, { name: 'web', command: 'pnpm web --mine' }, { name: 'apiServer', command: 'pnpm api' }, { name: 'worker', command: 'pnpm worker' }
    ])
    expect(rs.sources).toMatchObject({ 'scripts.run': 'shared', 'runScripts.run': 'shared', 'runScripts.web': 'override', 'runScripts.apiServer': 'shared', 'runScripts.worker': 'local' })
  })

  it('a room with only [scripts] run has run alone, and one without has none', async () => {
    expect((await loadRepoSettings(await tempRepo(scripts('[scripts]\nrun = "pnpm dev"\n')))).runScripts).toEqual([{ name: 'run', command: 'pnpm dev' }])
    expect((await loadRepoSettings(await tempRepo())).runScripts).toEqual([])
  })

  it('saves a named script under its own name, run as [scripts] run, and refuses a bad name', async () => {
    const repo = await tempRepo()
    const rs = await saveRepoSettings(repo, { runScripts: { run: 'pnpm dev', apiServer: 'pnpm api', 'web-2': 'pnpm web' } }, true)
    expect(rs.runScripts.map((r) => r.name)).toEqual(['run', 'apiServer', 'web-2'])
    const text = await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')
    expect(text).toContain('apiServer = "pnpm api"')
    expect(text).not.toContain('api_server')
    expect(text).toMatch(/\[scripts\]\nrun = "pnpm dev"/)
    expect((await saveRepoSettings(repo, { runScripts: { apiServer: null, 'web-2': '  ' } }, true)).runScripts).toEqual([{ name: 'run', command: 'pnpm dev' }])
    // `RUN` and `Run` are the reserved `run`, not a second script.
    expect((await saveRepoSettings(repo, { runScripts: { RUN: 'pnpm start' } }, true)).runScripts).toEqual([{ name: 'run', command: 'pnpm start' }])
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nrun = "pnpm dev"\n\n[run_scripts]\nRun = "x"\nRUN = "y"\nweb = "pnpm web"\n')
    expect((await loadRepoSettings(repo)).runScripts.map((r) => r.name)).toEqual(['run', 'web'])
    await expect(saveRepoSettings(repo, { runScripts: { 'two words': 'x' } }, true)).rejects.toThrow('not a valid run script name')
    await expect(saveRepoSettings(repo, { runScripts: { ['a'.repeat(33)]: 'x' } }, true)).rejects.toThrow('not a valid run script name')
  })
})

describe('named run scripts (KERNEL-244)', () => {
  it('with only [scripts] run, Run and Stop work as before', async () => {
    const { k, h, room } = await kernelOn(scripts(`[scripts]\nrun = "${LONG}"\n`))
    const ws = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    await h['scripts.run']({ workspaceId: ws.id, kind: 'run' })
    await until(() => printed(ws, 'run', `started-${ws.port}`), 'run to start')
    expect(runningRuns(ws.id)).toEqual(['run'])
    await h['scripts.stop']({ workspaceId: ws.id, kind: 'run' })
    await until(() => exited(ws, 'run'), 'run to exit')
    expect(runningRuns(ws.id)).toEqual([])
    await expect(h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'web' })).rejects.toThrow('No run script named web')
  })

  it('run in parallel with their own output and exit, and stop one by one or all at once', async () => {
    const { k, h, room } = await kernelOn(scripts(`[scripts]\nrun = "${LONG}"\n\n[run_scripts]\nweb = "echo web-$KERNEL_PORT; sleep 30"\nonce = "echo once; exit 3"\n`))
    const ws = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    for (const name of ['run', 'web', 'once']) await h['scripts.run']({ workspaceId: ws.id, kind: 'run', name })
    await until(() => printed(ws, 'run', `started-${ws.port}`) && printed(ws, 'web', `web-${ws.port}`) && printed(ws, 'once', 'once'), 'all three to print')
    await until(() => exited(ws, 'once'), 'once to exit')
    expect(events.find((e) => e.type === 'script.exit' && e.name === 'once')).toMatchObject({ code: 3, kind: 'run' })
    expect(runningRuns(ws.id).sort()).toEqual(['run', 'web'])

    await h['scripts.stop']({ workspaceId: ws.id, kind: 'run', name: 'web' })
    await until(() => exited(ws, 'web'), 'web to exit')
    expect(runningRuns(ws.id)).toEqual(['run'])

    await h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'web' })
    await until(() => runningRuns(ws.id).length === 2, 'web to start again')
    await h['scripts.stop']({ workspaceId: ws.id, kind: 'run' })
    await until(() => runningRuns(ws.id).length === 0, 'every run script to stop')
  })

  it('a script that ignores SIGTERM still stops and reports its exit', async () => {
    const { k, h, room } = await kernelOn(scripts(`[run_scripts]\nstubborn = "trap '' TERM; echo ready; sleep 30"\n`))
    const ws = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    await h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'stubborn' })
    await until(() => printed(ws, 'stubborn', 'ready'), 'stubborn to start')
    const stopped = Date.now()
    await h['scripts.stop']({ workspaceId: ws.id, kind: 'run', name: 'stubborn' })
    await until(() => exited(ws, 'stubborn'), 'stubborn to exit')
    expect(Date.now() - stopped).toBeGreaterThanOrEqual(2500)
  })

  it('archive and quit stop every named script, and quit kills one that ignores SIGTERM at once', async () => {
    // `stubborn` prints the pid of a sleep that ignores SIGTERM, so the test can see that the process itself is gone.
    const stubborn = "trap '' TERM; sleep 30 & echo pid-$!; wait"
    const { k, h, room } = await kernelOn(scripts(`[scripts]\nrun = "${LONG}"\n\n[run_scripts]\nweb = "${LONG}"\nstubborn = "${stubborn}"\n`))
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    for (const ws of [a, b]) for (const name of ['run', 'web']) await h['scripts.run']({ workspaceId: ws.id, kind: 'run', name })
    await until(() => runningRuns(a.id).length === 2 && runningRuns(b.id).length === 2, 'four scripts to start')
    await k.archiveWorkspace(a.id)
    expect(runningRuns(a.id)).toEqual([])
    expect(runningRuns(b.id).sort()).toEqual(['run', 'web'])
    await h['scripts.run']({ workspaceId: b.id, kind: 'run', name: 'stubborn' })
    let pid = 0
    await until(() => {
      const line = events.find((e) => e.type === 'script.output' && e.workspaceId === b.id && e.name === 'stubborn' && /^pid-\d+$/.test(e.line))
      pid = line?.type === 'script.output' ? Number(line.line.slice(4)) : 0
      return pid > 0
    }, 'stubborn to print its pid')
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive()).toBe(true)
    await k.stop()
    kernels.splice(kernels.indexOf(k), 1)
    expect(runningRuns(b.id)).toEqual([])
    // Well inside the 3 seconds a plain stop waits before SIGKILL.
    await until(() => !alive(), 'the sleep that ignores SIGTERM to die', 1500)
  })
})

describe('run mode (KERNEL-244)', () => {
  const toml = (mode: string) => scripts(`[scripts]\nrun = "${LONG}"\nrun_mode = "${mode}"\n\n[run_scripts]\nweb = "${LONG}"\n`)

  it('One at a time stops the run scripts in the room\'s other workspaces', async () => {
    const { k, h, room } = await kernelOn(toml('single'))
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    await h['scripts.run']({ workspaceId: a.id, kind: 'run' })
    await h['scripts.run']({ workspaceId: a.id, kind: 'run', name: 'web' })
    await until(() => runningRuns(a.id).length === 2, 'both of a\'s scripts to start')
    await h['scripts.run']({ workspaceId: b.id, kind: 'run', name: 'web' })
    expect(runningRuns(a.id)).toEqual([])
    await until(() => exited(a, 'run') && exited(a, 'web'), 'a\'s scripts to exit')
    expect(runningRuns(b.id)).toEqual(['web'])
    // In its own workspace, a second script runs next to the first.
    await h['scripts.run']({ workspaceId: b.id, kind: 'run' })
    expect(runningRuns(b.id).sort()).toEqual(['run', 'web'])
  })

  it('Concurrent leaves them running', async () => {
    const { k, h, room } = await kernelOn(toml('concurrent'))
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    await h['scripts.run']({ workspaceId: a.id, kind: 'run' })
    await h['scripts.run']({ workspaceId: b.id, kind: 'run' })
    await until(() => printed(a, 'run', `started-${a.port}`) && printed(b, 'run', `started-${b.port}`), 'both to start')
    expect(runningRuns(a.id)).toEqual(['run'])
    expect(runningRuns(b.id)).toEqual(['run'])
  })

  it('applies to the run after setup too', async () => {
    const { k, room } = await kernelOn(toml('single'), { scripts: { setupOnCreate: true, runAfterSetup: true, archiveOnArchive: true } })
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    await until(() => runningRuns(a.id).length === 1, 'a\'s run to start after setup')
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    expect(runningRuns(a.id)).toEqual([])
    expect(runningRuns(b.id)).toEqual(['run'])
  })
})

describe('port blocks (KERNEL-244)', () => {
  const servers: Server[] = []
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)) })

  it('starts each block at a multiple of 10 from 4300, and a legacy 4312 blocks 4310 and 4320', async () => {
    const port = await portBlock(() => [4300, 4312], new Set())
    expect(port % PORT_BLOCK).toBe(0)
    expect(port).toBeGreaterThanOrEqual(4330)
    expect(blocksOverlap(4312, 4310)).toBe(true)
    expect(blocksOverlap(4312, 4320)).toBe(true)
    expect(blocksOverlap(4312, 4300)).toBe(false)
    expect(blocksOverlap(4312, 4330)).toBe(false)
  })

  it('skips a block when any of its 10 ports is in use', async () => {
    const first = await portBlock(() => [], new Set())
    const srv = createServer()
    await new Promise<void>((r) => srv.listen(first + 9, '127.0.0.1', () => r()))
    servers.push(srv)
    expect(await portBlock(() => [], new Set())).toBeGreaterThan(first)
  })

  it('never hands out the same block twice while the first is still reserved', async () => {
    const reserved = new Set<number>()
    const ports = await Promise.all([portBlock(() => [], reserved), portBlock(() => [], reserved), portBlock(() => [], reserved)])
    expect(new Set(ports).size).toBe(3)
    for (const a of ports) for (const b of ports) if (a !== b) expect(blocksOverlap(a, b)).toBe(false)
  })

  it('gives two workspaces created at once different blocks, and keeps clear of a legacy port', async () => {
    const { k, room } = await kernelOn({})
    const legacy = await k.createWorkspace(room.id, { prompt: 'old', agentId: 'kai', title: 'Old' })
    k.store.saveWorkspace({ ...legacy, port: 4312 })
    const [a, b] = await Promise.all([
      k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' }),
      k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    ])
    expect(blocksOverlap(a.port, b.port)).toBe(false)
    for (const ws of [a, b]) {
      expect(ws.port % PORT_BLOCK).toBe(0)
      expect(blocksOverlap(ws.port, 4312)).toBe(false)
    }
  })

  it('running out of ports leaves no worktree or branch behind', async () => {
    const { k, room, repo } = await kernelOn({})
    const reserved = (k as unknown as { reservedPorts: Set<number> }).reservedPorts
    for (const p of BLOCK_STARTS) reserved.add(p)
    await expect(k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })).rejects.toThrow('No free block of ports')
    expect((await git(repo, 'branch', '--format=%(refname:short)')).trim()).toBe('main')
    expect((await git(repo, 'worktree', 'list')).trim().split('\n')).toHaveLength(1)
    expect(k.store.workspaces(room.id)).toEqual([])
  })

  it('restore keeps the port unless another workspace took its block', async () => {
    const { k, room } = await kernelOn({})
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    await k.archiveWorkspace(a.id)
    expect((await k.restoreWorkspace(a.id)).port).toBe(a.port)
    await k.archiveWorkspace(a.id)
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    k.store.saveWorkspace({ ...b, port: a.port + 3 })
    const back = await k.restoreWorkspace(a.id)
    expect(blocksOverlap(back.port, a.port + 3)).toBe(false)
  })
})

describe('nits from the KERNEL-190 review (KERNEL-244)', () => {
  it('a whitespace-only text removes the key, so sources and PR instructions agree it is unset', async () => {
    const repo = await tempRepo()
    await saveRepoSettings(repo, { pr: { createInstructions: '# Mine' }, scripts: { setup: 'pnpm i' } })
    const rs = await saveRepoSettings(repo, { pr: { createInstructions: '  \n ' }, scripts: { setup: ' ' } })
    expect(rs.pr).toBeUndefined()
    expect(rs.scripts.setup).toBeUndefined()
    expect(rs.sources).toEqual({})
  })

  it("reading a room's settings refreshes its remote, as saving does", async () => {
    const { k, h, room, repo } = await kernelOn(scripts('[scripts]\nsetup = "true"\n'))
    const remotes = (k as unknown as { roomRemotes: Map<string, string | undefined> }).roomRemotes
    // Edited outside Kernel, so nothing has told it yet.
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[workspace]\nremote = "upstream"\n')
    expect(remotes.get(repo)).toBeUndefined()
    await h['settings.room']({ roomId: room.id })
    expect(remotes.get(repo)).toBe('upstream')
  })

  it('fixture mode: a null on an override path leaves the other file\'s value', async () => {
    const h = fixtureHandlers(structuredClone(fixtures.Workspace))
    const roomId = fixtures.Workspace.rooms[0].id
    await h['settings.setRoom']({ roomId, patch: { workspace: { remote: 'upstream' } }, shared: true })
    await h['settings.setRoom']({ roomId, patch: { workspace: { remote: 'fork' } } })
    expect((await h['settings.room']({ roomId })).sources['workspace.remote']).toBe('override')
    expect((await h['settings.setRoom']({ roomId, patch: { workspace: { remote: null } } })).sources['workspace.remote']).toBe('shared')
    await h['settings.setRoom']({ roomId, patch: { workspace: { remote: 'fork' } } })
    expect((await h['settings.setRoom']({ roomId, patch: { workspace: { remote: null } }, shared: true })).sources['workspace.remote']).toBe('local')
    // Only one file set it: removing it there drops it.
    expect((await h['settings.setRoom']({ roomId, patch: { workspace: { remote: null } } })).sources['workspace.remote']).toBeUndefined()
  })

  it('the branch list shows every remote until a remote is configured', async () => {
    const repo = await tempRepo()
    for (const name of ['origin', 'upstream']) {
      await git(repo, 'remote', 'add', name, await tempRepo())
      await git(repo, 'fetch', '-q', name)
    }
    expect(await listBranches(repo)).toEqual(expect.arrayContaining(['main', 'origin/main', 'upstream/main']))
    expect(await listBranches(repo, 'upstream')).not.toContain('origin/main')
    // The app's origin is its default, so only a room remote or another app remote narrows the list.
    expect(configuredRemote({ workspace: {} }, { workspace: { remote: 'origin' } as never })).toBeUndefined()
    expect(configuredRemote({ workspace: { remote: ' ' } }, { workspace: { remote: 'fork' } as never })).toBe('fork')
    expect(configuredRemote({ workspace: { remote: 'origin' } }, { workspace: { remote: 'fork' } as never })).toBe('origin')
  })

  it('git.branches lists every remote with no remote set, and the room remote once one is', async () => {
    const { h, room, repo } = await kernelOn({})
    for (const name of ['origin', 'upstream']) {
      await git(repo, 'remote', 'add', name, await tempRepo())
      await git(repo, 'fetch', '-q', name)
    }
    expect(await h['git.branches']({ roomId: room.id })).toEqual(expect.arrayContaining(['origin/main', 'upstream/main']))
    await h['settings.setRoom']({ roomId: room.id, patch: { workspace: { remote: 'upstream' } } })
    const narrowed = await h['git.branches']({ roomId: room.id })
    expect(narrowed).toContain('upstream/main')
    expect(narrowed).not.toContain('origin/main')
  })
})
