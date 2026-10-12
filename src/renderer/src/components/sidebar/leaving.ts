import { useCallback, useEffect, useState } from 'react'
import { cssMs } from '../../screens/workspace/archiveMotion'
import { slotKey, type Slot } from './slots'

/**
 * A row the room draws. A row that leaves because its workspace was archived stays in the list while it folds (`leaving`), and the Lead's row that
 * takes a chat's place opens while that happens (`opening`). A workspace archived ahead of its chat waits as it was (`held`). `until` is when the
 * fold or the opening is over, if its animation never reports back.
 */
export interface Shown { key: string; row: Slot; leaving: boolean; held: boolean; opening: boolean; until: number }

/** What becomes of a row that is no longer in the list because its workspace was archived: it folds now, waits for its chat to fold, or just goes. */
export type Fate = 'fold' | 'hold' | undefined

const plain = (rows: Slot[]): Shown[] => rows.map((row) => ({ key: slotKey(row), row, leaving: false, held: false, opening: false, until: 0 }))

/**
 * The list to draw after `rows` changed. A row gone from `rows` for being archived keeps its place, folding, for `hold` ms, unless it is a chat's
 * workspace and the chat is still being archived: that waits where it is and folds in the step the chat does, so a chat and its workspaces fold in
 * the same frames. A row that was folding keeps doing so. Any other row that goes (a folded chat's workspaces, a room closing) leaves at once. When a
 * chat folds away and the Lead's row shows up in the same step, it opens as the chat closes (DESIGN.md, Motion: the last chat in a room).
 */
export function mergeShown(prev: Shown[], rows: Slot[], fate: (row: Slot) => Fate, now: number, hold: number): Shown[] {
  const was = new Map(prev.map((p) => [p.key, p]))
  const next = plain(rows).map((item) => ({ ...item, opening: was.get(item.key)?.opening ?? false, until: was.get(item.key)?.until ?? 0 }))
  const kept = new Set(next.map((i) => i.key))
  const folding: Shown[] = []
  prev.forEach((p) => {
    if (kept.has(p.key)) return
    if (p.leaving) { if (p.until > now) folding.push(p); return }
    const f = fate(p.row)
    if (f === 'fold') folding.push({ ...p, leaving: true, held: false, opening: false, until: now + hold })
    else if (f === 'hold') folding.push({ ...p, held: true })
  })
  if (folding.some((f) => f.leaving && !was.get(f.key)?.leaving && f.row.kind === 'chat')) {
    const lead = next.find((i) => i.key === 'lead' && !was.has('lead'))
    if (lead) { lead.opening = true; lead.until = now + hold }
  }
  for (const f of folding) {
    const at = prev.findIndex((p) => p.key === f.key)
    let after = -1
    for (let j = at - 1; j >= 0 && after < 0; j--) after = next.findIndex((i) => i.key === prev[j].key)
    next.splice(after + 1, 0, f)
  }
  return next
}

const settled = (list: Shown[], now: number) => list.filter((i) => !i.leaving || i.until > now).map((i) => (i.opening && i.until <= now ? { ...i, opening: false } : i))

/**
 * The rows of a room as they are drawn: `rows`, plus the archived ones that are still folding. `motion` is false while the room is closed or the
 * system asks for reduced motion, and then a row that goes is gone in the same frame. `settle` is for a row whose animation ended. The timer
 * covers an animation that never does, such as a room folded away mid-fold.
 */
export function useShown(rows: Slot[], motion: boolean, fate: (row: Slot) => Fate): [Shown[], (key: string) => void] {
  const [shown, setShown] = useState(() => plain(rows))
  const [seen, setSeen] = useState(rows)
  if (rows !== seen) {
    setSeen(rows)
    setShown(motion ? mergeShown(shown, rows, fate, performance.now(), cssMs('--archive-fold') + 100) : plain(rows))
  }
  useEffect(() => {
    const due = shown.filter((i) => i.leaving || i.opening).map((i) => i.until)
    if (!due.length) return
    const id = window.setTimeout(() => setShown((list) => settled(list, performance.now())), Math.max(0, Math.min(...due) - performance.now()) + 1)
    return () => window.clearTimeout(id)
  }, [shown])
  const settle = useCallback((key: string) => setShown((list) => list.filter((i) => !(i.key === key && i.leaving)).map((i) => (i.key === key ? { ...i, opening: false } : i))), [])
  return [shown, settle]
}
