import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { PushEvent } from '@shared/ipc'
import type { RoomSetupStep } from '@shared/types'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { draftAgent } from '../src/main/services/agents'
import { loadRepoSettings, saveTeamSettings, upsertTomlTable } from '../src/main/services/settings'
import { tempRepo } from './helpers'

// KERNEL-397: `[team]` goes in the settings.toml the repo commits, so Kernel changes only that table and keeps the rest as written.
describe('[team] in .kernel/settings.toml', () => {
  const FILE = `# Kernel settings for this repo. Commit it so the whole team shares it.

[files]
# Copied into every new worktree.
copy = [".env", ".env.local"]

[team]
# Our own reviewer.
reviewer = "code-reviewer"
helpers = [
  "test-runner", # runs tests only
  "doc-writer",
]

[scripts]
setup = "pnpm install"
`

  it('sets, replaces and removes keys, keeping comments and other tables', () => {
    const next = upsertTomlTable(FILE, 'team', { lead: 'architect', reviewer: 'none', helpers: null })
    expect(next).toBe(FILE.replace('reviewer = "code-reviewer"\nhelpers = [\n  "test-runner", # runs tests only\n  "doc-writer",\n]\n', 'reviewer = "none"\nlead = "architect"\n'))
  })

  it('adds the table at the end when the file has none, and removes it when nothing is left', () => {
    const plain = '[files]\ncopy = [".env"]\n'
    const added = upsertTomlTable(plain, 'team', { members: ['scout', 'kai'] })
    expect(added).toBe('[files]\ncopy = [".env"]\n\n[team]\nmembers = ["scout", "kai"]\n')
    expect(upsertTomlTable(added, 'team', { members: null })).toBe(plain)
    expect(upsertTomlTable('', 'team', { lead: 'kernel-lead' })).toBe('[team]\nlead = "kernel-lead"\n')
    expect(upsertTomlTable(plain, 'team', { lead: null })).toBe(plain)
  })

  it('refuses a file it cannot change without touching the rest', () => {
    expect(() => upsertTomlTable('team = { lead = "a" }\n', 'team', { lead: 'b' })).toThrow(/Edit the file by hand/)
    expect(() => upsertTomlTable('[team\nlead = 1\n', 'team', { lead: 'b' })).toThrow(/isn't valid TOML/)
  })

  it('writes the shared file and reads back with where each value came from', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'team-settings-'))
    await mkdir(join(repo, '.kernel'))
    await writeFile(join(repo, '.kernel', 'settings.toml'), FILE)
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[team]\nlead = "mine"\n')
    let rs = await loadRepoSettings(repo)
    expect(rs.team).toEqual({ reviewer: 'code-reviewer', helpers: ['test-runner', 'doc-writer'], lead: 'mine' })
    expect([rs.sources['team.reviewer'], rs.sources['team.lead']]).toEqual(['shared', 'local'])
    rs = await saveTeamSettings(repo, { lead: 'architect', helpers: [], reviewer: '  ' })
    expect(rs.team).toEqual({ lead: 'mine' })
    expect(rs.sources['team.lead']).toBe('override')
    const shared = await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')
    expect(shared).toContain('# Our own reviewer.\nlead = "architect"\n')
    expect(shared).toContain('# Kernel settings for this repo.')
    expect((await saveTeamSettings(await mkdtemp(join(tmpdir(), 'team-settings-')), { lead: 'kernel-lead' })).team).toEqual({ lead: 'kernel-lead' })
  })
})

