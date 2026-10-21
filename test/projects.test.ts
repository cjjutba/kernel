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
import { afterProjectLeaves } from '../src/renderer/src/screens/projects/afterProjectLeaves'
import { ago, agoShort, projectState, teamOf } from '../src/renderer/src/screens/projects/projectInfo'
import { repoOfUrl } from '../src/renderer/src/screens/projects/ConnectRepo'
import { assertFreeFolder, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, listOwners, lockfileInstall, recentFolders, repoAvailable, seatStarterTeam } from '../src/main/services/projects'
import { loadRepoSettings } from '../src/main/services/settings'
import { keepSetupLog, setupLogEntry, SETUP_LOG_KEEP } from '../src/main/features/projects'
import { repoSlug } from '../src/renderer/src/screens/projects/RepoName'
import { setUp, tempRepo, freePort } from './helpers'

const starter = join(__dirname, '..', 'docs', 'starter-agents')

/** A Kernel in new folders, or, with `dirs`, again on the folders of one that stopped, as after a restart. */
async function kernel(settings: Record<string, unknown> = {}, dirs?: { dataDir: string; home: string }) {
  const dataDir = dirs?.dataDir ?? await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = dirs?.home ?? await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), team: { leadMode: 'build' }, worktreeRoot: join(home, 'wt'), ...settings }))
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

  it("seats the picked starter agents, Artkin too but not Kernel, and writes settings.toml once", async () => {
    const repo = await tempRepo()
    expect(await seatStarterTeam(starter, repo, ['christian', 'kernel', 'artkin', 'nobody'])).toEqual(['christian', 'artkin'])
    expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['artkin.md', 'christian.md'])
    // A file the repo already has stays as it is.
    await writeFile(join(repo, '.claude', 'agents', 'sean.md'), '---\nname: sean\ndescription: Ours.\n---\nx\n')
    expect(await seatStarterTeam(starter, repo, ['christian', 'sean', 'teng'])).toEqual(['teng'])
    expect(await readFile(join(repo, '.claude', 'agents', 'sean.md'), 'utf8')).toContain('Ours.')
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
    const project = await k.createProject({ source: 'folder', name: 'Env app', from: repo, team: ['christian'], autostart: false })
    expect((await setupDone(project.id)).find((s) => s.id === 'copy')).toMatchObject({ state: 'ok', detail: 'a.env, b.env, c.env, d.env, e.env and 2 more' })
    await k.stop()
  })

  it('creates a project from a folder, runs setup past a step that fails, then removes it without touching the folder (KERNEL-1086)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n' })
    const failed: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'project.setupFailed') failed.push(e) }
    bus.on('push', on)
    const done = (async () => { const project = await k.createProject({ source: 'folder', name: 'Own app', desc: 'Nights', from: repo, team: ['christian'], autostart: false }); return { project, steps: await setupDone(project.id) } })()
    const { project, steps } = await done
    bus.off('push', on)
    expect(project).toMatchObject({ name: 'Own app', kind: 'folder', path: repo })
    // Hooks aren't installed, so that step is skipped with its error, and the agents after it are seated anyway.
    expect(steps.map((s) => [s.id, s.state])).toEqual([['clone', 'ok'], ['host', 'ok'], ['worktrees', 'ok'], ['copy', 'ok'], ['hooks', 'skip'], ['agents', 'ok']])
    expect(steps.find((s) => s.id === 'hooks')?.error).toContain('Check hooks')
    expect(failed).toEqual([{ type: 'project.setupFailed', projectId: project.id, step: 'hooks', title: 'Install hooks', error: steps.find((s) => s.id === 'hooks')!.error, skipped: true }])
    expect((await k.agents(project.id)).map((a) => a.id)).toEqual(['kernel-lead', 'christian'])
    expect(steps.find((s) => s.id === 'agents')).toMatchObject({ detail: 'Christian from .claude/agents, Kernel leads' })
    expect(steps.find((s) => s.id === 'agents')?.brought).toBeUndefined()
    expect(await stat(join(repo, '.kernel', 'settings.toml'))).toBeTruthy()

    await expect(k.createProject({ source: 'folder', name: 'Again', from: repo, team: [], autostart: false })).rejects.toThrow('already the project Own app')

    const hidden = await k.updateProject(project.id, { hidden: true })
    expect(hidden.hidden).toBe(true)
    expect(k.store.project(project.id)?.hidden).toBe(true)

    await k.removeProject(project.id, false)
    expect(k.store.project(project.id)).toBeUndefined()
    expect(await stat(join(repo, 'README.md'))).toBeTruthy()
    expect(await stat(join(repo, '.claude', 'agents', 'christian.md'))).toBeTruthy()
    await k.stop()
  })

  it('tries a failed setup again from the failed step, one try at a time, and refuses once the project is set up (KERNEL-876)', async () => {
    const { k } = await kernel()
    const project = await k.createProject({ source: 'folder', name: 'Retry app', from: await tempRepo(), team: ['christian'], autostart: false })
    expect((await setupDone(project.id)).find((s) => s.id === 'hooks')?.state).toBe('skip')
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
    expect(published[0].map((s) => [s.id, s.state])).toEqual([['clone', 'ok'], ['host', 'ok'], ['worktrees', 'ok'], ['copy', 'ok'], ['hooks', 'wait'], ['agents', 'wait']])
    expect([...new Set(published.flatMap((p) => p.filter((s) => s.state === 'run').map((s) => s.id)))]).toEqual(['hooks', 'agents'])
    expect(steps.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
    expect(steps.find((s) => s.id === 'hooks')?.error).toBeUndefined()
    // The starter agents the first try seated are still Kernel's, not agents the repo brought.
    expect(steps.find((s) => s.id === 'agents')).toMatchObject({ detail: 'Christian from .claude/agents, Kernel leads' })
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
    expect((await done).find((s) => s.id === 'hooks')).toMatchObject({ state: 'skip', error: 'Claude settings could not be read.' })
    status.mockRestore()
    // Nothing finished, so Try again is still there.
    const again = setupDone(project.id)
    k.projects.retrySetup(project.id)
    expect((await again).find((s) => s.id === 'hooks')).toMatchObject({ state: 'skip', error: expect.stringContaining('Check hooks') })
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
      `echo "Cloning into '$4'..." >&2`,
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
      const failed: PushEvent[] = []
      const on = (e: PushEvent) => { if (e.type === 'project.setupFailed') failed.push(e) }
      bus.on('push', on)
      const project = await k.createProject({ source: 'repo', name: 'Clone app', from: 'me/clone-app', cloneTo: join(home, 'Projects', 'clone-app'), team: ['christian'], autostart: false })
      const first = await setupDone(project.id)
      bus.off('push', on)
      // Every step after it needs the checkout, so setup stops at the clone.
      expect(first.find((s) => s.id === 'clone')).toMatchObject({ state: 'fail', error: expect.stringContaining('early EOF') })
      expect(first.filter((s) => s.id !== 'clone').every((s) => s.state === 'wait')).toBe(true)
      expect(failed).toEqual([expect.objectContaining({ projectId: project.id, step: 'clone', skipped: false })])
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
      const project = await k.createProject({ source: 'repo', name: 'Picked app', from: 'me/picked-app', cloneTo: picked, team: ['christian'], autostart: false })
      expect((await setupDone(project.id)).find((s) => s.id === 'clone')?.state).toBe('fail')

      const done = setupDone(project.id)
      k.projects.retrySetup(project.id)
      expect((await done).find((s) => s.id === 'clone')).toMatchObject({ state: 'fail', error: '~/Picked is not empty, and Kernel didn\'t make it, so Kernel leaves it as it is. Empty it, then try again.' })
    })
    expect(clones).toBe(1)
    expect(await readFile(join(picked, 'half.txt'), 'utf8')).toBe('half\n')
    await k.stop({ budgetMs: 0 })
  })

  it('keeps a setup log for each project: every step, what a tool printed, the failure and the retry, until the project goes (KERNEL-1117)', async () => {
    const { k, home } = await kernel()
    const src = await tempRepo({ 'README.md': '# x\n' })
    await withFlakyClone(src, async () => {
      const project = await k.projects.createProject({ source: 'repo', name: 'Log app', from: 'me/log-app', cloneTo: join(home, 'Projects', 'log-app'), team: ['christian'], autostart: false })
      await setupDone(project.id)
      const first = await k.handlers()['projects.setupLog']({ projectId: project.id })
      expect(first).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}Clone me\/log-app\n/)
      expect(first).toContain('Failed, setup stopped here')
      expect(first).toContain('fatal: early EOF')
      // The steps after the checkout never ran, so the log has nothing about them.
      expect(first).not.toContain('Create the worktree folder')

      const done = setupDone(project.id)
      k.projects.retrySetup(project.id)
      await done
      const log = await k.handlers()['projects.setupLog']({ projectId: project.id })
      expect(log.startsWith(first)).toBe(true)
      const retry = log.slice(first.length)
      expect(retry).toContain('Trying again from: Clone me/log-app')
      expect(retry.indexOf('Output: Clone me/log-app')).toBeGreaterThan(retry.indexOf('Trying again'))
      expect(retry).toMatch(/Output: Clone me\/log-app\n\s+Cloning into/)
      expect(retry).toMatch(/Done: .*log-app\n/)
      expect(retry.indexOf('Create the worktree folder')).toBeGreaterThan(retry.indexOf('Output:'))
      // Install hooks is skipped with its reason, and the agents after it are seated.
      expect(log).toMatch(/Install hooks\n[^]*Skipped, setup went on\n\s+Kernel hooks are not in your Claude settings yet[^]*Seat agents\n[^]*Done: Christian from \.claude\/agents, Kernel leads/)

      await k.projects.removeProject(project.id, false)
      expect(k.store.meta(`setupLog:${project.id}`)).toBeUndefined()
      await expect(k.handlers()['projects.setupLog']({ projectId: project.id })).rejects.toThrow()
    })
    await k.stop({ budgetMs: 0 })
  })

  it('keeps a setup log bounded: a tool\'s output is cut to its end and the oldest lines go first (KERNEL-1117)', () => {
    const big = setupLogEntry(new Date(2026, 9, 21, 14, 3, 12), 'Output: Clone me/app', `first\n${'y'.repeat(50_000)}\nlast`)
    expect(big.length).toBeLessThan(5_000)
    expect(big).toContain('last')
    expect(big).not.toContain('first')
    expect(big.startsWith('2026-10-21 14:03:12  Output: Clone me/app\n')).toBe(true)
    let log = ''
    for (let i = 0; i < 3000; i++) log = keepSetupLog(log, setupLogEntry(new Date(), `Step ${i}`, 'x'.repeat(100)))
    expect(log.length).toBeLessThanOrEqual(SETUP_LOG_KEEP)
    expect(log).toContain('Step 2999')
    expect(log).not.toContain('Step 0\n')
    expect(log.split('\n').every((l) => /^\d{4}-\d\d-\d\d |^ +x+$|^$/.test(l))).toBe(true)
  })

  it('tries a setup that failed before a restart again after it (KERNEL-883)', async () => {
    const first = await kernel()
    const project = await first.k.createProject({ source: 'folder', name: 'Restart app', from: await tempRepo(), team: ['christian'], autostart: false })
    expect((await setupDone(project.id)).find((s) => s.id === 'hooks')?.state).toBe('skip')
    await first.k.stop({ budgetMs: 0 })

    const { k } = await kernel({}, first)
    await k.handlers()['hooks.install']({ port: (await k.hooks.hooksStatus()).port })
    // A window that loads asks for the projects, and gets the failed setup on the events Project setup reads.
    const published: ProjectSetupStep[][] = []
    const on = (e: PushEvent) => { if (e.type === 'project.setup' && e.projectId === project.id) published.push(e.steps) }
    bus.on('push', on)
    await k.handlers()['projects.list'](undefined)
    bus.off('push', on)
    expect(published.at(-1)?.find((s) => s.id === 'hooks')).toMatchObject({ state: 'skip', error: expect.stringContaining('Check hooks') })

    const done = setupDone(project.id)
    await k.handlers()['projects.retrySetup']({ projectId: project.id })
    const steps = await done
    expect(steps.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
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
    expect(published.at(-1)?.map((s) => [s.id, s.state, s.error])).toEqual([['clone', 'ok', undefined], ['host', 'ok', undefined], ['worktrees', 'fail', 'Setup stopped when Kernel quit.']])
    await k.stop({ budgetMs: 0 })
  })

  it('checks push access once the checkout has a remote, and Check again updates the step (KERNEL-460)', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n' })
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await exec('git', ['init', '-q', '--bare', remote])
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    const project = await k.createProject({ source: 'folder', name: 'Pushed app', from: repo, team: ['christian'], autostart: false })
    const steps = await setupDone(project.id)
    expect(steps.map((s) => s.id)).toEqual(['clone', 'host', 'worktrees', 'copy', 'hooks', 'push', 'agents'])
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
    const wait = (async () => { const project = await k.createProject({ source: 'folder', name: 'Plain', from: plain, team: ['christian'], autostart: false, initGit: true }); return { project, steps: await setupDone(project.id) } })()
    const { project, steps } = await wait
    expect((await exec('git', ['-C', plain, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main')
    expect((await exec('git', ['-C', plain, 'rev-parse', '--verify', '--quiet', 'HEAD'])).code).not.toBe(0)
    expect(steps.find((s) => s.id === 'clone')).toMatchObject({ state: 'ok', detail: expect.stringContaining('Make the first commit') })
    expect(project.defaultBranch).toBe('main')
    // Until the user commits, a new workspace says why it can't start.
    k.sessions.send = async () => ({ queued: false })
    await expect(k.workspaces.createWorkspace(project.id, { prompt: 'Go', title: 'Go', agentId: 'christian', mode: 'worktree' })).rejects.toThrow('has no commit yet')
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
    const agent = { '.claude/agents/christian.md': '---\nname: christian\ndescription: Builds.\n---\nHi' }
    const one = await k.addProject(await tempRepo(agent), 'app')
    const two = await k.addProject(await tempRepo(agent), 'app')
    const a = await k.workspaces.createWorkspace(one.id, { prompt: 'Go', title: 'Go', agentId: 'christian', mode: 'worktree', baseRef: 'main' })
    const b = await k.workspaces.createWorkspace(two.id, { prompt: 'Go', title: 'Go', agentId: 'christian', mode: 'worktree', baseRef: 'main' })
    expect(a.path.startsWith(join(home, 'wt', one.id) + '/')).toBe(true)
    expect(b.path.startsWith(join(home, 'wt', two.id) + '/')).toBe(true)
    // A project saved before KERNEL-231 has no folder of its own and keeps the slug of its name.
    const { worktreeDir: _dir, ...old } = k.store.project(one.id)!
    k.store.saveProject({ ...old, name: 'Old app' })
    const c = await k.workspaces.createWorkspace(one.id, { prompt: 'More', title: 'More', agentId: 'christian', mode: 'worktree', baseRef: 'main' })
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
    const repo = await tempRepo({ '.claude/agents/christian.md': '---\nname: christian\ndescription: Builds.\n---\nHi' })
    const project = await k.addProject(repo)
    k.sessions.send = async () => ({ queued: false })
    const make = () => k.workspaces.createWorkspace(project.id, { prompt: 'Same task', title: 'Same task', agentId: 'christian', mode: 'worktree', baseRef: 'main' })
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
    const project = await k.createProject({ source: 'folder', name: 'Cloned app', from: repo, team: ['christian'], autostart: false })
    const steps = await setupDone(project.id)
    return { k, repo, project, steps, h: k.handlers() }
  }

  it('installs nothing at project setup, and the first workspace starts at once (KERNEL-948)', async () => {
    await withFakeNpm(async () => {
      const { k, repo, project, steps } = await start({ 'package.json': pkg('touch ran.txt') })
      expect(steps.map((s) => s.id)).not.toContain('install')
      expect(existsSync(join(repo, 'ran.txt'))).toBe(false)
      const ws = await k.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'First' })
      expect(ws.status).toBe('ready')
      await k.stop()
    })
  }, 90000)

  it('runs each Install step an older Kernel held for trust once, then forgets the list (KERNEL-913)', async () => {
    await withFakeNpm(async () => {
      const { k, repo, project } = await start({ Gemfile: '' })
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

})

describe('where a project leaves to', () => {
  const p = (id: string, archived = false) => ({ id, archived }) as any
  it('opens New chat when no active project remains, All projects otherwise', () => {
    expect(afterProjectLeaves([p('a')], 'a')).toEqual({ name: 'leadNew', projectId: '' })
    expect(afterProjectLeaves([p('a'), p('b', true)], 'a')).toEqual({ name: 'leadNew', projectId: '' })
    expect(afterProjectLeaves([p('a'), p('b')], 'a')).toEqual({ name: 'projects' })
  })
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

  it("counts the team without Kernel's Artkin, which the list keeps only to name old reviews (KERNEL-553)", () => {
    const agent = (id: string, retired?: boolean) => ({ id, name: id, role: 'Engineer', model: 'opus', file: '', retired }) as never
    expect(teamOf([agent('kernel'), agent('christian'), agent('kernel-reviewer', true)]).map((a) => a.id)).toEqual(['kernel', 'christian'])
    expect(teamOf(undefined)).toEqual([])
  })
})

describe('Clone a GitHub repo (KERNEL-945)', () => {
  it('reads owner/name from an https or ssh URL, or from owner/name typed as is', () => {
    expect(repoOfUrl('https://github.com/cjjutba/kernel')).toBe('cjjutba/kernel')
    expect(repoOfUrl('https://github.com/cjjutba/kernel.git')).toBe('cjjutba/kernel')
    expect(repoOfUrl('github.com/cjjutba/homebrew-tap/')).toBe('cjjutba/homebrew-tap')
    expect(repoOfUrl('git@github.com:cjjutba/cjjutba.dev.git')).toBe('cjjutba/cjjutba.dev')
    expect(repoOfUrl(' cjjutba/fiscplus ')).toBe('cjjutba/fiscplus')
    expect(repoOfUrl('https://gitlab.com/a/b')).toBeUndefined()
    expect(repoOfUrl('just words')).toBeUndefined()
  })
})

describe('a GitHub repo for every project (KERNEL-944)', () => {
  /**
   * Runs `fn` with a `gh` first on the PATH that creates repos as bare folders and answers `repo view` and `api`. `taken` lists the
   * owner/name pairs that already exist. Returns the folder the bare repos land in.
   */
  async function withFakeGh(fn: (remotes: string) => Promise<void>, taken: string[] = []) {
    const bin = await mkdtemp(join(tmpdir(), 'kernel-gh-'))
    const remotes = join(bin, 'remotes')
    await mkdir(remotes)
    await writeFile(join(bin, 'gh'), [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "repo create")',
      '    name=$(basename "$3"); src=""; push=""; shift 3',
      '    while [ $# -gt 0 ]; do case "$1" in --source) src="$2"; shift ;; --push) push=1 ;; esac; shift; done',
      `    git init -q --bare "${remotes}/$name.git" && git -C "$src" remote add origin "${remotes}/$name.git"`,
      '    [ -z "$push" ] || git -C "$src" push -q origin HEAD',
      '    ;;',
      '  "repo view")',
      `    case " ${taken.join(' ')} " in *" $3 "*) echo '{"name":"x"}' ;; *) echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1 ;; esac ;;`,
      `  "api user") echo '{"login":"me","avatar":"https://avatars.example/me.png"}' ;;`,
      `  "api user/orgs") echo '[{"login":"acme","avatar":"https://avatars.example/acme.png"}]' ;;`,
      '  *) echo "not stubbed" >&2; exit 1 ;;',
      'esac',
      ''
    ].join('\n'), { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try { await fn(remotes) } finally { process.env.PATH = path }
  }

  it('makes a project from scratch as an empty repo with a README, and pushes it to a new private repo', async () => {
    const { k, home } = await kernel()
    await withFakeGh(async (remotes) => {
      const project = await k.createProject({ source: 'scratch', name: 'Habit tracker', from: '', github: { owner: 'me', name: 'habit-tracker' }, cloneTo: join(home, 'Projects', 'habit-tracker'), team: [], autostart: false })
      const steps = await setupDone(project.id)
      expect(steps.map((s) => s.id).slice(0, 2)).toEqual(['clone', 'github'])
      expect(steps.find((s) => s.id === 'clone')).toMatchObject({ state: 'ok', title: 'Create the folder' })
      expect(steps.find((s) => s.id === 'github')).toMatchObject({ state: 'ok', title: 'Create me/habit-tracker on GitHub', detail: 'Private repo, pushed' })
      expect(await readFile(join(project.path, 'README.md'), 'utf8')).toBe('# Habit tracker\n')
      expect(k.store.project(project.id)?.repo).toBe('me/habit-tracker')
      expect((await exec('git', ['-C', join(remotes, 'habit-tracker.git'), 'rev-parse', 'main'])).code).toBe(0)
    })
    await k.stop({ budgetMs: 0 })
  })

  it('gives a folder that is not a repo git and a remote, and pushes nothing of the user\'s', async () => {
    const { k, home } = await kernel()
    const folder = join(home, 'Projects', 'notes')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'todo.txt'), 'x\n')
    await withFakeGh(async (remotes) => {
      const project = await k.createProject({ source: 'folder', name: 'Notes', from: folder, github: { owner: 'me', name: 'notes' }, team: [], autostart: false })
      const github = (await setupDone(project.id)).find((s) => s.id === 'github')
      expect(github).toMatchObject({ state: 'ok', detail: expect.stringContaining('Make the first commit') })
      expect((await exec('git', ['-C', folder, 'remote', 'get-url', 'origin'])).stdout.trim()).toBe(join(remotes, 'notes.git'))
      expect((await exec('git', ['-C', folder, 'rev-parse', 'HEAD'])).code).not.toBe(0)
    })
    await k.stop({ budgetMs: 0 })
  })

  it('pushes the current branch of a repo that has no remote yet', async () => {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# app\n' })
    await withFakeGh(async (remotes) => {
      const project = await k.createProject({ source: 'folder', name: 'App', from: repo, github: { owner: 'acme', name: 'app' }, team: [], autostart: false })
      expect((await setupDone(project.id)).find((s) => s.id === 'github')).toMatchObject({ state: 'ok', detail: 'Private repo, pushed' })
      expect((await exec('git', ['-C', join(remotes, 'app.git'), 'rev-parse', 'HEAD'])).code).toBe(0)
      expect(await inspectFolder(repo)).not.toHaveProperty('remote')
    })
    await k.stop({ budgetMs: 0 })
  })

  it('lists the user then their orgs, and says when a name is taken or one GitHub won\'t take', async () => {
    await withFakeGh(async () => {
      expect(await listOwners()).toEqual([
        { login: 'me', avatarUrl: 'https://avatars.example/me.png', org: false },
        { login: 'acme', avatarUrl: 'https://avatars.example/acme.png', org: true }
      ])
      expect(await repoAvailable('me', 'fresh')).toEqual({ available: true })
      expect(await repoAvailable('me', 'kernel')).toEqual({ available: false, reason: 'me/kernel already exists.' })
      expect(await repoAvailable('me', 'my app')).toMatchObject({ available: false, reason: expect.stringContaining('letters, numbers') })
    }, ['me/kernel'])
  })

  it('reads a folder\'s GitHub remote as owner/repo', async () => {
    const repo = await tempRepo()
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:me/app.git'])
    expect(await inspectFolder(repo)).toMatchObject({ git: true, remote: 'me/app' })
  })

  it('suggests a repo name GitHub keeps as typed (KERNEL-946)', () => {
    expect(repoSlug('recipe-box')).toBe('recipe-box')
    expect(repoSlug('cjjutba.dev')).toBe('cjjutba.dev')
    expect(repoSlug(' My new app! ')).toBe('My-new-app')
  })
})

describe("a new project's first chat", () => {
  /** Creates a project from a folder and waits until its first chat has set up. */
  async function created(files: Record<string, string> = {}) {
    const { k } = await kernel()
    const repo = await tempRepo({ 'README.md': '# x\n', ...files })
    const project = await k.createProject({ source: 'folder', name: 'First app', from: repo, team: ['christian'], autostart: false })
    await setupDone(project.id)
    await vi.waitFor(() => expect(k.store.project(project.id)?.firstChatId).toBeTruthy(), { timeout: 10_000, interval: 10 })
    const chat = k.store.chat(k.store.project(project.id)!.firstChatId!)!
    return { k, project, chat, ws: await setUp(k, chat.id, 'settled') }
  }

  it('is made once setup finishes, with its worktree, and it is the only chat', async () => {
    const { k, project, ws } = await created()
    expect(k.lead.chatWorkspaces(project.id).map((w) => w.id)).toEqual([ws.id])
    expect(ws).toMatchObject({ status: 'ready', mode: 'worktree', firstInProject: true, naming: 'branch' })
    expect(existsSync(ws.path)).toBe(true)
    await k.stop({ budgetMs: 0 })
  })

  it('has no setup run and no failure when the project has no setup script', async () => {
    const { k, ws, chat } = await created()
    expect(ws.setupRun).toBeUndefined()
    expect(k.store.items(chat.id)).toEqual([])
    await k.stop({ budgetMs: 0 })
  })

  it('runs the setup script in the background and still takes a message', async () => {
    const { k, project, chat, ws } = await created({ '.kernel/settings.toml': '[scripts]\nsetup = "sleep 1 && echo set up"\n' })
    expect(ws.status).toBe('ready')
    expect(ws.setupRun?.startedAt).toBeTruthy()
    const sent = vi.spyOn(k.sessions, 'send').mockResolvedValue({ queued: false })
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Plan it' }])
    expect(sent).toHaveBeenCalledWith(chat.id, expect.anything())
    expect(k.lead.chatWorkspaces(project.id)).toHaveLength(1)
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.setupRun?.endedAt).toBeTruthy(), { timeout: 10_000, interval: 20 })
    expect(k.store.workspace(ws.id)?.setupRun?.end).toBe(0)
    await k.stop({ budgetMs: 0 })
  })

  it('is not made again when setup is retried', async () => {
    const { k, project, chat } = await created()
    await (k.projects as unknown as { makeFirstChat(id: string): Promise<void> }).makeFirstChat(project.id)
    expect(k.lead.chatWorkspaces(project.id).map((w) => w.id)).toHaveLength(1)
    expect(k.store.project(project.id)?.firstChatId).toBe(chat.id)
    await k.stop({ budgetMs: 0 })
  })
})
