import type { Project } from '@shared/types'

/** `onProject('')` on the Pull requests tab means every project. */
export const ALL_PROJECTS = ''

/** A project's name in a picker. Two projects with the same name show the folder they are in too. */
export function projectLabel(project: Project, all: Project[]): string {
  if (all.filter((r) => r.name === project.name).length < 2) return project.name
  const parts = project.path.split('/').filter(Boolean)
  return `${project.name} · ${parts.slice(-2).join('/')}`
}
