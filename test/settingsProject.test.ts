import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { installHooks, uninstallHooks, withKernelHooks } from '../src/main/services/hooksInstaller'
import { discoverSkills } from '../src/main/services/files'
import { discoverMcp, saveLinearToken, storedLinearToken } from '../src/main/services/integrations'
import { loadRepoSettings, remoteOf, saveRepoSettings } from '../src/main/services/settings'
import { exec, git, run } from '../src/main/services/exec'
import { bashVerdict, type SessionDeps } from '../src/main/services/sessions'
import { tempRepo } from './helpers'

describe('repo settings files', () => {
  it('writes the shared file and the personal one separately, and reads them merged', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install', run: 'pnpm dev', runMode: 'single' }, files: { copy: ['.env.local'] } }, true)
    const merged = await saveRepoSettings(repo, { scripts: { setup: 'npm ci' }, workspace: { baseRef: 'origin/dev', deleteBranchOnArchive: true } })
    expect(merged.scripts).toMatchObject({ setup: 'npm ci', run: 'pnpm dev', runMode: 'single' })
    expect(merged.workspace).toEqual({ baseRef: 'origin/dev', deleteBranchOnArchive: true })
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('setup = "pnpm install"')
    expect(await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).toContain('base_ref = "origin/dev"')
  })

  it('a null removes the override and the shared value applies again', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install' }, workspace: { mode: 'worktree' } }, true)
    await saveRepoSettings(repo, { scripts: { setup: 'make' }, workspace: { mode: 'current' } })
    const after = await saveRepoSettings(repo, { scripts: { setup: null }, workspace: { mode: null } })
    expect(after.scripts.setup).toBe('pnpm install')
    expect(after.workspace.mode).toBe('worktree')
    // Nothing is left to override, so the personal file is gone (KERNEL-69).
    await expect(readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).rejects.toThrow()
  })

  it('keeps the skills and MCP servers switched off for the room', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    expect((await loadRepoSettings(repo)).disabled).toEqual({ skills: [], mcp: [] })
    const next = await saveRepoSettings(repo, { disabled: { skills: ['plan'], mcp: ['Figma'] } })
    expect(next.disabled).toEqual({ skills: ['plan'], mcp: ['Figma'] })
    await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { Figma: {}, Linear: {} } }))
    expect(await discoverMcp(repo, repo, next.disabled!.mcp)).toEqual([
      { name: 'Figma', source: 'project', enabled: false }, { name: 'Linear', source: 'project', enabled: true }
    ])
  })

  it("reads and writes the room's Linear team as a [linear] table", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    expect((await loadRepoSettings(repo)).linear).toBeUndefined()
    expect((await saveRepoSettings(repo, { linear: { team: 'KERNEL' } }, true)).linear).toEqual({ team: 'KERNEL' })
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('[linear]\nteam = "KERNEL"')
    expect((await saveRepoSettings(repo, { linear: { team: 'OPS' } })).linear).toEqual({ team: 'OPS' })
    expect((await saveRepoSettings(repo, { linear: { team: null } })).linear).toEqual({ team: 'KERNEL' })
    expect((await saveRepoSettings(repo, { linear: { team: null } }, true)).linear).toBeUndefined()
  })

  it('reads the personal file, then settings.toml, key by key, and says where each value came from (KERNEL-190)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install', run: 'pnpm dev' }, files: { copy: ['.env'] }, workspace: { remote: 'upstream' } }, true)
    const rs = await saveRepoSettings(repo, { scripts: { setup: 'npm ci' }, files: { copy: ['.env.local'] }, pr: { createInstructions: '# Mine' } })
    expect(rs.scripts).toMatchObject({ setup: 'npm ci', run: 'pnpm dev' })
    expect(rs.files.copy).toEqual(['.env.local'])
    expect(rs.workspace).toEqual({ remote: 'upstream' })
    expect(rs.pr).toEqual({ createInstructions: '# Mine' })
    // An array is one value, so files.copy in both files is an override. Nothing reports scripts.archive: the app default applies.
    // The run script reports under both its names (KERNEL-244).
    expect(rs.sources).toEqual({ 'scripts.setup': 'override', 'scripts.run': 'shared', 'runScripts.run': 'shared', 'files.copy': 'override', 'workspace.remote': 'shared', 'pr.createInstructions': 'local' })
    expect(rs.scripts.archive).toBeUndefined()
    expect(await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).toContain('[pr]\ncreate_instructions = "# Mine"')
    expect((await loadRepoSettings(await mkdtemp(join(tmpdir(), 'kernel-repo-')))).sources).toEqual({})
  })

  it('a null removes the personal key, the shared value shows through, and an emptied personal file goes (KERNEL-190)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install' } }, true)
    await saveRepoSettings(repo, { scripts: { setup: 'npm ci' }, pr: { fixChecksInstructions: '# Fix' } })
    let rs = await saveRepoSettings(repo, { pr: { fixChecksInstructions: null } })
    expect(rs.pr).toBeUndefined()
    expect(rs.sources).toEqual({ 'scripts.setup': 'override' })
    rs = await saveRepoSettings(repo, { scripts: { setup: null } })
    expect(rs.scripts.setup).toBe('pnpm install')
    expect(rs.sources).toEqual({ 'scripts.setup': 'shared' })
    await expect(stat(join(repo, '.kernel', 'settings.local.toml'))).rejects.toThrow()
  })

  it('reads both files through the same whitelist (KERNEL-190)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await mkdir(join(repo, '.kernel'))
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[workspace]\nnope = 1\nbase_ref = "origin/dev"\n[other]\nx = 1\n[pr]\nresolve_instructions = "# Shared"\nmystery = "x"\n')
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[pr]\ncreate_instructions = 3\n[scripts]\nwhatever = "x"\n')
    const rs = await loadRepoSettings(repo)
    expect(rs.workspace).toEqual({ baseRef: 'origin/dev' })
    expect(rs.pr).toEqual({ resolveInstructions: '# Shared' })
    expect(rs.sources).toEqual({ 'workspace.baseRef': 'shared', 'pr.resolveInstructions': 'shared' })
  })

  it("picks the room's remote, then the app's, then origin (KERNEL-190)", () => {
    expect(remoteOf({ workspace: { remote: 'upstream' } }, { workspace: { remote: 'fork' } as never })).toBe('upstream')
    expect(remoteOf({ workspace: {} }, { workspace: { remote: 'fork' } as never })).toBe('fork')
    expect(remoteOf({ workspace: { remote: ' ' } }, { workspace: { remote: '' } as never })).toBe('origin')
  })
})

