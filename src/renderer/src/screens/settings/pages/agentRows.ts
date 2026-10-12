import type { AgentDef, AgentOrigin } from '@shared/types'

export type AgentGroup = 'repo' | 'personal' | 'plugin'

export const AGENT_GROUPS: { key: AgentGroup; title: string }[] = [
  { key: 'repo', title: 'In this repo' },
  { key: 'personal', title: 'Yours' },
  { key: 'plugin', title: 'From plugins' }
]

export function agentGroup(a: { builtIn?: AgentDef['builtIn']; origin?: AgentOrigin }): AgentGroup {
  if (a.builtIn) return 'repo'
  return a.origin === 'personal' ? 'personal' : a.origin === 'plugin' ? 'plugin' : 'repo'
}

export function agentLabel(a: Pick<AgentDef, 'name' | 'role'>): string {
  const role = a.role.trim()
  return !role || role.toLowerCase() === a.name.trim().toLowerCase() ? a.name : `${a.name} · ${role}`
}

export function agentSource(a: Pick<AgentDef, 'id' | 'builtIn' | 'origin'>): string {
  if (a.builtIn) return 'Built into Kernel'
  const group = agentGroup(a)
  if (group === 'personal') return `~/.claude/agents/${a.id}.md`
  if (group === 'plugin') return `From the ${a.id.includes(':') ? a.id.slice(0, a.id.indexOf(':')) : a.id} plugin`
  return `.claude/agents/${a.id}.md`
}

export function cleanDescription(text: string): string {
  return text
    .replace(/<example>[\s\S]*?<\/example>/gi, ' ')
    .replace(/<commentary>[\s\S]*?<\/commentary>/gi, ' ')
    .replace(/<\/?(?:example|commentary)>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
