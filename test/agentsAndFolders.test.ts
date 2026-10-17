import { describe, expect, it } from 'vitest'
import type { AgentDef } from '@shared/types'
import { filterAgents, mentionMenu, mentionPart } from '../src/renderer/src/screens/workspace/composer/autocomplete'
import { searchFiles } from '../src/main/services/files'
import { tempRepo } from './helpers'

const agent = (id: string, name: string, extra: Partial<AgentDef> = {}) => ({ id, file: `.claude/agents/${id}.md`, name, role: 'Engine', description: '', lead: false, prompt: '', ...extra }) as AgentDef
const team = [agent('kernel-lead', 'Kernel', { lead: true }), agent('sean', 'Sean'), agent('christian', 'Christian')]

describe('@ in the Lead composer (KERNEL-743)', () => {
  it('offers Sean under Agents, and not the Lead itself', () => {
    const menu = mentionMenu([], filterAgents(team, 'sean'))
    expect(menu.map((g) => g.label)).toEqual(['Agents'])
    expect(menu[0].rows.map((r) => r.kind === 'agent' && r.agent.name)).toEqual(['Sean'])
    expect(filterAgents(team, 'kernel')).toEqual([])
    expect(mentionPart(menu[0].rows[0])).toEqual({ type: 'agent', name: 'Sean', agentId: 'sean' })
  })

  it('offers src/ first for @src, with no Agents heading in a composer that passes no team', async () => {
    const repo = await tempRepo({ 'src/a.ts': 'a\n', 'src/lib/b.ts': 'b\n', 'docs/src-notes.md': 'c\n' })
    const menu = mentionMenu(await searchFiles(repo, 'src'))
    expect(menu.map((g) => g.label)).toEqual(['Files'])
    expect(mentionPart(menu[0].rows[0])).toEqual({ type: 'file', name: 'src/', path: 'src/', dir: true })
  })

  it('lists teammates above files and folders when both match', async () => {
    const repo = await tempRepo({ 'src/sean/a.ts': 'a\n' })
    const menu = mentionMenu(await searchFiles(repo, 'sean'), filterAgents(team, 'sean'))
    expect(menu.map((g) => g.label)).toEqual(['Agents', 'Files'])
  })
})