describe('the room remote (KERNEL-190)', () => {
  const kai = { 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' }

  /** A repo whose only remote is `upstream`, a bare repo that has a commit the local main doesn't. */
  async function upstreamRepo() {
    const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await run('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const repo = await tempRepo(kai)
    await git(repo, 'remote', 'add', 'upstream', bare)
    await git(repo, 'push', '-q', 'upstream', 'main')
    const other = join(await mkdtemp(join(tmpdir(), 'kernel-clone-')), 'repo')
    await run('git', ['clone', '-q', bare, other])
    await writeFile(join(other, 'later.md'), 'later\n')
    await run('git', ['-C', other, 'add', '-A'])
    await run('git', ['-C', other, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'later file'])
    await run('git', ['-C', other, 'push', '-q', 'origin', 'main'])
    return { repo, bare }
  }

  /** A kernel on the settings default base (`origin/main`), with `app` merged into its settings. */
  async function kernelOn(repo: string, app: object = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), ...app }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    return { k, h: k.handlers(), room: await k.addRoom(repo) }
  }

  const commit = async (path: string, file: string) => {
    await writeFile(join(path, file), 'x\n')
    await git(path, 'add', '-A')
    await git(path, 'commit', '-q', '-m', file)
  }
  const onBare = async (bare: string, branch: string) => (await exec('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  const localBranch = async (repo: string, branch: string) => (await git(repo, 'branch', '--list', branch)).trim() !== ''

  it("is used for the base, the branch list, push and archive's unpushed check", async () => {
    const { repo, bare } = await upstreamRepo()
    const { k, h, room } = await kernelOn(repo)
    await h['settings.setRoom']({ roomId: room.id, patch: { workspace: { remote: 'upstream' } } })

    // The origin/main default means the room's remote, fetched first, so the worktree has the commit local main lacks.
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    expect(a.baseRef).toBe('upstream/main')
    await expect(stat(join(a.path, 'later.md'))).resolves.toBeTruthy()
    expect(await h['git.branches']({ roomId: room.id })).toEqual(expect.arrayContaining(['main', 'upstream/main']))

    // Push to the room's remote, then archive and delete the branch: nothing is lost, so it goes.
    await commit(a.path, 'a.md')
    await h['workspaces.archive']({ workspaceId: a.id, deleteBranch: true, push: true })
    expect(await onBare(bare, a.branch)).toBe(true)
    expect(await localBranch(repo, a.branch)).toBe(false)

    // Pushed without -u, so the branch still tracks upstream/main: only upstream/<branch> says the commit is safe.
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    await commit(b.path, 'b.md')
    await git(b.path, 'push', '-q', 'upstream', b.branch)
    await k.archiveWorkspace(b.id, true)
    expect(await localBranch(repo, b.branch)).toBe(false)
    await k.stop()
  })

  it("uses the app's remote when the room sets none, and origin when neither does", async () => {
    const { repo } = await upstreamRepo()
    const app = await kernelOn(repo, { workspace: { remote: 'upstream' } })
    expect((await app.k.createWorkspace(app.room.id, { prompt: 'a', agentId: 'kai', title: 'One' })).baseRef).toBe('upstream/main')
    await app.k.stop()
    // No remote anywhere: origin, which this repo doesn't have, so the base falls back to local main as before.
    const none = await kernelOn(await tempRepo(kai))
    expect((await none.k.createWorkspace(none.room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })).baseRef).toBe('main')
    await none.k.stop()
  })
})

describe('hooks installer without SessionStart', () => {
  const old = { SessionStart: [{ hooks: [{ type: 'http', url: 'http://localhost:7420/hooks', timeout: 10 }] }, { hooks: [{ type: 'command', command: './mine.sh' }] }] }
  it('does not write a SessionStart entry and removes the one an old install left', () => {
    const next = withKernelHooks({ hooks: old }, 7420, 300)
    expect(next.hooks!.SessionStart).toEqual([{ hooks: [{ type: 'command', command: './mine.sh' }] }])
    expect(JSON.stringify(withKernelHooks({}, 7420, 300))).not.toContain('SessionStart')
  })

  it('reinstall rewrites the file and uninstall leaves other hooks alone', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-hooks-')), 'settings.json')
    await writeFile(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'http', url: 'http://localhost:7420/hooks' }] }] } }))
    await installHooks(file, 7420, 300)
    expect(JSON.parse(await readFile(file, 'utf8')).hooks.SessionStart).toBeUndefined()
    await uninstallHooks(file)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({})
  })
})

