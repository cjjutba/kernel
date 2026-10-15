import type { GithubIssue, LinearIssue, LinearScope, ProjectTracker } from '@shared/types'

export const FRESH_MS = 30_000
export const MAX_LISTS = 8
export const MAX_DETAILS = 30

export type Stamped<T> = { value: T; at: number }
export type LinearLists = { mine: LinearIssue[]; all: LinearIssue[] }

const stamp = <T>(value: T, now: number): Stamped<T> => ({ value, at: now })

export const isFresh = (at: number, now = Date.now()) => now - at < FRESH_MS

let epoch = 0
let trackers = new Map<string, Stamped<ProjectTracker>>()
let scope: Stamped<LinearScope> | null = null
let lists = new Map<string, Stamped<LinearLists>>()
let github = new Map<string, Stamped<GithubIssue[]>>()
let details = new Map<string, Stamped<unknown>>()
let selected = new Map<string, string>()

export const generation = () => epoch
const current = (gen?: number) => gen === undefined || gen === epoch

export const detailKey = (tracker: 'linear' | 'github', projectId: string, id: string) => `${tracker}|${projectId}|${id}`

export const getTracker = (projectId: string) => trackers.get(projectId)
export function setTracker(projectId: string, tracker: ProjectTracker, gen?: number, now = Date.now()) {
  if (current(gen)) trackers.set(projectId, stamp(tracker, now))
}

export const getScope = () => scope ?? undefined
export function setScope(value: LinearScope, gen?: number, now = Date.now()) {
  if (current(gen)) scope = stamp(value, now)
}

export const getLinearLists = (key: string) => lists.get(key)
export function setLinearLists(key: string, value: LinearLists, gen?: number, now = Date.now()) {
  if (!current(gen)) return
  lists.delete(key)
  lists.set(key, stamp(value, now))
  while (lists.size > MAX_LISTS) lists.delete(lists.keys().next().value as string)
}

export const getGithubList = (projectId: string) => github.get(projectId)
export function setGithubList(projectId: string, value: GithubIssue[], gen?: number, now = Date.now()) {
  if (current(gen)) github.set(projectId, stamp(value, now))
}

export const peekDetail = <T>(key: string) => details.get(key) as Stamped<T> | undefined
export function setDetail<T>(key: string, value: T, gen?: number, now = Date.now()) {
  if (!current(gen)) return
  details.delete(key)
  details.set(key, stamp(value, now))
  while (details.size > MAX_DETAILS) details.delete(details.keys().next().value as string)
}
export function touchDetail(key: string) {
  const hit = details.get(key)
  if (!hit) return
  details.delete(key)
  details.set(key, hit)
}

export const getSelected = (key: string) => selected.get(key)
export const setSelected = (key: string, id: string) => { selected.set(key, id) }

const dropDetails = (prefix: string) => { for (const k of [...details.keys()]) if (k.startsWith(prefix)) details.delete(k) }

export function forgetTracker(projectId: string) {
  epoch++
  trackers.delete(projectId)
  github.delete(projectId)
  selected.delete(`github|${projectId}`)
  dropDetails(`github|${projectId}|`)
}

export function forgetLinear() {
  epoch++
  scope = null
  lists = new Map()
  selected.delete('linear')
  dropDetails('linear|')
}

export function forgetTrackers() {
  epoch++
  trackers = new Map()
}

export function forgetAll() {
  forgetLinear()
  forgetTrackers()
  github = new Map()
  selected = new Map()
  details = new Map()
}

export function resetIssuesCache() {
  forgetAll()
  epoch = 0
}
