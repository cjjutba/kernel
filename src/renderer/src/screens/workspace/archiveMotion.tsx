import { useEffect, useSyncExternalStore } from 'react'
import type { Route } from '@shared/types'
import { getState, subscribe } from '../../store'

/**
 * The archive beat (KERNEL-580, DESIGN.md Motion). When the workspace on screen is archived, the main panel swaps to the destination at once
 * (KERNEL-636). The beat is the stage the sidebar rows read (`useStage`): the destination's selected fill fades in, and Rowan's Lead row opens
 * in the place of the row the archived one stood on. It follows the store, not the call that archives, so a row's Archive, a PR's Archive,
 * closing a chat's last tab, ConfirmArchive, ConfirmArchiveChat and Kernel archiving after a merge all play it, and a failed archive, which
 * never stores the status, plays nothing.
 */

/** The beat on screen: the route the archive left and the route the app moved to. */
export interface Stage { id: number; from: Route; to: Route }

interface Pending { from: Route; workspaceId: string; timer: number }

let stage: Stage | null = null
let ender: number | undefined
let seq = 0
const watchers = new Set<() => void>()
const emit = () => watchers.forEach((w) => w())
const watch = (w: () => void) => { watchers.add(w); return () => { watchers.delete(w) } }

export const getStage = () => stage
export const useStage = () => useSyncExternalStore(watch, getStage)

export const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

/** True for the sidebar row the app moved to while the beat is on screen, so its fill can fade in (DESIGN.md, Motion: selected fill). A click anywhere else still switches at once. */
export function useArriving(current: boolean): boolean {
  const beat = useStage()
  return current && !!beat && sameRoute(beat.to, getState().ui.route)
}

let reduced: MediaQueryList | undefined

/** Reduced motion jumps: no fold, no fade. `matches` follows System Settings, so a change counts at the next archive. */
export const reducedMotion = () => (reduced ??= window.matchMedia('(prefers-reduced-motion: reduce)')).matches

/** A duration from tokens.css, in ms, so the CSS and the code never carry two copies of the number. */
export function cssMs(name: string): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 0
}

function end(id: number) {
  if (stage?.id !== id) return
  window.clearTimeout(ender)
  stage = null
  emit()
}

/**
 * Follows the store for the life of the app. A workspace on screen turning archived is noted in the same step as the status. The beat starts
 * when the route has left that workspace, in the same step when the archive moves it (archiveChat.ts) or in the commit after (PrHeader),
 * and in both before the browser paints.
 */
function start(): () => void {
  let last = getState()
  let pending: Pending | undefined
  const drop = () => { if (pending) window.clearTimeout(pending.timer); pending = undefined }
  const stop = subscribe(() => {
    const s = getState()
    const before = last
    last = s
    if (!pending && s.workspaces === before.workspaces) return
    const route = before.ui.route
    if (!pending && route.name === 'workspace') {
      const id = route.workspaceId
      const archivedNow = before.workspaces.find((w) => w.id === id)?.status !== 'archived' && s.workspaces.find((w) => w.id === id)?.status === 'archived'
      if (archivedNow && !reducedMotion()) {
        const mine: Pending = { from: route, workspaceId: id, timer: window.setTimeout(() => { if (pending === mine) pending = undefined }, 3000) }
        pending = mine
      }
    }
    if (!pending) return
    if (sameRoute(s.ui.route, pending.from)) {
      if (s.workspaces.find((w) => w.id === pending?.workspaceId)?.status !== 'archived') drop()
      return
    }
    const { from } = pending
    drop()
    window.clearTimeout(ender)
    stage = { id: ++seq, from, to: s.ui.route }
    const id = stage.id
    ender = window.setTimeout(() => end(id), cssMs('--archive-fold') + 100)
    emit()
  })
  return () => { stop(); drop(); window.clearTimeout(ender); stage = null; emit() }
}

/** Starts following the store while the app is mounted. App calls it once. */
export function useArchiveStage() {
  useEffect(() => start(), [])
}
