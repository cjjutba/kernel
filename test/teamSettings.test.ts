import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRepoSettings, saveTeamSettings, upsertTomlTable } from '../src/main/services/settings'

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
