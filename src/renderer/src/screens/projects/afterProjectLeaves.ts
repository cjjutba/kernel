import type { Project, Route } from '@shared/types'

/** Where to go once a project is removed or archived: All projects while another active project remains, else New chat, since an empty table is a dead end. `leaving` is excluded because the store may not have caught up yet. */
export function afterProjectLeaves(projects: Project[], leaving: string): Route {
  return projects.some((p) => p.id !== leaving && !p.archived) ? { name: 'projects' } : { name: 'leadNew', projectId: '' }
}
