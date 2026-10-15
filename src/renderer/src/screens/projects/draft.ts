import { useSyncExternalStore } from 'react'
import type { NewProjectRequest, ProjectKind } from '@shared/types'
import { actions, getState } from '../../store'

/**
 * The teammates a new project starts with, starter files copied into .claude/agents (KERNEL-397, KERNEL-553). Kernel leads from the app itself, so it is not listed.
 */
export const STARTER_TEAM = [
  { id: 'kai', name: 'Kai', role: 'Frontend', builtIn: false },
  { id: 'noor', name: 'Noor', role: 'Backend', builtIn: false },
  { id: 'ivy', name: 'Ivy', role: 'QA', builtIn: false },
  { id: 'theo', name: 'Theo', role: 'Reviewer', builtIn: false }
] as const

/** The starter teammates Team can add to a team that has agents. */
export const STARTER_TEAMMATES = STARTER_TEAM.filter((m) => !m.builtIn)

/** What New project is filling in. Connect a repo and Open a folder write to it, then hand back to New project. */
export interface ProjectDraft extends Omit<NewProjectRequest, 'source' | 'from' | 'desc' | 'baseBranch'> {
  desc: string
  baseBranch: string
  source: ProjectKind
  /** owner/repo, an absolute folder path, or a template repo, by `source`. */
  from: string
  /** True once the name was typed by hand, so picking another repo stops renaming the project. */
  named: boolean
}

/** The starter files a new project gets: Settings, Agents, New projects start with. The pair is Kai. */
export function defaultTeam(): string[] {
  const pair = getState().settings?.team.defaultTemplate === 'pair'
  return STARTER_TEAMMATES.filter((m) => !pair || m.id === 'kai').map((m) => m.id)
}

const blank = (): ProjectDraft => ({ source: 'repo', name: '', named: false, desc: '', from: '', baseBranch: '', team: defaultTeam(), autostart: true })

let draft: ProjectDraft = blank()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export const getDraft = () => draft
export function patchDraft(patch: Partial<ProjectDraft>) { draft = { ...draft, ...patch }; emit() }
export function resetDraft(patch: Partial<ProjectDraft> = {}) { draft = { ...blank(), ...patch }; emit() }
export function useDraft(): ProjectDraft {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => draft)
}

/** Open New project from scratch, or prefilled by one of the sidebar shortcuts. */
export function openNewProject(patch: Partial<ProjectDraft> = {}) {
  resetDraft(patch)
  actions.ui.openModal({ name: 'newProject' })
}

/** "client-c" becomes "Client C". */
export const titleOf = (slug: string) => slug.split(/[-_.\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

/** Home folder as macOS shows it, for text only. */
export const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

/** Where a repo or scratch project will be created. */
export const cloneFolder = (d: Pick<ProjectDraft, 'cloneTo' | 'from' | 'name' | 'source'>) =>
  d.cloneTo ?? `~/Projects/${(d.source === 'repo' ? baseName(d.from) : d.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
