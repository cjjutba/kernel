import { useEffect, useRef, type RefObject } from 'react'

/**
 * Brings the open issue's row into view once per issue, so a list that opens scrolled to the top, or to a spot kept from last time,
 * still shows it, and the open issue wins over the kept scroll position (`stopRestore` ends it first). A row that is already in view stays put.
 * `again` changes when rows appear (a group opening), so the effect looks again.
 */
export function useReveal(list: RefObject<HTMLElement | null>, id: string | undefined, ready: boolean, again: unknown, stopRestore: () => void) {
  const done = useRef<string | undefined>(undefined)
  const stop = useRef(stopRestore)
  stop.current = stopRestore
  useEffect(() => {
    if (!ready || !id || done.current === id) return
    const row = list.current?.querySelector<HTMLElement>(`[data-keep-id="${id.replace(/["\\]/g, '\\$&')}"]`)
    if (!row) return
    done.current = id
    const raf = requestAnimationFrame(() => {
      stop.current()
      const box = list.current?.getBoundingClientRect()
      const at = row.getBoundingClientRect()
      // 36px at the top is the sticky group header.
      if (box && (at.top < box.top + 36 || at.bottom > box.bottom)) row.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(raf)
  }, [list, id, ready, again])
}
