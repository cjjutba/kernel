import { useSyncExternalStore } from 'react'
import type { NewRoomRequest, RoomKind } from '@shared/types'
import { actions } from '../../store'

/** Everyone you can seat from docs/starter-agents. Rowan is the Lead and always sits. */
export const STARTER_TEAM = [
  { id: 'rowan', name: 'Rowan', role: 'Lead' },
  { id: 'kai', name: 'Kai', role: 'Frontend' },
  { id: 'noor', name: 'Noor', role: 'Backend' },
  { id: 'ivy', name: 'Ivy', role: 'QA' },
  { id: 'theo', name: 'Theo', role: 'Reviewer' }
] as const

/** What New room is filling in. Connect a repo and Open a folder write to it, then hand back to New room. */
export interface RoomDraft extends Omit<NewRoomRequest, 'source' | 'from' | 'desc' | 'baseBranch'> {
  desc: string
  baseBranch: string
  source: RoomKind
  /** owner/repo, an absolute folder path, or a template repo, by `source`. */
  from: string
  /** True once the name was typed by hand, so picking another repo stops renaming the room. */
  named: boolean
}

const blank = (): RoomDraft => ({ source: 'repo', name: '', named: false, desc: '', from: '', baseBranch: 'main', team: STARTER_TEAM.map((m) => m.id), autostart: true })

let draft: RoomDraft = blank()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export const getDraft = () => draft
export function patchDraft(patch: Partial<RoomDraft>) { draft = { ...draft, ...patch }; emit() }
export function resetDraft(patch: Partial<RoomDraft> = {}) { draft = { ...blank(), ...patch }; emit() }
export function useDraft(): RoomDraft {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => draft)
}

/** Open New room from scratch, or prefilled by one of the sidebar shortcuts. */
export function openNewRoom(patch: Partial<RoomDraft> = {}) {
  resetDraft(patch)
  actions.ui.openModal({ name: 'newRoom' })
}

/** "client-c" becomes "Client C". */
export const titleOf = (slug: string) => slug.split(/[-_.\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

/** Home folder as macOS shows it, for text only. */
export const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

/** Where a repo or scratch room will be created. */
export const cloneFolder = (d: Pick<RoomDraft, 'cloneTo' | 'from' | 'name' | 'source'>) =>
  d.cloneTo ?? `~/Projects/${(d.source === 'repo' ? baseName(d.from) : d.name || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
