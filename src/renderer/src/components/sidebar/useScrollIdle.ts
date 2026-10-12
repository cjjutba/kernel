import { useCallback, useEffect, useRef, type RefObject } from 'react'

/** How long after the last scroll event the thumb stays up. */
const IDLE_MS = 1000

/**
 * Marks a scroll list with `data-scrolling` while it scrolls and for a second after, so sidebar.css can show its thumb (KERNEL-597). The attribute is set on
 * the element itself, not in state, so a scroll never renders the sidebar. Returns the handler for the list's `onScroll`.
 */
export function useScrollIdle(ref: RefObject<HTMLElement | null>) {
  const timer = useRef<number>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return useCallback(() => {
    ref.current?.setAttribute('data-scrolling', '')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => ref.current?.removeAttribute('data-scrolling'), IDLE_MS)
  }, [ref])
}
