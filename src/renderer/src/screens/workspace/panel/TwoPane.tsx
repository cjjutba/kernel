import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** A panel at least this wide has room for a list and the file or diff beside it. Narrower, the list takes the panel and a pick opens in a tab (KERNEL-1096). */
export const WIDE_FROM = 560

/** The width of the box `ref` is on, kept as it changes. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const watch = new ResizeObserver(() => setWidth(el.clientWidth))
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  return { ref, width, wide: width >= WIDE_FROM }
}

/**
 * The body of the Files and Changes tabs (Pen 9.3, 9.5): the list on the left, 250px, and what is picked on the right. In a panel too narrow for both, the list is all there is and
 * `view` is not drawn, so the owner opens a pick in a tab of its own instead.
 */
export function TwoPane({ list, view, wide, boxRef }: { list: ReactNode; view: ReactNode; wide: boolean; boxRef: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={boxRef} className="two-pane" data-wide={wide || undefined}>
      <div className="two-list">{list}</div>
      {wide && <div className="two-view">{view}</div>}
    </div>
  )
}
