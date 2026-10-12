import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '../src/shared/ipc'
import type { RoomSetupStep } from '../src/shared/types'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { exec } from '../src/main/services/exec'
import { ago, agoShort, roomState } from '../src/renderer/src/screens/rooms/roomInfo'
import { assertFreeFolder, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, installScripts, lockfileInstall, recentFolders, runsPackageInstall, seatStarterTeam } from '../src/main/services/rooms'
import { loadRepoSettings } from '../src/main/services/settings'
import { tempRepo, trustRoom } from './helpers'

const starter = join(__dirname, '..', 'docs', 'starter-agents')

async function kernel(settings: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), ...settings }))
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

  it("seats the picked starter agents, Theo too but not Kernel's own Rowan, and writes settings.toml once", async () => {
    const repo = await tempRepo()
    expect(await seatStarterTeam(starter, repo, ['kai', 'rowan', 'theo', 'nobody'])).toEqual(['kai', 'theo'])
    expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['kai.md', 'theo.md'])
    // A file the repo already has stays as it is.
    await writeFile(join(repo, '.claude', 'agents', 'noor.md'), '---\nname: noor\ndescription: Ours.\n---\nx\n')
    expect(await seatStarterTeam(starter, repo, ['kai', 'noor', 'ivy'])).toEqual(['ivy'])
    expect(await readFile(join(repo, '.claude', 'agents', 'noor.md'), 'utf8')).toContain('Ours.')
    expect(await ensureRepoSettings(repo)).toBe(true)
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[files]\ncopy = []\n')
    expect(await ensureRepoSettings(repo)).toBe(false)
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toBe('[files]\ncopy = []\n')
  })

  it('makes the lockfile\'s install the setup script, so new workspaces run it', async () => {
    const pnpm = await tempRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    expect(await ensureRepoSettings(pnpm)).toBe(true)
    expect((await loadRepoSettings(pnpm)).scripts.setup).toBe('pnpm install')
    // No package manager: nothing to install, so setup stays a commented example.
    const plain = await tempRepo()
    await ensureRepoSettings(plain)
    expect((await loadRepoSettings(plain)).scripts.setup).toBeUndefined()
  })

  it('picks the install and the run example from the stack, one install per language (KERNEL-444)', async () => {
    const stacks: [Record<string, string>, string, string][] = [
      [{ 'uv.lock': '', 'requirements.txt': '' }, 'uv sync', 'uv run uvicorn main:app --port $KERNEL_PORT'],
      [{ 'poetry.lock': '' }, 'poetry install', 'poetry run uvicorn main:app --port $KERNEL_PORT'],
      [{ 'requirements.txt': '' }, 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt', '.venv/bin/python -m uvicorn main:app --port $KERNEL_PORT'],
      [{ Gemfile: '', 'Gemfile.lock': '' }, 'bundle install', 'bin/rails server --port $KERNEL_PORT'],
      [{ 'mix.exs': '' }, 'mix deps.get', 'PORT=$KERNEL_PORT mix phx.server'],
      [{ 'composer.json': '{}' }, 'composer install', 'php -S localhost:$KERNEL_PORT -t public'],
      [{ 'Cargo.toml': '' }, 'cargo fetch', 'PORT=$KERNEL_PORT cargo run'],
      [{ 'go.mod': '' }, 'go mod download', 'PORT=$KERNEL_PORT go run .'],
      [{ 'package.json': '{}', 'yarn.lock': '' }, 'yarn install', 'yarn dev --port $KERNEL_PORT'],
      // A Rails app with a JS bundle installs both, JS last, and shows the Rails run example.
      [{ Gemfile: '', 'package.json': '{}', 'yarn.lock': '' }, 'bundle install && yarn install', 'bin/rails server --port $KERNEL_PORT']
    ]
    for (const [files, setup, run] of stacks) {
      const repo = await tempRepo(files)
      expect(await lockfileInstall(repo), setup).toBe(setup)
      await ensureRepoSettings(repo)
      expect((await loadRepoSettings(repo)).scripts.setup, setup).toBe(setup)
      expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain(`# run = ${JSON.stringify(run)}`)
    }
  })

  it("installs only what a checkout lacks, and says when an install runs the repo's own code (KERNEL-444)", async () => {
    const repo = await tempRepo({ 'composer.json': '{}', 'go.mod': 'module demo\n', 'package.json': '{}' })
    expect(await installCommand(repo)).toEqual({ command: 'composer install && go mod download && npm install', runsRepoCode: true })
    await mkdir(join(repo, 'vendor'))
    await mkdir(join(repo, 'node_modules'))
    // go mod download leaves nothing in the checkout, so it runs every time, and it runs nothing from the repo.
    expect(await installCommand(repo)).toEqual({ command: 'go mod download' })
    const js = await tempRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    await mkdir(join(js, 'node_modules'))
    expect(await installCommand(js)).toEqual({ reason: 'Already installed' })
    expect(await installCommand(await tempRepo())).toEqual({ reason: 'Nothing to install' })
  })

  it('refuses to clone into a folder that has files', async () => {
    const dir = await tempRepo()
    await expect(assertFreeFolder(dir)).rejects.toThrow('already exists and is not empty')
    await assertFreeFolder(join(dir, 'fresh'))
  })
})