describe('rewriting the hooks on a settings change', () => {
  it('never adds hooks, and moves old http entries to the command form', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const port = 18000 + Math.floor(Math.random() * 800)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: port }))
    const claudeSettingsFile = join(await mkdtemp(join(tmpdir(), 'kernel-claude-')), 'settings.json')
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), claudeSettingsFile })
    await k.start()
    const h = k.handlers()
    const read = async () => JSON.stringify(JSON.parse(await readFile(claudeSettingsFile, 'utf8')))

    // Nothing installed: a timeout or port change writes nothing.
    await h['settings.set']({ patch: { permissions: { approvalTimeoutSec: 600 } } })
    await h['hooks.restart']({ port: port + 1 })
    await expect(stat(claudeSettingsFile)).rejects.toThrow()

    // Only old http entries: a timeout change rewrites them as commands.
    await writeFile(claudeSettingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: `http://localhost:${port}/hooks`, timeout: 10 }] }] } }))
    expect((await h['hooks.status']()).installed).toBe(false)
    await h['settings.set']({ patch: { permissions: { approvalTimeoutSec: 300 } } })
    expect(await read()).not.toContain('"http"')
    expect(await read()).toContain('-m 320 ')
    expect((await h['hooks.status']()).installed).toBe(true)

    // Current entries: a port change moves them.
    await h['hooks.restart']({ port })
    expect(await read()).toContain(`127.0.0.1:${port}/hooks`)
    expect(await read()).not.toContain(`127.0.0.1:${port + 1}/hooks`)
    await k.stop()
  })
})

describe('removing an Always allow rule', () => {
  it('stops covering the command on the agent\'s next tool call', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n' })
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    const room = await k.addRoom(repo)
    const deps = (k.sessions as unknown as { d: SessionDeps }).d
    const lists = { neverAllow: [], alwaysAsk: ['pnpm drizzle-kit push'] }
    deps.allowInRoom(room.id, 'pnpm drizzle-kit push')
    expect(bashVerdict('pnpm drizzle-kit push', lists, deps.roomAllow(room.id))).toBe('allow')

    const h = k.handlers()
    const updated = await h['rooms.update']({ roomId: room.id, patch: { allow: [] } })
    expect(updated.allow).toEqual([])
    // The same callbacks a running session holds read the room fresh, so the next command asks again.
    expect(bashVerdict('pnpm drizzle-kit push', lists, deps.roomAllow(room.id))).toBe('ask')
    await k.stop()
  })
})

