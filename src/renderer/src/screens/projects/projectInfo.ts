import type { AgentDef, AgentStatus, Approval, Project } from '@shared/types'

export type ProjectState = 'you' | 'working' | 'idle' | 'archived'

/** "Needs you" when something waits on the user, a pending approval (KERNEL-395). "Working" when any agent is busy. Real events only, no timers (CLAUDE.md). */
export function projectState(project: Project, approvals: Approval[], status: Record<string, AgentStatus> | undefined): ProjectState {
  if (project.archived) return 'archived'
  if (approvals.some((a) => a.projectId === project.id && a.status === 'pending')) return 'you'
  const busy: AgentStatus[] = ['working', 'planning', 'walking']
  return Object.values(status ?? {}).some((s) => busy.includes(s)) ? 'working' : 'idle'
}

export const stateLabel: Record<ProjectState, string> = { you: 'Needs you', working: 'Working', idle: 'Idle', archived: 'Archived' }

/** "2 min ago", "1 hour ago", "3 weeks ago". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour')
  if (s < 86400 * 14) return unit(Math.floor(s / 86400), 'day')
  return unit(Math.floor(s / (86400 * 7)), 'week')
}

/** What the Source column shows: owner/repo, a folder path with ~, or the starter kit's name. */
export function sourceOf(project: Project, home?: string): string {
  if (project.kind === 'scratch') return `${(project.repo ?? 'starter kit').split('/').pop()} template`
  if (project.kind === 'folder' || !project.repo) return home && project.path.startsWith(home + '/') ? '~' + project.path.slice(home.length) : project.path.replace(/^\/Users\/[^/]+/, '~')
  return project.repo
}

export const initial = (a: Pick<AgentDef, 'name'>) => a.name[0]?.toUpperCase() ?? '?'

/** The project's team, without the retired agents the list keeps for naming old workspaces, as Kernel's Theo (KERNEL-553). */
export const teamOf = (agents: AgentDef[] | undefined): AgentDef[] => (agents ?? []).filter((a) => !a.retired)

/** The project's letter: "Client A" is A, "Own app" is O. A last word of one character wins. */
export function projectLetter(name: string): string {
  const last = name.trim().split(/\s+/).pop() ?? ''
  return (last.length === 1 ? last : name.trim()[0] ?? '?').toUpperCase()
}

/** "2h ago", "1d ago", "3w ago", for tight columns. */
export function agoShort(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return `${Math.floor(s / (86400 * 7))}w ago`
}
