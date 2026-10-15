import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '../src/shared/ipc'
import type { ProjectSetupStep } from '../src/shared/types'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { exec } from '../src/main/services/exec'
import { ago, agoShort, projectState, teamOf } from '../src/renderer/src/screens/projects/projectInfo'
import { assertFreeFolder, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, lockfileInstall, recentFolders, seatStarterTeam } from '../src/main/services/projects'
import { loadRepoSettings } from '../src/main/services/settings'
import { tempRepo, freePort } from './helpers'

const starter = join(__dirname, '..', 'docs', 'starter-agents')

/** A Kernel in new folders, or, with `dirs`, again on the folders of one that stopped, as after a restart. */
async function kernel(settings: Record<string, unknown> = {}, dirs?: { dataDir: string; home: string }) {
  const dataDir = dirs?.dataDir ?? await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = dirs?.home ?? await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), ...settings }))
  const k = new Kernel({ dataDir, home, starterDir: starter, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  return { k, home, dataDir }
}

/**
 * Resolves with the last `project.setup` steps once none is running, and none is waiting unless the checkout failed, since
 * the steps after a failed checkout never run.
 */
function setupDone(projectId: string): Promise<ProjectSetupStep[]> {
  return new Promise((resolve) => {
    const on = (e: PushEvent) => {
      const cloneFailed = e.type === 'project.setup' && e.steps.some((s) => s.id === 'clone' && s.state === 'fail')
      if (e.type !== 'project.setup' || e.projectId !== projectId || e.steps.some((s) => s.state === 'run' || (s.state === 'wait' && !cloneFailed))) return
      bus.off('push', on)
      resolve(e.steps)
    }
    bus.on('push', on)
  })
}

describe('projects service', () => {
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

  it('lists project folders that are not projects yet, and expands ~', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    await mkdir(join(home, 'Projects', 'one'), { recursive: true })
    await mkdir(join(home, 'Projects', 'two'), { recursive: true })
    await mkdir(join(home, 'Projects', '.hidden'), { recursive: true })
    const list = await recentFolders([join(home, 'Projects', 'one')], home)
    expect(list.map((f) => f.path)).toEqual([join(home, 'Projects', 'two')])
    expect(expandHome('~/Projects/x', home)).toBe(join(home, 'Projects', 'x'))
  })

  it("seats the picked starter agents, Theo too but not Kernel, and writes settings.toml once", async () => {
    const repo = await tempRepo()
    expect(await seatStarterTeam(starter, repo, ['kai', 'kernel', 'theo', 'nobody'])).toEqual(['kai', 'theo'])
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

  it('writes no script for a new project, only commented examples, and leaves a file the repo has alone (KERNEL-682)', async () => {
    const pnpm = await tempRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    expect(await ensureRepoSettings(pnpm)).toBe(true)
    const settings = await loadRepoSettings(pnpm)
    expect(settings.scripts).toEqual({})
    expect(settings.runScripts).toEqual([])
    expect(await readFile(join(pnpm, '.kernel', 'settings.toml'), 'utf8')).toContain('# setup = "pnpm install"')
    const own = '[scripts]\nsetup = "make deps"\n'
    const has = await tempRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '', '.kernel/settings.toml': own })
    expect(await ensureRepoSettings(has)).toBe(false)
    expect(await readFile(join(has, '.kernel', 'settings.toml'), 'utf8')).toBe(own)
  })

  it('picks the install and the commented examples from the stack, one install per language (KERNEL-444)', async () => {
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
      expect((await loadRepoSettings(repo)).scripts.setup, setup).toBeUndefined()
      const text = await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')
      expect(text).toContain(`# setup = ${JSON.stringify(setup)}`)
      expect(text).toContain(`# run = ${JSON.stringify(run)}`)
    }
  })

  it('installs only what a checkout lacks (KERNEL-444)', async () => {
    const repo = await tempRepo({ 'composer.json': '{}', 'go.mod': 'module demo\n', 'package.json': '{}' })
    expect(await installCommand(repo)).toEqual({ command: 'composer install && go mod download && npm install' })
    await mkdir(join(repo, 'vendor'))
    await mkdir(join(repo, 'node_modules'))
    // go mod download leaves nothing in the checkout, so it runs every time.
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

describe('Kernel projects', () => {
  it('the copy step names the first five files to copy and counts the rest (KERNEL-245)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n', '.gitignore': '*.env\n', '.kernel/settings.toml': '[files]\ncopy = ["*.env"]\n' })
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await writeFile(join(repo, `${n}.env`), 'X=1\n')
    const project = await k.createProject({ source: 'folder', name: 'Env app', from: repo, team: ['kai'], autostart: false })
    expect((await setupDone(project.id)).find((s) => s.id === 'copy')).toMatchObject({ state: 'ok', detail: 'a.env, b.env, c.env, d.env, e.env and 2 more' })
    await k.stop()
  })

  it('creates a project from a folder, runs setup, then removes it without touching the folder', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n' })
    const done = (async () => { const project = await k.createProject({ source: 'folder', name: 'Own app', desc: 'Nights', from: repo, team: ['kai'], autostart: false }); return { project, steps: await setupDone(project.id) } })()
    const { project, steps } = await done
    expect(project).toMatchObject({ name: 'Own app', kind: 'folder', path: repo })
    expect(steps.map((s) => [s.id, s.state])).toEqual([['clone', 'ok'], ['host', 'ok'], ['worktrees', 'ok'], ['install', 'ok'], ['copy', 'ok'], ['hooks', 'fail'], ['agents', 'ok']])
    expect(steps.find((s) => s.id === 'hooks')?.error).toContain('Check hooks')
    expect((await k.agents(project.id)).map((a) => a.id)).toEqual(['kernel-lead', 'kai'])
    expect(steps.find((s) => s.id === 'agents')).toMatchObject({ detail: 'Kai from .claude/agents, Kernel leads' })
    expect(steps.find((s) => s.id === 'agents')?.brought).toBeUndefined()
    expect(await stat(join(repo, '.kernel', 'settings.toml'))).toBeTruthy()

    await expect(k.createProject({ source: 'folder', name: 'Again', from: repo, team: [], autostart: false })).rejects.toThrow('already the project Own app')

    const hidden = await k.updateProject(project.id, { hidden: true })
    expect(hidden.hidden).toBe(true)
    expect(k.store.project(project.id)?.hidden).toBe(true)

    await k.removeProject(project.id, false)
    expect(k.store.project(project.id)).toBeUndefined()
    expect(await stat(join(repo, 'README.md'))).toBeTruthy()
    expect(await stat(join(repo, '.claude', 'agents', 'kai.md'))).toBeTruthy()
    await k.stop()
  })

  it('tries a failed setup again from the failed step, one try at a time, and refuses once the project is set up (KERNEL-876)', async () => {
    const { k } = await kernel()
    const project = await k.createProject({ source: 'folder', name: 'Retry app', from: await tempRepo(), team: ['kai'], autostart: false })
    expect((await setupDone(project.id)).find((s) => s.id === 'hooks')?.state).toBe('fail')
    await k.handlers()['hooks.install']({ port: (await k.hooks.hooksStatus()).port })

    const published: ProjectSetupStep[][] = []
    const on = (e: PushEvent) => { if (e.type === 'project.setup' && e.projectId === project.id) published.push(e.steps) }
    bus.on('push', on)
    const done = setupDone(project.id)
    await k.handlers()['projects.retrySetup']({ projectId: project.id })
    await expect(k.handlers()['projects.retrySetup']({ projectId: project.id })).rejects.toThrow('Retry app is still being set up.')
    const steps = await done
    bus.off('push', on)

    // The failed step and the ones after it go back to waiting, and only they run again.
    expect(published[0].map((s) => [s.id, s.state])).toEqual([['clone', 'ok'], ['host', 'ok'], ['worktrees', 'ok'], ['install', 'ok'], ['copy', 'ok'], ['hooks', 'wait'], ['agents', 'wait']])
    expect([...new Set(published.flatMap((p) => p.filter((s) => s.state === 'run').map((s) => s.id)))]).toEqual(['hooks', 'agents'])
    expect(steps.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
    expect(steps.find((s) => s.id === 'hooks')?.error).toBeUndefined()
    // The starter agents the first try seated are still Kernel's, not agents the repo brought.
    expect(steps.find((s) => s.id === 'agents')).toMatchObject({ detail: 'Kai from .claude/agents, Kernel leads' })
    expect(steps.find((s) => s.id === 'agents')?.brought).toBeUndefined()

    await expect(k.handlers()['projects.retrySetup']({ projectId: project.id })).rejects.toThrow('Retry app is already set up.')
    await k.stop({ budgetMs: 0 })
  })

  it('keeps a step failed with the new reason when it fails again, and lets it be tried once more (KERNEL-876)', async () => {
    const { k } = await kernel()
    const project = await k.createProject({ source: 'folder', name: 'Stuck app', from: await tempRepo(), team: [], autostart: false })
    expect((await setupDone(project.id)).find((s) => s.id === 'hooks')?.error).toContain('Check hooks')
    const status = vi.spyOn(k.hooks, 'hooksStatus').mockRejectedValueOnce(new Error('Claude settings could not be read.'))
    const done = setupDone(project.id)
    k.projects.retrySetup(project.id)
    expect((await done).find((s) => s.id === 'hooks')).toMatchObject({ state: 'fail', error: 'Claude settings could not be read.' })
    status.mockRestore()
    // Nothing finished, so Try again is still there.
    const again = setupDone(project.id)
    k.projects.retrySetup(project.id)
    expect((await again).find((s) => s.id === 'hooks')).toMatchObject({ state: 'fail', error: expect.stringContaining('Check hooks') })
    await k.stop({ budgetMs: 0 })
  })

  /**
   * Runs `fn` with a `gh` first on the PATH whose first `gh repo clone` leaves a partial folder and fails, and whose later
   * ones clone `src`. Returns how many clones it was asked for.
   */
  async function withFlakyClone(src: string, fn: () => Promise<void>): Promise<number> {
    const bin = await mkdtemp(join(tmpdir(), 'kernel-bin-'))
    const count = join(bin, 'count')
    await writeFile(join(bin, 'gh'), [
      '#!/bin/sh',
      '[ "$1 $2" = "repo clone" ] || exit 1',
      `n=$(cat "${count}" 2>/dev/null || echo 0); echo $((n + 1)) > "${count}"`,
      'if [ "$n" = 0 ]; then mkdir -p "$4"; echo half > "$4/half.txt"; echo "fatal: early EOF" >&2; exit 128; fi',
      `exec git clone -q "${src}" "$4"`
    ].join('\n') + '\n', { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try { await fn() } finally { process.env.PATH = path }
    return Number((await readFile(count, 'utf8').catch(() => '0')).trim())
  }

  it('clears what a failed clone left in the folder Kernel made, and the retry clones into it (KERNEL-883)', async () => {
    const { k, home } = await kernel()
    const src = await tempRepo({ 'README.md': '# x\n' })
    const clones = await withFlakyClone(src, async () => {
      const project = await k.createProject({ source: 'repo', name: 'Clone app', from: 'me/clone-app', cloneTo: join(home, 'Projects', 'clone-app'), team: ['kai'], autostart: false })
      const first = await setupDone(project.id)
      expect(first.find((s) => s.id === 'clone')).toMatchObject({ state: 'fail', error: expect.stringContaining('early EOF') })
      expect(existsSync(join(project.path, 'half.txt'))).toBe(true)

      const done = setupDone(project.id)
      k.projects.retrySetup(project.id)
      const steps = await done
      expect(steps.find((s) => s.id === 'clone')).toMatchObject({ state: 'ok' })
      expect(existsSync(join(project.path, 'half.txt'))).toBe(false)
      expect(await readFile(join(project.path, 'README.md'), 'utf8')).toBe('# x\n')
    })
    expect(clones).toBe(2)
    await k.stop({ budgetMs: 0 })
  })

  it('never clears a folder that was there before setup, and says why the retry stops (KERNEL-883)', async () => {
    const { k, home } = await kernel()
    const picked = join(home, 'Picked')
    await mkdir(picked)
    const clones = await withFlakyClone(await tempRepo(), async () => {
      const project = await k.createProject({ source: 'repo', name: 'Picked app', from: 'me/picked-app', cloneTo: picked, team: ['kai'], autostart: false })
      expect((await setupDone(project.id)).find((s) => s.id === 'clone')?.state).toBe('fail')

      const done = setupDone(project.id)
      k.projects.retrySetup(project.id)
      expect((await done).find((s) => s.id === 'clone')).toMatchObject({ state: 'fail', error: '~/Picked is not empty, and Kernel didn\'t make it, so Kernel leaves it as it is. Empty it, then try again.' })
    })
    expect(clones).toBe(1)
    expect(await readFile(join(picked, 'half.txt'), 'utf8')).toBe('half\n')
    await k.stop({ budgetMs: 0 })
  })

  it('tries a setup that failed before a restart again after it (KERNEL-883)', async () => {
    const first = await kernel()
    const project = await first.k.createProject({ source: 'folder', name: 'Restart app', from: await tempRepo(), team: ['kai'], autostart: false })
    expect((await setupDone(project.id)).find((s) => s.id === 'hooks')?.state).toBe('fail')
    await first.k.stop({ budgetMs: 0 })

    const { k } = await kernel({}, first)
    await k.handlers()['hooks.install']({ port: (await k.hooks.hooksStatus()).port })
    // A window that loads asks for the projects, and gets the failed setup on the events Project setup reads.
    const published: ProjectSetupStep[][] = []
    const on = (e: PushEvent) => { if (e.type === 'project.setup' && e.projectId === project.id) published.push(e.steps) }
    bus.on('push', on)
    await k.handlers()['projects.list'](undefined)
    bus.off('push', on)
    expect(published.at(-1)?.find((s) => s.id === 'hooks')).toMatchObject({ state: 'fail', error: expect.stringContaining('Check hooks') })

    const done = setupDone(project.id)
    await k.handlers()['projects.retrySetup']({ projectId: project.id })
    const steps = await done
    expect(steps.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
    // The starter agents the first launch seated are still Kernel's.
    expect(steps.find((s) => s.id === 'agents')?.brought).toBeUndefined()
    await k.stop({ budgetMs: 0 })

    // Finished, it is no longer saved, so the next launch has nothing to try again.
    const { k: third } = await kernel({}, first)
    await expect(third.handlers()['projects.retrySetup']({ projectId: project.id })).rejects.toThrow('Restart app has no setup to try again.')
    await third.stop({ budgetMs: 0 })
  })

  it('fails the step a quit cut short, so it can be tried again (KERNEL-883)', async () => {
    const first = await kernel()
    const project = await first.k.addProject(await tempRepo())
    const step = (id: ProjectSetupStep['id'], state: ProjectSetupStep['state']): ProjectSetupStep => ({ id, title: id, detail: '', state })
    first.k.store.saveMeta('projectSetups', { [project.id]: { steps: [step('clone', 'ok'), step('host', 'ok'), step('worktrees', 'run'), step('install', 'wait')], req: { source: 'folder', name: project.name, from: project.path, team: [], autostart: false } } })
    await first.k.stop({ budgetMs: 0 })

    const { k } = await kernel({}, first)
    const published: ProjectSetupStep[][] = []
    const on = (e: PushEvent) => { if (e.type === 'project.setup' && e.projectId === project.id) published.push(e.steps) }
    bus.on('push', on)
    await k.handlers()['projects.list'](undefined)
    bus.off('push', on)
    expect(published.at(-1)?.map((s) => [s.id, s.state, s.error])).toEqual([['clone', 'ok', undefined], ['host', 'ok', undefined], ['worktrees', 'fail', 'Setup stopped when Kernel quit.'], ['install', 'wait', undefined]])
    await k.stop({ budgetMs: 0 })
  })

  it('checks push access once the checkout has a remote, and Check again updates the step (KERNEL-460)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n' })
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await exec('git', ['init', '-q', '--bare', remote])
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    const project = await k.createProject({ source: 'folder', name: 'Pushed app', from: repo, team: ['kai'], autostart: false })
    const steps = await setupDone(project.id)
    expect(steps.map((s) => s.id)).toEqual(['clone', 'host', 'worktrees', 'install', 'copy', 'hooks', 'push', 'agents'])
    expect(steps.find((s) => s.id === 'push')).toMatchObject({ state: 'ok', title: 'Check push access', detail: 'git can push to origin' })
    // Settings, Project, Git reads the same result without running it again.
    const first = await k.handlers()['projects.pushCheck']({ projectId: project.id })
    expect(first).toMatchObject({ remote: 'origin', reach: { state: 'ok' }, push: { state: 'ok' } })
    expect(await k.handlers()['projects.pushCheck']({ projectId: project.id })).toBe(first)

    // The remote goes away. Check again finds it and project setup's step turns into a warning, never a failure.
    await rm(remote, { recursive: true, force: true })
    const published: ProjectSetupStep[][] = []
    const on = (e: PushEvent) => { if (e.type === 'project.setup' && e.projectId === project.id) published.push(e.steps) }
    bus.on('push', on)
    const again = await k.handlers()['projects.pushCheck']({ projectId: project.id, recheck: true })
    bus.off('push', on)
    expect(again?.reach.state).toBe('fail')
    expect(published.map((p) => p.find((s) => s.id === 'push')?.state)).toEqual(['run', 'warn'])
    expect(published.at(-1)?.find((s) => s.id === 'push')).toMatchObject({ title: "Git can't reach origin", detail: 'Check your connection or VPN, then check again.', fix: { action: 'recheck' } })
    await k.stop()
  })

  it('has no push step or push check for a project with no remote (KERNEL-460)', async () => {
    const { k } = await kernel()
    const project = await k.createProject({ source: 'folder', name: 'Local app', from: await tempRepo(), team: [], autostart: false })
    expect((await setupDone(project.id)).some((s) => s.id === 'push')).toBe(false)
    expect(await k.handlers()['projects.pushCheck']({ projectId: project.id })).toBeNull()
    // A remote added later shows up on Settings, Project, Git without a Check again.
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await exec('git', ['init', '-q', '--bare', remote])
    await exec('git', ['-C', project.path, 'remote', 'add', 'origin', remote])
    expect(await k.handlers()['projects.pushCheck']({ projectId: project.id })).toMatchObject({ remote: 'origin', push: { state: 'ok' } })
    await k.stop()
  })

  it('reads the code host after the checkout and saves it on the project, local with no GitHub remote (KERNEL-477)', async () => {
    const { k } = await kernel()
    const none = await k.createProject({ source: 'folder', name: 'Shop', from: await tempRepo(), team: [], autostart: false })
    const steps = await setupDone(none.id)
    expect(steps.map((s) => s.id).slice(0, 3)).toEqual(['clone', 'host', 'worktrees'])
    expect(steps.find((s) => s.id === 'host')).toMatchObject({ state: 'ok', title: 'Code host', detail: 'Local, no GitHub remote. Kernel merges branches on this Mac.' })
    expect(k.store.project(none.id)?.host).toBe('local')

    // A remote that isn't GitHub is local too, and git alone checks the push.
    const repo = await tempRepo()
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await exec('git', ['init', '-q', '--bare', remote])
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    const other = await k.createProject({ source: 'folder', name: 'Other', from: repo, team: [], autostart: false })
    const done = await setupDone(other.id)
    expect(k.store.project(other.id)?.host).toBe('local')
    expect(done.find((s) => s.id === 'push')).toMatchObject({ state: 'ok', detail: 'git can push to origin' })
    await k.stop()
  })

  it('detects the default branch when the request names none', async () => {
    const { k } = await kernel()
    const repo = await tempRepo()
    await exec('git', ['-C', repo, 'branch', '-m', 'master'])
    const project = await k.createProject({ source: 'folder', name: 'Old repo', from: repo, baseBranch: '', team: [], autostart: false })
    await setupDone(project.id)
    expect(k.store.project(project.id)?.defaultBranch).toBe('master')
    await k.stop()
  })

  it('asks before turning a plain folder into a repo, and initializes git when told to, committing nothing (KERNEL-231)', async () => {
    const { k } = await kernel()
    const plain = await mkdtemp(join(tmpdir(), 'plain-'))
    await writeFile(join(plain, 'index.html'), '<p>hi</p>')
    await writeFile(join(plain, '.env'), 'SECRET=1\n')
    await expect(k.createProject({ source: 'folder', name: 'Plain', from: plain, team: [], autostart: false })).rejects.toThrow('not a git repository')
    const wait = (async () => { const project = await k.createProject({ source: 'folder', name: 'Plain', from: plain, team: ['kai'], autostart: false, initGit: true }); return { project, steps: await setupDone(project.id) } })()
    const { project, steps } = await wait
    expect((await exec('git', ['-C', plain, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main')
    expect((await exec('git', ['-C', plain, 'rev-parse', '--verify', '--quiet', 'HEAD'])).code).not.toBe(0)
    expect(steps.find((s) => s.id === 'clone')).toMatchObject({ state: 'ok', detail: expect.stringContaining('Make the first commit') })
    expect(project.defaultBranch).toBe('main')
    // Until the user commits, a new workspace says why it can't start.
    k.sessions.send = async () => ({ queued: false })
    await expect(k.workspaces.createWorkspace(project.id, { prompt: 'Go', title: 'Go', agentId: 'kai', mode: 'worktree' })).rejects.toThrow('has no commit yet')
    await k.stop()
  })

  it('refuses the home folder and a folder too big to initialize, and commits nothing (KERNEL-231)', async () => {
    const { k, home } = await kernel()
    await writeFile(join(home, 'notes.txt'), 'x')
    await expect(k.createProject({ source: 'folder', name: 'Home', from: '~', team: [], autostart: false, initGit: true })).rejects.toThrow("home folder can't be a project")
    await expect(initGit(home, home)).rejects.toThrow("home folder can't be a project")
    expect(existsSync(join(home, '.git'))).toBe(false)
    const big = await mkdtemp(join(tmpdir(), 'big-'))
    await mkdir(join(big, 'node_modules', 'pkg'), { recursive: true })
    for (let i = 0; i < 5001; i += 500) await Promise.all(Array.from({ length: Math.min(500, 5001 - i) }, (_, j) => writeFile(join(big, 'node_modules', 'pkg', `f${i + j}.js`), '')))
    await expect(k.createProject({ source: 'folder', name: 'Big', from: big, team: [], autostart: false, initGit: true })).rejects.toThrow('more than 5,000 files')
    expect(existsSync(join(big, '.git'))).toBe(false)
    expect(k.store.projects()).toEqual([])
    await k.stop()
  })

  it('gives two projects with the same name their own worktree folders, and keeps an older project in its old one (KERNEL-231)', async () => {
    const { k, home } = await kernel()
    k.sessions.send = async () => ({ queued: false })
    const agent = { '.claude/agents/kai.md': '---\nname: kai\ndescription: Builds.\n---\nHi' }
    const one = await k.addProject(await tempRepo(agent), 'app')
    const two = await k.addProject(await tempRepo(agent), 'app')
    const a = await k.workspaces.createWorkspace(one.id, { prompt: 'Go', title: 'Go', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    const b = await k.workspaces.createWorkspace(two.id, { prompt: 'Go', title: 'Go', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    expect(a.path.startsWith(join(home, 'wt', one.id) + '/')).toBe(true)
    expect(b.path.startsWith(join(home, 'wt', two.id) + '/')).toBe(true)
    // A project saved before KERNEL-231 has no folder of its own and keeps the slug of its name.
    const { worktreeDir: _dir, ...old } = k.store.project(one.id)!
    k.store.saveProject({ ...old, name: 'Old app' })
    const c = await k.workspaces.createWorkspace(one.id, { prompt: 'More', title: 'More', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    expect(c.path.startsWith(join(home, 'wt', 'old-app') + '/')).toBe(true)
    expect(k.store.workspace(a.id)?.path).toBe(a.path)
    await k.stop()
  })

  it('removes the worktrees of a project only when asked', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nHi' })
    const project = await k.addProject(repo)
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Do a thing', title: 'Thing', mode: 'worktree', baseRef: 'main' })
    await k.removeProject(project.id, true)
    await expect(stat(ws.path)).rejects.toThrow()
    expect(k.store.workspace(ws.id)).toBeUndefined()
    expect(await stat(repo)).toBeTruthy()
    await k.stop()
  })

  it('gives two workspaces created at once in one project their own branch and folder (KERNEL-231)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ '.claude/agents/kai.md': '---\nname: kai\ndescription: Builds.\n---\nHi' })
    const project = await k.addProject(repo)
    k.sessions.send = async () => ({ queued: false })
    const make = () => k.workspaces.createWorkspace(project.id, { prompt: 'Same task', title: 'Same task', agentId: 'kai', mode: 'worktree', baseRef: 'main' })
    const [a, b] = await Promise.all([make(), make()])
    expect(a.branch).not.toBe(b.branch)
    expect(a.path).not.toBe(b.path)
    await k.stop()
  })
})

describe("the project's Install step (KERNEL-260, KERNEL-913)", () => {
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
    const project = await k.createProject({ source: 'folder', name: 'Cloned app', from: repo, team: ['kai'], autostart: false })
    const steps = await setupDone(project.id)
    return { k, repo, project, steps, h: k.handlers() }
  }

  it('runs the install scripts with the Install step, and the first workspace starts at once (KERNEL-913)', async () => {
    await withFakeNpm(async () => {
      const { k, repo, project, steps } = await start({ 'package.json': pkg('touch ran.txt') })
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok', detail: 'npm install' })
      expect(existsSync(join(repo, 'ran.txt'))).toBe(true)
      const ws = await k.createWorkspace(project.id, { prompt: 'Build it', agentId: 'kai', title: 'First' })
      expect(ws.status).toBe('ready')
      await k.stop()
    })
  }, 90000)

  it("runs an install that runs the repo's own code with the Install step (KERNEL-913)", async () => {
    await withFakeNpm(async () => {
      const { k, repo, steps } = await start({ Gemfile: 'source "https://rubygems.org"\n' })
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok', detail: 'bundle install' })
      expect(existsSync(join(repo, 'ran.txt'))).toBe(true)
      await k.stop()
    }, { bundle: '#!/bin/sh\ntouch ran.txt\n' })
  }, 90000)

  it('runs each Install step an older Kernel held for trust once, then forgets the list (KERNEL-913)', async () => {
    await withFakeNpm(async () => {
      const { k, repo, project } = await start({ Gemfile: '' })
      await rm(join(repo, 'ran.txt'))
      k.store.saveMeta('heldInstalls', [project.id, project.id, 'gone'])
      await k.projects.installHeld()
      expect(existsSync(join(repo, 'ran.txt'))).toBe(true)
      expect(k.store.meta('heldInstalls')).toBeUndefined()
      await rm(join(repo, 'ran.txt'))
      await k.projects.installHeld()
      expect(existsSync(join(repo, 'ran.txt'))).toBe(false)
      await k.stop()
    }, { bundle: '#!/bin/sh\ntouch ran.txt\n' })
  }, 90000)

  it('runs go mod download with the Install step (KERNEL-444)', async () => {
    await withFakeNpm(async () => {
      const { k, repo, steps } = await start({ 'go.mod': 'module demo\n' })
      expect(steps.find((s) => s.id === 'install')).toMatchObject({ state: 'ok', detail: 'go mod download' })
      expect(existsSync(join(repo, 'ran.txt'))).toBe(true)
      await k.stop()
    }, { go: '#!/bin/sh\ntouch ran.txt\n' })
  }, 90000)
})

describe('Projects page helpers', () => {
  it('words the status and the age', () => {
    const project = { id: 'r', name: 'R', path: '/x', defaultBranch: 'main', paused: false, createdAt: 0 }
    const waiting = { id: 'a', kind: 'plan', source: 'sdk', projectId: 'r', title: '', status: 'pending', createdAt: 0 } as never
    expect(projectState(project, [waiting], { k: 'idle' })).toBe('you')
    expect(projectState(project, [], { k: 'working' })).toBe('working')
    expect(projectState(project, [], { k: 'idle' })).toBe('idle')
    expect(projectState({ ...project, archived: true }, [], {})).toBe('archived')
    const now = 1_000_000_000_000
    expect([120, 3600, 7200, 86400 * 2, 86400 * 21].map((s) => ago(now - s * 1000, now))).toEqual(['2 min ago', '1 hour ago', '2 hours ago', '2 days ago', '3 weeks ago'])
  })

  it("counts the team without Kernel's Theo, which the list keeps only to name old reviews (KERNEL-553)", () => {
    const agent = (id: string, retired?: boolean) => ({ id, name: id, role: 'Engineer', model: 'opus', file: '', retired }) as never
    expect(teamOf([agent('kernel'), agent('kai'), agent('kernel-reviewer', true)]).map((a) => a.id)).toEqual(['kernel', 'kai'])
    expect(teamOf(undefined)).toEqual([])
  })
})
