import type { Project } from '@shared/types'
import { oneOf, useRemembered } from '../../remember'
import { useStore, type State } from '../../store'

export type ProjectSort = 'recent' | 'name'

/** How "My projects" is ordered (SidebarProjectsMenu): by the newest activity in each project, or by name. It is kept across launches. */
export const useProjectSort = () => useRemembered<ProjectSort>('kernel.projectSort', oneOf<ProjectSort>(['recent', 'name'], 'recent'))

/** Whether the sidebar also lists the projects hidden from it. Off until the user turns it on. */
export function useShowHidden(): [boolean, (v: boolean) => void] {
  const [v, set] = useRemembered<'on' | 'off'>('kernel.showHiddenProjects', oneOf<'on' | 'off'>(['on', 'off'], 'off'))
  return [v === 'on', (on) => set(on ? 'on' : 'off')]
}

/** When something last happened in the project: its newest activity event, or the day it was made. Real events only. */
export function lastActiveOf(project: Project, s: Pick<State, 'activity' | 'lastActivity'>): number {
  const logged = Object.values(s.lastActivity[project.id] ?? {})
  const windowed = s.activity.find((e) => e.projectId === project.id)?.ts
  return Math.max(project.createdAt, windowed ?? 0, ...logged)
}

/** The projects the sidebar lists, in the order the user picked. Equal times keep the saved order. */
export function useSidebarProjects(): Project[] {
  const [sort] = useProjectSort()
  const [hidden] = useShowHidden()
  const projects = useStore((s) => s.projects)
  const activity = useStore((s) => s.activity)
  const lastActivity = useStore((s) => s.lastActivity)
  const shown = projects.filter((p) => !p.archived && (hidden || !p.hidden))
  if (sort === 'name') return [...shown].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  const at = new Map(shown.map((p) => [p.id, lastActiveOf(p, { activity, lastActivity })]))
  return [...shown].sort((a, b) => at.get(b.id)! - at.get(a.id)!)
}