async function startKernel(files?: Record<string, string>) {
  const repo = await tempRepo(files)
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  return { k, repo, dataDir, home, room: await k.addRoom(repo) }
}

describe('archiving a room', () => {
  it('archives every open workspace and keeps the room record', async () => {
    const { k, room } = await startKernel({ 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' })
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    const updated = await k.handlers()['rooms.update']({ roomId: room.id, patch: { archived: true } })
    expect(updated.archived).toBe(true)
    expect(k.store.room(room.id)?.path).toBe(room.path)
    for (const id of [a.id, b.id]) expect(k.store.workspaces(room.id).find((w) => w.id === id)?.status).toBe('archived')
    await k.stop()
  })

  it('keeps the room open and names the workspace when one cannot be archived', async () => {
    const { k, room } = await startKernel({ 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' })
    const ws = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'Stuck' })
    k.archiveWorkspace = async () => { throw new Error('git is locked') }
    await expect(k.handlers()['rooms.update']({ roomId: room.id, patch: { archived: true } })).rejects.toThrow(/stays open.*git is locked/)
    expect(k.store.room(room.id)?.archived).toBeFalsy()
    expect(ws.status).not.toBe('archived')
    await k.stop()
  })
})

describe('Linear token', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('is saved readable by the user only, and an empty token disconnects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    expect(await storedLinearToken(dir)).toBeUndefined()
    await saveLinearToken(dir, '  lin_api_abc ')
    expect(await storedLinearToken(dir)).toBe('lin_api_abc')
    expect((await stat(join(dir, 'integrations.json'))).mode & 0o777).toBe(0o600)
    await saveLinearToken(dir, '')
    expect(await storedLinearToken(dir)).toBeUndefined()
    expect((await stat(join(dir, 'integrations.json'))).mode & 0o777).toBe(0o600)
  })

  it('issues.list sends the stored token before the environment one', async () => {
    const { k, dataDir, room } = await startKernel()
    const seen: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => { seen.push(init.headers.authorization); return new Response(JSON.stringify({ data: { issues: { nodes: [] } } })) })
    vi.stubEnv('LINEAR_API_KEY', 'from-env')
    const h = k.handlers()
    await h['issues.list']({ roomId: room.id, query: '' })
    await saveLinearToken(dataDir, 'from-file')
    await h['issues.list']({ roomId: room.id, query: '' })
    expect(seen).toEqual(['from-env', 'from-file'])
    expect((await h['integrations.list'](undefined)).find((i) => i.id === 'linear')?.connected).toBe(true)
    await k.stop()
  })
})

describe('skills for a room', () => {
  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nBody`

  it('lists the user folder too, and a repo skill of the same name wins', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await mkdir(join(repo, '.claude', 'skills', 'plan'), { recursive: true })
    await writeFile(join(repo, '.claude', 'skills', 'plan', 'SKILL.md'), skill('plan', 'repo plan'))
    for (const [name, text] of [['plan', 'user plan'], ['verify', 'user verify']]) {
      await mkdir(join(home, '.claude', 'skills', name), { recursive: true })
      await writeFile(join(home, '.claude', 'skills', name, 'SKILL.md'), skill(name, text))
    }
    const list = await discoverSkills(repo, home)
    expect(list.find((s) => s.name === 'plan')).toMatchObject({ source: 'project', description: 'repo plan' })
    expect(list.find((s) => s.name === 'verify')).toMatchObject({ source: 'user', description: 'user verify' })
    expect((await discoverSkills(repo)).some((s) => s.name === 'verify')).toBe(false)
  })

  it('skills.list marks the ones the room switched off', async () => {
    const { k, repo, room } = await startKernel({ 'README.md': '# demo\n' })
    await mkdir(join(repo, '.claude', 'skills', 'plan'), { recursive: true })
    await writeFile(join(repo, '.claude', 'skills', 'plan', 'SKILL.md'), skill('plan', 'repo plan'))
    const h = k.handlers()
    expect((await h['skills.list']({ roomId: room.id })).find((s) => s.name === 'plan')?.enabled).toBe(true)
    await h['settings.setRoom']({ roomId: room.id, patch: { disabled: { skills: ['plan'] } } })
    expect((await h['skills.list']({ roomId: room.id })).find((s) => s.name === 'plan')?.enabled).toBe(false)
    await k.stop()
  })
})