// KERNEL-465: a repo with more agents than one team needs. Room setup asks who joins, and `[team] roster` keeps the pick.
describe('[team] roster', () => {
  const STARTERS = join(__dirname, '..', 'docs', 'starter-agents')
  const agent = (id: string, head = '', body = 'Open a pull request when the task is done.'): [string, string] =>
    [`.claude/agents/${id}.md`, `---\nname: ${id}\ndescription: Engineer.\n${head}---\n${body}\n`]
  const DEVS = Array.from({ length: 11 }, (_, i) => `dev${i + 10}`)

  /** A room made from a repo with these agent files, and these in ~/.claude/agents, once Room setup is done. */
  async function setUp(files: [string, string][], personal: [string, string][] = []) {
    const repo = await tempRepo({ 'README.md': '# shop\n', ...Object.fromEntries(files) })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await mkdir(join(home, '.claude', 'agents'), { recursive: true })
    for (const [path, text] of personal) await writeFile(join(home, path), text)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home, starterDir: STARTERS, claudeSettingsFile: join(home, 'claude-settings.json') })
    onTestFinished(() => k.stop())
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.rooms.createRoom({ source: 'folder', name: 'Shop', from: repo, team: [], autostart: false })
    const steps = await new Promise<RoomSetupStep[]>((resolve) => {
      const on = (e: PushEvent) => {
        if (e.type !== 'room.setup' || e.roomId !== room.id || e.steps.some((s) => s.state === 'wait' || s.state === 'run')) return
        bus.off('push', on)
        resolve(e.steps)
      }
      bus.on('push', on)
    })
    return { k, h: k.handlers(), repo, room, seat: steps.find((s) => s.id === 'agents')!, settings: () => readFile(join(repo, '.kernel', 'settings.toml'), 'utf8') }
  }

  it('asks Room setup for a roster past 12 agents, and keeps the team to the agents picked', async () => {
    const { k, h, room, seat, settings } = await setUp([...DEVS.map((id) => agent(id)), agent('architect', '', 'You design.'), agent('scout', 'tools: Read\n')])
    expect(seat).toMatchObject({ state: 'ok', detail: '13 agents found in .claude/agents', brought: 13, roster: { agents: 13, needed: true, suggested: DEVS } })

    // Ids that name nobody, and repeats, aren't kept.
    let team = await h['agents.setTeam']({ roomId: room.id, team: { roster: ['dev10', 'dev11', 'dev11', 'ghost'] }, from: 'setup' })
    expect(team.map((a) => a.id)).toEqual(['kernel-lead', 'dev10', 'dev11', 'kernel-reviewer'])
    expect(await settings()).toContain('\n[team]\nroster = ["dev10", "dev11"]\n')
    expect(await k.team.rosterOf(room.id)).toEqual({ agents: 13, needed: false, suggested: DEVS })

    // A new hire, just for the user, joins their team here instead of landing off it, and the team's roster stays as it was
    // (KERNEL-466).
    await h['agents.create']({ roomId: room.id, draft: draftAgent({ description: 'Builds the billing service.', name: 'billing' }) })
    expect((await k.team.agents(room.id)).map((a) => a.id)).toContain('billing')
    expect(await settings()).toContain('\n[team]\nroster = ["dev10", "dev11"]\n')

    // An agent with open work stays on the team until the work is archived.
    await k.workspaces.createWorkspace(room.id, { prompt: 'Build it', agentId: 'dev10', title: 'Cart' })
    await expect(h['agents.setTeam']({ roomId: room.id, team: { roster: ['dev11'] } })).rejects.toThrow('Dev10 has open work. Archive it first, or keep Dev10 on the team.')

    // No roster is every agent again.
    team = await h['agents.setTeam']({ roomId: room.id, team: { roster: null } })
    expect(team).toHaveLength(16)
    expect(await settings()).not.toContain('[team]')
  })

  it('counts personal agents, which join every room, and says where they came from', async () => {
    const { seat } = await setUp([agent('api')], DEVS.concat('dev21').map((id) => agent(id)))
    expect(seat).toMatchObject({ detail: '13 agents found in .claude/agents and ~/.claude/agents', brought: 1, roster: { agents: 13, needed: true } })
  })

  it("doesn't ask with 12 agents or fewer, and keeps a subagent the user makes a teammate", async () => {
    const { h, room, seat, settings } = await setUp([agent('api'), agent('web', 'tools: Read, Edit, Write, Bash\n', 'You build the UI.'), agent('architect', '', 'You design.')])
    expect(seat).toMatchObject({ detail: 'Api, Architect, Web from .claude/agents, Rowan and Theo from Kernel', brought: 3, roster: { agents: 3, needed: false, suggested: ['api', 'web'] } })
    const team = await h['agents.setTeam']({ roomId: room.id, team: { members: ['api', 'web', 'architect'] } })
    expect(team.find((a) => a.id === 'architect')).toMatchObject({ member: true })
    expect(team.find((a) => a.id === 'architect')?.warnings).toBeUndefined()
    // Only the exception goes to the file: Api and Web take tasks anyway.
    expect(await settings()).toContain('\n[team]\nmembers = ["architect"]\n')
  })
})
