import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { Route } from '@shared/types'
import { getState, subscribe } from '../../store'
import './archiveMotion.css'

/**
 * The archive beat (KERNEL-580, DESIGN.md Motion). When the workspace on screen is archived, the screen it leaves is copied before the
 * archived status reaches the window, and the copy sits under the destination while that fades in over it. The sidebar rows read the same
 * stage (`useStage`) for the destination's selected fill and for the row the archived one stood on. It follows the store, not the call that
 * archives, so a row's Archive, a PR's Archive, closing a chat's last tab, ConfirmArchive, ConfirmArchiveChat and Kernel archiving after a merge
 * all play it, and a failed archive, which never stores the status, plays nothing.
 */

/** A copy of one screen: the cloned nodes, and the scroll offsets of the elements that had one, by their place in `[node, ...node.querySelectorAll('*')]`. */
interface Layer { node: HTMLElement; scrolls: [index: number, top: number, left: number][] }

/** The beat on screen: the copied screens under the destination, the route they left and the route the app moved to. */
export interface Stage { id: number; layers: Layer[]; from: Route; to: Route }

interface Pending { from: Route; workspaceId: string; layers: Layer[]; timer: number }

let stage: Stage | null = null
let running: Animation | undefined
let ender: number | undefined
let seq = 0
const watchers = new Set<() => void>()
const emit = () => watchers.forEach((w) => w())
const watch = (w: () => void) => { watchers.add(w); return () => { watchers.delete(w) } }

export const getStage = () => stage
export const useStage = () => useSyncExternalStore(watch, getStage)

export const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

/** Reduced motion jumps: no fold, no fade, no copy. Read at each archive so a change in System Settings counts at once. */
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A duration from archiveMotion.css, in ms, so the CSS and the code never carry two copies of the number. */
export function cssMs(name: string): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 0
}

const everything = (el: Element) => [el, ...Array.from(el.querySelectorAll('*'))]

function copyLayer(el: HTMLElement): Layer {
  const node = el.cloneNode(true) as HTMLElement
  const scrolls: Layer['scrolls'] = []
  const from = everything(el)
  const to = everything(node)
  from.forEach((a, i) => {
    const b = to[i]
    b.removeAttribute('id')
    if (a.scrollTop || a.scrollLeft) scrolls.push([i, a.scrollTop, a.scrollLeft])
    if (a instanceof HTMLTextAreaElement && b instanceof HTMLTextAreaElement) b.value = a.value
    if (a instanceof HTMLInputElement && b instanceof HTMLInputElement && a.type !== 'file') b.value = a.value
  })
  return { node, scrolls }
}

/**
 * What the main area shows now, as one layer per screen in it. A beat already on screen counts too, so a second archive that starts over the
 * first begins from what is painted: the first copy under the destination, that one at the opacity it has reached.
 */
function snapshot(): Layer[] | undefined {
  const main = document.querySelector('.app > .main')
  if (!main) return undefined
  const layers: Layer[] = []
  for (const el of Array.from(main.children)) {
    if (!(el instanceof HTMLElement)) continue
    if (el.hasAttribute('data-archive-ghost')) {
      for (const layer of Array.from(el.children)) if (layer instanceof HTMLElement) layers.push(copyLayer(layer))
      continue
    }
    const copy = copyLayer(el)
    const opacity = getComputedStyle(el).opacity
    if (opacity !== '1') copy.node.style.opacity = opacity
    const node = document.createElement('div')
    node.className = 'archive-layer'
    node.append(copy.node)
    layers.push({ node, scrolls: copy.scrolls.map(([i, top, left]) => [i + 1, top, left]) })
  }
  return layers.length ? layers : undefined
}

function end(id: number) {
  if (stage?.id !== id) return
  window.clearTimeout(ender)
  stage = null
  emit()
}

/**
 * Follows the store for the life of the app. A workspace on screen turning archived takes the copy, in the same step as the status and before
 * React draws it, which is when the screen still has its tabs. The beat starts when the route has left that workspace, in the same step when
 * the archive moves it (archiveChat.ts) or in the commit after (PrHeader), and in both before the browser paints.
 */
function start(): () => void {
  let last = getState()
  let pending: Pending | undefined
  const drop = () => { if (pending) window.clearTimeout(pending.timer); pending = undefined }
  const stop = subscribe(() => {
    const s = getState()
    const before = last
    last = s
    if (reducedMotion()) return drop()
    const route = before.ui.route
    if (!pending && s.workspaces !== before.workspaces && route.name === 'workspace') {
      const id = route.workspaceId
      const archivedNow = before.workspaces.find((w) => w.id === id)?.status !== 'archived' && s.workspaces.find((w) => w.id === id)?.status === 'archived'
      const layers = archivedNow ? snapshot() : undefined
      if (layers) {
        const mine: Pending = { from: route, workspaceId: id, layers, timer: window.setTimeout(() => { if (pending === mine) pending = undefined }, 3000) }
        pending = mine
      }
    }
    if (!pending) return
    if (sameRoute(s.ui.route, pending.from)) {
      if (s.workspaces.find((w) => w.id === pending?.workspaceId)?.status !== 'archived') drop()
      return
    }
    const { from, layers } = pending
    drop()
    running?.finish()
    window.clearTimeout(ender)
    stage = { id: ++seq, layers, from, to: s.ui.route }
    const id = stage.id
    ender = window.setTimeout(() => end(id), cssMs('--archive-screen') + 300)
    emit()
  })
  return () => { stop(); drop(); window.clearTimeout(ender); stage = null; emit() }
}

/** Starts following the store while the app is mounted, and returns the beat on screen. App calls it once. */
export function useArchiveStage(): Stage | null {
  useEffect(() => start(), [])
  return useStage()
}

/**
 * The copy of the screen the archive left, drawn under the destination in the main area. The destination is the next element, and fades in from 0
 * to 1 over `--archive-screen` on top of it. Its frame is the same as the copy's, so only the contents seem to fade. The copy takes no pointer
 * and no focus, and goes when the fade ends.
 */
export function ArchiveGhost({ stage: beat }: { stage: Stage }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    el.replaceChildren(...beat.layers.map((l) => l.node))
    for (const layer of beat.layers) {
      const all = everything(layer.node)
      for (const [i, top, left] of layer.scrolls) { all[i].scrollTop = top; all[i].scrollLeft = left }
    }
    const next = el.nextElementSibling
    if (!next) return end(beat.id)
    const fade = next.animate({ opacity: [0, 1] }, { duration: cssMs('--archive-screen'), easing: 'ease-out' })
    running = fade
    fade.finished.then(() => end(beat.id), () => undefined)
    return () => { fade.cancel(); if (running === fade) running = undefined }
  }, [beat])
  return <div ref={host} className="archive-ghost" data-archive-ghost aria-hidden="true" inert />
}