describe('Kernel rooms', () => {
  it('the copy step names the first five files to copy and counts the rest (KERNEL-245)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n', '.gitignore': '*.env\n', '.kernel/settings.toml': '[files]\ncopy = ["*.env"]\n' })
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await writeFile(join(repo, `${n}.env`), 'X=1\n')
    const room = await k.createRoom({ source: 'folder', name: 'Env app', from: repo, team: ['kai'], autostart: false })
    expect((await setupDone(room.id)).find((s) => s.id === 'copy')).toMatchObject({ state: 'ok', detail: 'a.env, b.env, c.env, d.env, e.env and 2 more' })
    await k.stop()
  })

  it('creates a room from a folder, runs setup, then removes it without touching the folder', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n' })
    const done = (async () => { const room = await k.createRoom({ source: 'folder', name: 'Own app', desc: 'Nights', from: repo, team: ['kai'], autostart: false }); return { room, steps: await setupDone(room.id) } })()
    const { room, steps } = await done
    expect(room).toMatchObject({ name: 'Own app', kind: 'folder', path: repo })
    expect(steps.map((s) => [s.id, s.state])).toEqual([['clone', 'ok'], ['host', 'ok'], ['worktrees', 'ok'], ['install', 'ok'], ['copy', 'ok'], ['hooks', 'fail'], ['agents', 'ok']])
    expect(steps.find((s) => s.id === 'hooks')?.error).toContain('Check hooks')
    expect((await k.agents(room.id)).map((a) => a.id)).toEqual(['kernel-lead', 'kai'])
    expect(steps.find((s) => s.id === 'agents')).toMatchObject({ detail: 'Kai from .claude/agents, Rowan from Kernel' })
    expect(steps.find((s) => s.id === 'agents')?.brought).toBeUndefined()
    expect(await stat(join(repo, '.kernel', 'settings.toml'))).toBeTruthy()

    await expect(k.createRoom({ source: 'folder', name: 'Again', from: repo, team: [], autostart: false })).rejects.toThrow('already the room Own app')

    const hidden = await k.updateRoom(room.id, { hidden: true })
    expect(hidden.hidden).toBe(true)
    expect(k.store.room(room.id)?.hidden).toBe(true)

    await k.removeRoom(room.id, false)
    expect(k.store.room(room.id)).toBeUndefined()
    expect(await stat(join(repo, 'README.md'))).toBeTruthy()
    expect(await stat(join(repo, '.claude', 'agents', 'kai.md'))).toBeTruthy()
    await k.stop()
  })

  it('checks push access once the checkout has a remote, and Check again updates the step (KERNEL-460)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n' })
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await exec('git', ['init', '-q', '--bare', remote])
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    const room = await k.createRoom({ source: 'folder', name: 'Pushed app', from: repo, team: ['kai'], autostart: false })
    const steps = await setupDone(room.id)
    expect(steps.map((s) => s.id)).toEqual(['clone', 'host', 'worktrees', 'install', 'copy', 'hooks', 'push', 'agents'])
    expect(steps.find((s) => s.id === 'push')).toMatchObject({ state: 'ok', title: 'Check push access', detail: 'git can push to origin' })
    // Settings, Room, Git reads the same result without running it again.
    const first = await k.handlers()['rooms.pushCheck']({ roomId: room.id })
    expect(first).toMatchObject({ remote: 'origin', reach: { state: 'ok' }, push: { state: 'ok' } })
    expect(await k.handlers()['rooms.pushCheck']({ roomId: room.id })).toBe(first)

    // The remote goes away. Check again finds it and room setup's step turns into a warning, never a failure.
    await rm(remote, { recursive: true, force: true })
    const published: RoomSetupStep[][] = []
    const on = (e: PushEvent) => { if (e.type === 'room.setup' && e.roomId === room.id) published.push(e.steps) }
    bus.on('push', on)
    const again = await k.handlers()['rooms.pushCheck']({ roomId: room.id, recheck: true })
    bus.off('push', on)
    expect(again?.reach.state).toBe('fail')
    expect(published.map((p) => p.find((s) => s.id === 'push')?.state)).toEqual(['run', 'warn'])
    expect(published.at(-1)?.find((s) => s.id === 'push')).toMatchObject({ title: "Git can't reach origin", detail: 'Check your connection or VPN, then check again.', fix: { action: 'recheck' } })
    await k.stop()
  })

  it('has no push step or push check for a room with no remote (KERNEL-460)', async () => {
    const { k } = await kernel()
    const room = await k.createRoom({ source: 'folder', name: 'Local app', from: await tempRepo(), team: [], autostart: false })
    expect((await setupDone(room.id)).some((s) => s.id === 'push')).toBe(false)
    expect(await k.handlers()['rooms.pushCheck']({ roomId: room.id })).toBeNull()
    // A remote added later shows up on Settings, Room, Git without a Check again.
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await exec('git', ['init', '-q', '--bare', remote])
    await exec('git', ['-C', room.path, 'remote', 'add', 'origin', remote])
    expect(await k.handlers()['rooms.pushCheck']({ roomId: room.id })).toMatchObject({ remote: 'origin', push: { state: 'ok' } })
    await k.stop()
  })

  it('reads the code host after the checkout and saves it on the room, local with no GitHub remote (KERNEL-477)', async () => {
    const { k } = await kernel()
    const none = await k.createRoom({ source: 'folder', name: 'Shop', from: await tempRepo(), team: [], autostart: false })
    const steps = await setupDone(none.id)
    expect(steps.map((s) => s.id).slice(0, 3)).toEqual(['clone', 'host', 'worktrees'])
    expect(steps.find((s) => s.id === 'host')).toMatchObject({ state: 'ok', title: 'Code host', detail: 'Local, no GitHub remote. Kernel merges branches on this Mac.' })
    expect(k.store.room(none.id)?.host).toBe('local')

    // A remote that isn't GitHub is local too, and git alone checks the push.
    const repo = await tempRepo()
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await exec('git', ['init', '-q', '--bare', remote])
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    const other = await k.createRoom({ source: 'folder', name: 'Other', from: repo, team: [], autostart: false })
    const done = await setupDone(other.id)
    expect(k.store.room(other.id)?.host).toBe('local')
    expect(done.find((s) => s.id === 'push')).toMatchObject({ state: 'ok', detail: 'git can push to origin' })
    await k.stop()
  })

  it('detects the default branch when the request names none', async () => {
    const { k } = await kernel()
    const repo = await tempRepo()
    await exec('git', ['-C', repo, 'branch', '-m', 'master'])
    const room = await k.createRoom({ source: 'folder', name: 'Old repo', from: repo, baseBranch: '', team: [], autostart: false })
    await setupDone(room.id)
    expect(k.store.room(room.id)?.defaultBranch).toBe('master')
    await k.stop()
  })

  it('asks before turning a plain folder into a repo, and initializes git when told to, committing nothing (KERNEL-231)', async () => {
    const { k } = await kernel()
    const plain = await mkdtemp(join(tmpdir(), 'plain-'))
    await writeFile(join(plain, 'index.html'), '<p>hi</p>')
    await writeFile(join(plain, '.env'), 'SECRET=1\n')
    await expect(k.createRoom({ source: 'folder', name: 'Plain', from: plain, team: [], autostart: false })).rejects.toThrow('not a git repository')
    const wait = (async () => { const room = await k.createRoom({ source: 'folder', name: 'Plain', from: plain, team: ['kai'], autostart: false, initGit: true }); return { room, steps: await setupDone(room.id) } })()
    const { room, steps } = await wait
    expect((await exec('git', ['-C', plain, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main')
    expect((await exec('git', ['-C', plain, 'rev-parse', '--verify', '--quiet', 'HEAD'])).code).not.toBe(0)
    expect(steps.find((s) => s.id === 'clone')).toMatchObject({ state: 'ok', detail: expect.stringContaining('Make the first commit') })
    expect(room.defaultBranch).toBe('main')
    // Until the user commits, a new workspace says why it can't start.
    k.sessions.send = async () => ({ queued: false })
    await expect(k.workspaces.createWorkspace(room.id, { prompt: 'Go', title: 'Go', agentId: 'kai', mode: 'worktree' })).rejects.toThrow('has no commit yet')
    await k.stop()
  })

  it('refuses the home folder and a folder too big to initialize, and commits nothing (KERNEL-231)', async () => {
    const { k, home } = await kernel()
    await writeFile(join(home, 'notes.txt'), 'x')
    await expect(k.createRoom({ source: 'folder', name: 'Home', from: '~', team: [], autostart: false, initGit: true })).rejects.toThrow("home folder can't be a room")
    await expect(initGit(home, home)).rejects.toThrow("home folder can't be a room")
    expect(existsSync(join(home, '.git'))).toBe(false)
    const big = await mkdtemp(join(tmpdir(), 'big-'))
    await mkdir(join(big, 'node_modules', 'pkg'), { recursive: true })
    for (let i = 0; i < 5001; i += 500) await Promise.all(Array.from({ length: Math.min(500, 5001 - i) }, (_, j) => writeFile(join(big, 'node_modules', 'pkg', `f${i + j}.js`), '')))
    await expect(k.createRoom({ source: 'folder', name: 'Big', from: big, team: [], autostart: false, initGit: true })).rejects.toThrow('more than 5,000 files')
    expect(existsSync(join(big, '.git'))).toBe(false)
    expect(k.store.rooms()).toEqual([])
    await k.stop()
  })

  it('gives two rooms with the same name their own worktree folders, and keeps an older room in its old one (KERNEL-231)', async () => {
    const { k, home } = await kernel()
    k.sessions.send = async () => ({ queued: false })
    const agent = { '.claude/agents/kai.md': '---\nname: kai\ndescription: Builds.\n---\nHi' }
    const one = await k.addRoom(await tempRepo(agent), 'app')
    const two = await k.addRoom(await tempRepo(agent), 'app')
    const a = await k.workspaces.createWorkspace(one.id, { prompt: 'Go', title: 'Go', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    const b = await k.workspaces.createWorkspace(two.id, { prompt: 'Go', title: 'Go', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    expect(a.path.startsWith(join(home, 'wt', one.id) + '/')).toBe(true)
    expect(b.path.startsWith(join(home, 'wt', two.id) + '/')).toBe(true)
    // A room saved before KERNEL-231 has no folder of its own and keeps the slug of its name.
    const { worktreeDir: _dir, ...old } = k.store.room(one.id)!
    k.store.saveRoom({ ...old, name: 'Old app' })
    const c = await k.workspaces.createWorkspace(one.id, { prompt: 'More', title: 'More', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    expect(c.path.startsWith(join(home, 'wt', 'old-app') + '/')).toBe(true)
    expect(k.store.workspace(a.id)?.path).toBe(a.path)
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

  it('gives two workspaces created at once in one room their own branch and folder (KERNEL-231)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ '.claude/agents/kai.md': '---\nname: kai\ndescription: Builds.\n---\nHi' })
    const room = await k.addRoom(repo)
    k.sessions.send = async () => ({ queued: false })
    const make = () => k.workspaces.createWorkspace(room.id, { prompt: 'Same task', title: 'Same task', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    const [a, b] = await Promise.all([make(), make()])
    expect(a.branch).not.toBe(b.branch)
    expect(a.path).not.toBe(b.path)
    await k.stop()
  })
})

describe("a repo's install scripts wait for trust (KERNEL-260)", () => {
  const pkg = (postinstall: string, more: Record<string, string> = {}) => JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { postinstall, ...more } })

  /**
   * Runs `fn` with an `npm` first on the PATH that runs the root package.json's postinstall, as the real one does, so a test
   * can tell whether an install ran without a network or a registry. `more` puts other commands there too.
   */
  async function withFakeNpm<T>(fn: () => Promise<T>, more: Record<string, string> = {}): Promise<T> {
    const bin = await mkdtemp(join(tmpdir(), 'kernel-bin-'))
    await writeFile(join(bin, 'npm'), '#!/bin/sh\ncmd=$(sed -n \'s/.*"postinstall":"\\([^"]*\\)".*/\\1/p\' package.json)\n[ -n "$cmd" ] && sh -c "$cmd"\nexit 0\n', { mode: 0o755 })
    for (const [name, script] of Object.entries(more)) await writeFile(join(bin, name), script, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try { return await fn() } finally { process.env.PATH = path }
  }

  const start = async (files: Record<string, string>) => {
    const { k } = await kernel({ workspace: { baseRef: 'main' } })
    k.sessions.send = async () => ({ queued: false })
    k.sessions.release = () => undefined
    const repo = await tempRepo({ 'README.md': '# x\n', ...files })
    const room = await k.createRoom({ source: 'folder', name: 'Cloned app', from: repo, team: ['kai'], autostart: false })
    const steps = await setupDone(room.id)
    return { k, repo, room, steps, h: k.handlers() }
  }

  it('reads the install scripts of the root package.json, when a package install applies', async () => {
    const some = await tempRepo({ 'package.json': pkg('node setup.js', { prepare: 'husky', build: 'tsc', install: '', preinstall: 7 as unknown as string }) })
    expect(await installScripts(some)).toEqual([{ name: 'postinstall', command: 'node setup.js' }, { name: 'prepare', command: 'husky' }])
    expect(await installScripts(await tempRepo({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) }))).toEqual([])
    expect(await installScripts(await tempRepo({ 'package.json': 'not json' }))).toEqual([])
    // No package.json, so no package manager to run them.
    expect(await installScripts(await tempRepo())).toEqual([])
  })

  it('reads a setup script that installs packages, whatever the package manager or wrapper', () => {
    for (const s of ['pnpm install', 'npm ci', 'npm i --silent', 'yarn', 'yarn --frozen-lockfile', 'bun install', 'pnpm --filter app install', 'corepack pnpm install', 'cd app && npm install', 'FOO=1 sudo npm ci', 'bash -c "pnpm i"', 'make deps && yarn add left-pad']) expect(runsPackageInstall(s), s).toBe(true)
    for (const s of ['make setup', 'pnpm dev', 'npm run build', 'npm test', 'yarn build', 'yarn workspace app test', 'echo done', 'cp .env.example .env']) expect(runsPackageInstall(s), s).toBe(false)
    expect(runsPackageInstall('./bin/bootstrap', './bin/bootstrap')).toBe(true)
  })

  it('skips the install until the user trusts, holds the first workspace, then runs the install', async () => {
    await withFakeNpm(async () => {
      const { k, repo, room, steps, h } = await start({ 'package.json': pkg('touch ran.txt') })
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok', detail: "Skipped until you trust this repo's install scripts" })
      // The settings.toml Kernel wrote is not trusted on its own any more, since its setup script runs those install scripts.
      expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('setup = "npm install"')
      const trust = await h['rooms.scriptTrust']({ roomId: room.id })
      expect(trust).toMatchObject({ scripts: { setup: 'npm install' }, installScripts: [{ name: 'postinstall', command: 'touch ran.txt' }] })
      expect(existsSync(join(repo, 'ran.txt'))).toBe(false)

      // The first workspace waits in `trust`, and its setup runs nothing.
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'First' })
      expect(ws.status).toBe('trust')
      expect(existsSync(join(ws.path, 'ran.txt'))).toBe(false)
      expect(existsSync(join(repo, 'ran.txt'))).toBe(false)

      // Trusting releases the workspace and runs the install room setup skipped, in the background.
      await h['rooms.trust']({ roomId: room.id, hash: trust!.hash })
      await vi.waitFor(() => expect(existsSync(join(repo, 'ran.txt'))).toBe(true), { timeout: 15000 })
      await vi.waitFor(() => expect(existsSync(join(ws.path, 'ran.txt'))).toBe(true), { timeout: 15000 })
      expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
      // It runs once: a second release of the same room installs nothing more.
      await rm(join(repo, 'ran.txt'))
      await h['rooms.trust']({ roomId: room.id, hash: trust!.hash })
      await new Promise((r) => setTimeout(r, 300))
      expect(existsSync(join(repo, 'ran.txt'))).toBe(false)

      // A changed script asks again, and the new text is what the user reads.
      await writeFile(join(repo, 'package.json'), pkg('touch ran-2.txt'))
      expect(await h['rooms.scriptTrust']({ roomId: room.id })).toMatchObject({ installScripts: [{ name: 'postinstall', command: 'touch ran-2.txt' }] })
      await k.stop()
    })
  }, 90000)

  it("doesn't ask again once the install has run, when the setup script isn't an install", async () => {
    await withFakeNpm(async () => {
      const { k, repo, room, steps, h } = await start({ 'package.json': pkg('touch ran.txt'), '.kernel/settings.toml': '[scripts]\nsetup = "make setup"\n' })
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ detail: "Skipped until you trust this repo's install scripts" })
      const trust = await h['rooms.scriptTrust']({ roomId: room.id })
      expect(trust).toMatchObject({ scripts: { setup: 'make setup' }, installScripts: [{ name: 'postinstall' }] })
      await h['rooms.trust']({ roomId: room.id, hash: trust!.hash })
      await vi.waitFor(() => expect(existsSync(join(repo, 'ran.txt'))).toBe(true), { timeout: 15000 })
      // node_modules now exists, so the room has no install left to run, and the same text counts as trusted.
      await mkdir(join(repo, 'node_modules'))
      expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
      await k.stop()
    })
  }, 90000)

  it('keeps today\'s flow and hash for a repo with no install scripts', async () => {
    await withFakeNpm(async () => {
      const { k, repo, room, steps, h } = await start({ 'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }) })
      // Nothing to hold: the install step ran the install, and Kernel's own settings.toml is trusted as before.
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok' })
      expect(steps.find((s) => s.id === 'install')?.detail).not.toContain('Skipped')
      expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'First' })
      expect(ws.status).not.toBe('trust')
      expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('setup = "npm install"')
      await k.stop()
    })
  }, 90000)

  // Stands in for bundle install running the Gemfile, which is Ruby from the repo.
  const bundle = { bundle: '#!/bin/sh\ntouch ran.txt\n' }

  it("holds an install that runs the repo's own code until the user trusts it, then runs it (KERNEL-444)", async () => {
    await withFakeNpm(async () => {
      const { k, repo, room, steps, h } = await start({ Gemfile: 'source "https://rubygems.org"\n' })
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok', detail: "Skipped until you trust this repo's scripts" })
      // Kernel wrote the setup script, but it runs the Gemfile, so it isn't trusted on its own.
      const trust = await h['rooms.scriptTrust']({ roomId: room.id })
      expect(trust).toMatchObject({ scripts: { setup: 'bundle install' } })
      expect(existsSync(join(repo, 'ran.txt'))).toBe(false)
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'First' })
      expect(ws.status).toBe('trust')

      await h['rooms.trust']({ roomId: room.id, hash: trust!.hash })
      await vi.waitFor(() => expect(existsSync(join(repo, 'ran.txt'))).toBe(true), { timeout: 15000 })
      // The workspace's setup runs in the login shell, which doesn't see the fake bundle, so the release is what shows.
      await vi.waitFor(() => expect(k.store.workspace(ws.id)?.status).not.toBe('trust'), { timeout: 15000 })
      await k.stop()
    }, bundle)
  }, 90000)

  it("leaves that install to the user when the repo's own settings have nothing to trust (KERNEL-444)", async () => {
    await withFakeNpm(async () => {
      const { k, repo, room, steps, h } = await start({ Gemfile: '', '.kernel/settings.toml': '# Nothing to run.\n' })
      // Nothing would ever ask, so holding it would hold it for good.
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok', detail: "Skipped: bundle install runs this repo's code, so run it yourself if you trust it" })
      expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
      expect(existsSync(join(repo, 'ran.txt'))).toBe(false)
      await k.stop()
    }, bundle)
  }, 90000)

  it('runs go mod download without asking, since it runs nothing from the repo (KERNEL-444)', async () => {
    await withFakeNpm(async () => {
      const { k, repo, room, steps, h } = await start({ 'go.mod': 'module demo\n' })
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok' })
      expect(steps.find((s) => s.id === 'install')?.detail).not.toContain('Skipped')
      expect(existsSync(join(repo, 'ran.txt'))).toBe(true)
      expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
      await k.stop()
    }, { go: '#!/bin/sh\ntouch ran.txt\n' })
  }, 90000)

  it("doesn't ask about package.json again once node_modules exists, though bundle install runs every time (KERNEL-444)", async () => {
    await withFakeNpm(async () => {
      const { k, repo, room, h } = await start({ 'package.json': pkg('touch ran.txt'), Gemfile: '', '.kernel/settings.toml': '[scripts]\nsetup = "make setup"\n' })
      await trustRoom(k, room.id)
      await vi.waitFor(() => expect(existsSync(join(repo, 'ran.txt'))).toBe(true), { timeout: 15000 })
      await mkdir(join(repo, 'node_modules'))
      // Only a JS install runs package.json's install scripts, and none is left to run, so a changed one asks nothing.
      await writeFile(join(repo, 'package.json'), pkg('touch ran-2.txt'))
      expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
      await k.stop()
    }, { bundle: '#!/bin/sh\nexit 0\n' })
  }, 90000)
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
