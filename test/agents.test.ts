import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFromFile, loadAgents, parseFrontmatter, renderAgentFile, retireAgent, saveAgent } from '../src/main/services/agents'

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
})
