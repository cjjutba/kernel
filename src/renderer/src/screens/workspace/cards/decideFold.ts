import { useRef, useSyncExternalStore } from 'react'
import type { Approval, Decision } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { attempt } from '../MessageActions'
import { cssMs, reducedMotion } from '../archiveMotion'
import { withOwners } from './planOwners'
import './decideFold.css'

/**
 * The one rule for every approval button (KERNEL-834): pressing it sends the decision at once, with no spinner and no busy label, and the approval
 * folds away the way an archived row does. The phase of each pressed approval lives here, outside any component, so the Inbox keys, a row and its
 * detail pane, and a card all see the same press, and a second press of any button of the same approval does nothing.
 * `folding` runs for --archive-fold, then `folded` hides what folded. A failed call forgets the press: the approval comes back, with the "Could not send your answer" toast.
 */
type Phase = 'folding' | 'folded'

const phases = new Map<string, Phase>()
const timers = new Map<string, number>()
const watchers = new Set<() => void>()
let version = 0
const watch = (w: () => void) => { watchers.add(w); return () => { watchers.delete(w) } }
const set = (id: string, phase?: Phase) => {
  if (phase) phases.set(id, phase); else phases.delete(id)
  version++
  watchers.forEach((w) => w())
}

/** Sends the decision now. A press on an approval that was already pressed does nothing. Reduced motion skips the fold and changes in place. */
export function decideAtOnce(a: Approval, decision: Decision): void {
  if (phases.has(a.id)) return
  if (reducedMotion()) set(a.id, 'folded')
  else {
    set(a.id, 'folding')
    timers.set(a.id, window.setTimeout(() => { timers.delete(a.id); if (phases.get(a.id) === 'folding') set(a.id, 'folded') }, cssMs('--archive-fold') + 50))
  }
  void attempt('Could not send your answer', async () => actions.approvals.upsert(await call('approvals.decide', { id: a.id, decision: withOwners(a, decision) }))).then((ok) => {
    if (ok) return
    window.clearTimeout(timers.get(a.id))
    timers.delete(a.id)
    set(a.id)
  })
}

/** Where an approval's press stands: `folding` while it folds, `folded` once it has, nothing before the press or after a failure. */
export const useFoldPhase = (id: string): Phase | undefined => useSyncExternalStore(watch, () => phases.get(id))

/**
 * `items` with the ones whose approval was just pressed kept in their place while they fold, after the store has stopped listing them.
 * `held` is true for those. Without motion the row is gone with the store's list.
 * `max` caps the rows shown: the item that moved up into the list while a row folds waits until the fold is done (KERNEL-839).
 */
export function useHeldRows<T>(items: T[], keyOf: (item: T) => string, idOf: (item: T) => string | undefined, max = Infinity): { item: T; held: boolean }[] {
  useSyncExternalStore(watch, () => version)
  const prev = useRef<T[]>([])
  const keys = new Set(items.map(keyOf))
  const out = items.map((item) => ({ item, held: false }))
  prev.current.forEach((item, i) => {
    const id = idOf(item)
    if (!keys.has(keyOf(item)) && id && phases.get(id) === 'folding') out.splice(Math.min(i, out.length), 0, { item, held: true })
  })
  while (out.length > max) {
    const last = out.map((o) => o.held).lastIndexOf(false)
    if (last < 0) break
    out.splice(last, 1)
  }
  prev.current = out.map((o) => o.item)
  return out
}
