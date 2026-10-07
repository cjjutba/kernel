import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverSkills, searchFiles } from '../src/main/services/files'
import { commitHunks, listHunks } from '../src/main/services/hunks'
import { git } from '../src/main/services/exec'
import { tempRepo } from './helpers'

describe('@ file search', () => {
  it('ranks file name matches first and skips ignored files', async () => {
    const repo = await tempRepo({ 'src/app/invoices/table.tsx': 'a\n', 'tests/invoices.spec.ts': 'b\n', 'src/pdf/invoice-pdf.ts': 'c\n', 'src/db/schema/invoices.ts': 'd\n', 'notes/in-voice.md': 'e\n', '.gitignore': 'dist\n' })
    await mkdir(join(repo, 'dist'), { recursive: true })
    await writeFile(join(repo, 'dist/invoice.js'), 'x\n')
    const hits = (await searchFiles(repo, 'inv', 4)).map((f) => f.path)
    expect(hits).toHaveLength(4)
    expect(hits).not.toContain('dist/invoice.js')
    expect(hits).not.toContain('src/app/invoices/table.tsx')
    expect((await searchFiles(repo, 'tbl')).map((f) => f.path)).toEqual(['src/app/invoices/table.tsx'])
    expect(await searchFiles(repo, 'zzz')).toEqual([])
  })
})

describe('skills discovery', () => {
  it('reads project skills and commands, then adds the built-ins', async () => {
    const repo = await tempRepo({
      '.claude/skills/verify/SKILL.md': '---\nname: verify\ndescription: Run tests and attach the output\n---\nBody\n',
      '.claude/skills/plain/SKILL.md': '# Plain skill\nBody\n',
      '.claude/commands/ship.md': '---\ndescription: Ship it\n---\nDo it\n',
      '.claude/commands/git/sync.md': 'Sync the branch\n'
    })
    const skills = await discoverSkills(repo)
    expect(skills.map((s) => s.name)).toEqual(['git:sync', 'plain', 'ship', 'verify', 'compact', 'review', 'init'])
    expect(skills.find((s) => s.name === 'verify')).toMatchObject({ description: 'Run tests and attach the output', source: 'project' })
    expect(skills.find((s) => s.name === 'plain')?.description).toBe('Plain skill')
    expect(skills.find((s) => s.name === 'git:sync')?.description).toBe('Sync the branch')
  })
})

describe('hunks', () => {
  const lines = (n: number, tweak: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => tweak[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

  it('splits a file into mine and agent hunks and commits only the picked ones', async () => {
    const repo = await tempRepo({ 'checkout.ts': lines(60) })
    // Before the workspace started: an edit near the top, snapshotted as the baseline.
    await writeFile(join(repo, 'checkout.ts'), lines(60, { 12: 'mine 12' }))
    const baseline = (await git(repo, 'stash', 'create')).trim()
    // The agent edits further down.
    await writeFile(join(repo, 'checkout.ts'), lines(60, { 12: 'mine 12', 45: 'agent 45' }))
    const hunks = await listHunks(repo, { since: baseline, baselineRef: baseline })
    expect(hunks.map((h) => [h.owner, h.lines, h.added, h.removed])).toEqual([['agent', '42-48', 1, 1], ['mine', '9-15', 1, 1]])

    await commitHunks(repo, [hunks[0]], 'Round once')
    const committed = await git(repo, 'show', 'HEAD:checkout.ts')
    expect(committed).toContain('agent 45')
    expect(committed).not.toContain('mine 12')
    expect(await readFile(join(repo, 'checkout.ts'), 'utf8')).toContain('mine 12')
    expect((await git(repo, 'log', '-1', '--format=%s')).trim()).toBe('Round once')

    // HEAD moved past the baseline. The committed hunk is gone, and the earlier change is still "mine", not reversed.
    const after = await listHunks(repo, { since: baseline, baselineRef: baseline })
    expect(after.map((h) => [h.owner, h.lines, h.added, h.removed])).toEqual([['mine', '9-15', 1, 1]])
    expect(after[0].patch).toContain('+mine 12')
    await commitHunks(repo, after, 'Mine too')
    expect(await git(repo, 'show', 'HEAD:checkout.ts')).toContain('mine 12')
    expect(await listHunks(repo, { since: baseline, baselineRef: baseline })).toEqual([])
  })

  it('treats a clean start as having no earlier changes, and lists agent hunks again after a commit', async () => {
    const repo = await tempRepo({ 'a.ts': lines(30) })
    const baseline = (await git(repo, 'rev-parse', 'HEAD')).trim()
    await writeFile(join(repo, 'a.ts'), lines(30, { 3: 'one', 25: 'two' }))
    const hunks = await listHunks(repo, { since: baseline, baselineRef: baseline })
    expect(hunks.map((h) => h.owner)).toEqual(['agent', 'agent'])
    await commitHunks(repo, [hunks[0]], 'First')
    const rest = await listHunks(repo, { since: baseline, baselineRef: baseline })
    expect(rest.map((h) => h.lines)).toEqual(['22-28'])
    await commitHunks(repo, rest, 'Second')
    expect(await listHunks(repo, { since: baseline, baselineRef: baseline })).toEqual([])
  })

  it('refuses an empty pick', async () => {
    const repo = await tempRepo()
    await expect(commitHunks(repo, [], 'x')).rejects.toThrow('Pick at least one')
  })
})
