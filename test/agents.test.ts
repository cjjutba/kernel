import { describe, expect, it, vi } from 'vitest'
import { watch } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFromFile, createAgent, draftAgent, loadAgents, parseFrontmatter, renderAgentFile, restoreAgent, retireAgent, saveAgent, updateAgent, watchAgents } from '../src/main/services/agents'

// fs.watch timing varies under load, so wait for the callback instead of sleeping a fixed time.
const WATCH = { timeout: 10_000 }

/**
 * Resolves once the watches started so far deliver events, and returns a stop for the probe. On macOS, libuv runs every
 * directory watch in the process on one FSEvents stream and restarts it when a watch is added or closed, and events in
 * that gap are dropped. A probe watched after the others firing means the restarted stream covers theirs too. The probe
 * stays open until the test ends, since closing it restarts the stream again (KERNEL-187).
 */
async function watchesLive(): Promise<() => void> {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'))
  let seen = false
  const probe = watch(dir, { persistent: false }, () => { seen = true })
  await vi.waitFor(async () => { await writeFile(join(dir, 'p'), String(Date.now())); expect(seen).toBe(true) }, { ...WATCH, interval: 100 })
  return () => probe.close()
}

describe('agents', () => {
  it('parses frontmatter including folded lines and lists', () => {
    const { meta, body } = parseFrontmatter('---\nname: lumi\ndescription: Designer. Checks every screen\n  against DESIGN.md.\ntools: Read, Grep\n---\nYou are Lumi.')
    expect(meta.description).toBe('Designer. Checks every screen against DESIGN.md.')
    expect(meta.tools).toBe('Read, Grep')
    expect(body).toBe('You are Lumi.')
  })
  it('derives display name, role and lead', () => {
    const a = agentFromFile('/r/.claude/agents/kai.md', '---\nname: kai\ndescription: Frontend engineer. Builds UI.\nmodel: sonnet\ntools: Read, Edit\n---\nBody')
    expect(a).toMatchObject({ id: 'kai', name: 'Kai', role: 'Frontend', model: 'sonnet', tools: ['Read', 'Edit'], lead: false })
    const r = agentFromFile('/r/.claude/agents/rowan.md', '---\nname: rowan\ndescription: Lead. Plans and hands out tasks.\n---\n')
    expect(r.lead).toBe(true)
  })
  it('round-trips, loads lead first, and retires out of the loaded folder', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await saveAgent(repo, { id: 'kai', description: 'Frontend engineer.', prompt: 'You are Kai.' })
    await saveAgent(repo, { id: 'rowan', description: 'Lead.', prompt: 'You are Rowan.', lead: true, role: 'Lead' })
    const list = await loadAgents(repo)
    expect(list.map((a) => a.id)).toEqual(['rowan', 'kai'])
    await retireAgent(repo, 'kai')
    expect((await loadAgents(repo)).map((a) => a.id)).toEqual(['rowan'])
    expect(await readdir(join(repo, '.claude', 'retired-agents'))).toEqual(['kai.md'])
  })
  it('renders a file Claude Code can read', () => {
    expect(renderAgentFile({ id: 'ivy', description: 'QA.', prompt: 'Test things.', tools: ['Read', 'Bash'] })).toContain('tools: Read, Bash')
  })
  it('returns no agents for a repo without the folder', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'none-'))
    await mkdir(join(repo, '.claude'))
    await writeFile(join(repo, '.claude', 'settings.json'), '{}')
    expect(await loadAgents(repo)).toEqual([])
  })

  it('round-trips effort and keeps frontmatter Kernel does not manage when saving an edit', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    await writeFile(join(repo, '.claude', 'agents', 'kai.md'), '---\nname: kai\ndescription: Frontend engineer.\nmodel: sonnet\ncolor: green\ntools: Read, Edit\n---\nYou are Kai.\n')
    const saved = await updateAgent(repo, 'kai', { description: 'UI work.\nFollows DESIGN.md.', effort: 'xhigh', tools: ['Read', 'Bash'], skills: ['/verify'], prompt: 'New instructions.' })
    expect(saved).toMatchObject({ id: 'kai', description: 'UI work. Follows DESIGN.md.', effort: 'xhigh', tools: ['Read', 'Bash'], skills: ['/verify'], model: 'sonnet', prompt: 'New instructions.' })
    const file = await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')
    expect(file).toContain('color: green')
    expect(file).toContain('effort: xhigh')
    await expect(updateAgent(repo, 'kai', { description: '  ' })).rejects.toThrow(/description/)
    await expect(updateAgent(repo, 'nobody', {})).rejects.toThrow(/not in/)
  })
  it('drafts a file from a description and creates it once', async () => {
    const d = draftAgent({ description: 'a designer who checks every screen against DESIGN.md', name: 'Lumi', model: 'opus' })
    expect(d).toMatchObject({ id: 'lumi', name: 'Lumi', model: 'opus', file: '.claude/agents/lumi.md' })
    expect(d.text).toContain('name: lumi')
    expect(d.text).toContain('role: Designer')
    expect(draftAgent({ description: 'Reviews security in every diff' }).id).toBe('reviewer')
    expect(() => draftAgent({ description: '   ' })).toThrow(/Describe/)
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    const made = await createAgent(repo, d)
    expect(made).toMatchObject({ id: 'lumi', role: 'Designer', model: 'opus' })
    expect((await loadAgents(repo)).map((a) => a.id)).toEqual(['lumi'])
    await expect(createAgent(repo, d)).rejects.toThrow(/already on the team/)
    await expect(createAgent(repo, { ...d, text: '---\nname: Bad Name\ndescription: x\n---\nbody' })).rejects.toThrow(/lowercase/)
    await expect(createAgent(repo, { ...d, text: '---\nname: ok\n---\nbody' })).rejects.toThrow(/description/)
  })
  it('lists retired agents and restores one, refusing when the name is taken', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await saveAgent(repo, { id: 'kai', description: 'Frontend engineer.', prompt: 'You are Kai.' })
    await retireAgent(repo, 'kai')
    expect((await loadAgents(repo, { retired: true })).map((a) => [a.id, a.retired])).toEqual([['kai', true]])
    await saveAgent(repo, { id: 'kai', description: 'A newer Kai.', prompt: 'x' })
    await expect(restoreAgent(repo, 'kai')).rejects.toThrow(/already an agent/)
    await retireAgent(repo, 'kai')
    await restoreAgent(repo, 'kai')
    expect((await loadAgents(repo)).map((a) => a.id)).toEqual(['kai'])
    await expect(retireAgent(repo, 'ghost')).rejects.toThrow(/not in/)
  })
  it('tells the watcher about files added outside Kernel, even before the folder exists', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude'))
    let hits = 0
    const stops = [watchAgents(repo, () => { hits++ }, 20)]
    try {
      stops.push(await watchesLive())
      await mkdir(join(repo, '.claude', 'agents'))
      await vi.waitFor(() => expect(hits).toBeGreaterThan(0), WATCH)
      // The folder's own watch started just now, in the restart that may drop the next change.
      stops.push(await watchesLive())
      const afterDir = hits
      await writeFile(join(repo, '.claude', 'agents', 'theo.md'), '---\nname: theo\ndescription: Reviewer.\n---\nx')
      await vi.waitFor(() => expect(hits).toBeGreaterThan(afterDir), WATCH)
    } finally { for (const stop of stops) stop() }
  })
  it('saves an edit without touching nested frontmatter or quoted values', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    const hooks = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh'
    await writeFile(join(repo, '.claude', 'agents', 'kai.md'), `---\nname: kai\ndescription: "Frontend: builds UI"\n# keep this comment\n${hooks}\nmodel: sonnet\n---\nYou are Kai.\n`)
    const saved = await updateAgent(repo, 'kai', { effort: 'high' })
    expect(saved).toMatchObject({ description: 'Frontend: builds UI', effort: 'high', model: 'sonnet' })
    const file = await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')
    expect(file).toContain(hooks)
    expect(file).toContain('# keep this comment')
    expect(file).toContain('description: "Frontend: builds UI"')
    // A new colon in a description is quoted so the file stays valid YAML, and the draft does the same.
    await updateAgent(repo, 'kai', { description: 'Designer: checks # every screen' })
    expect(await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')).toContain('description: "Designer: checks # every screen"')
    expect(draftAgent({ description: 'a reviewer: checks diffs', name: 'Rex' }).text).toContain('description: "A reviewer: checks diffs."')
    expect(agentFromFile('/r/rex.md', draftAgent({ description: 'a reviewer: checks diffs', name: 'Rex' }).text).description).toBe('A reviewer: checks diffs.')
  })
})
