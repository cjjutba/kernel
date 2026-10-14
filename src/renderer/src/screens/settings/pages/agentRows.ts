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

/** The role Settings shows for an agent. Kernel's def still carries the engine's `Lead`, so it reads Kernel, which the name repeats and rows hide. */
export const agentRole = (a: Pick<AgentDef, 'role'> & { lead?: boolean }): string => (a.lead ? 'Kernel' : a.role.trim())

/** The role to show beside the name, or '' when it is empty or repeats the name. */
export function shownRole(a: Pick<AgentDef, 'name' | 'role'> & { lead?: boolean }): string {
  const role = agentRole(a)
  return role.toLowerCase() === a.name.trim().toLowerCase() ? '' : role
}

export function agentLabel(a: Pick<AgentDef, 'name' | 'role'> & { lead?: boolean }): string {
  const role = shownRole(a)
  return role ? `${a.name} · ${role}` : a.name
}

/** The plugin an agent comes from: the part of its id before the colon. */
export const pluginOf = (a: Pick<AgentDef, 'id'>): string => (a.id.includes(':') ? a.id.slice(0, a.id.indexOf(':')) : a.id)

export function agentSource(a: Pick<AgentDef, 'id' | 'builtIn' | 'origin'>): string {
  if (a.builtIn) return 'Built into Kernel'
  const group = agentGroup(a)
  if (group === 'personal') return `~/.claude/agents/${a.id}.md`
  if (group === 'plugin') return `From the ${pluginOf(a)} plugin`
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
