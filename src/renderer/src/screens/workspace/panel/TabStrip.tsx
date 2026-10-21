import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { IconButton, Tabs } from '../../../ui'

/**
 * A strip of tabs that scrolls sideways when they don't fit (KERNEL-489). A side with hidden tabs fades into the panel and shows an arrow that scrolls to the
 * next one (KERNEL-514). Only the tablist scrolls, so what sits beside the strip stays pinned. The arrows are for the pointer: the tablist's arrow keys already
 * reach every tab, so they stay out of the tab order, and one that goes away can't strand focus.
 */
export function TabStrip(props: ComponentProps<typeof Tabs>) {
  const wrap = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ left: false, right: false })
  const ids = props.tabs.map((t) => t.id).join()
  const list = () => wrap.current?.querySelector<HTMLElement>('[role="tablist"]') ?? null

  // Which sides have tabs cut off, again when the strip scrolls, when the panel or a tab changes size and when tabs come and go.
  useLayoutEffect(() => {
    const el = list()
    if (!el) return
    const measure = () => {
      const left = el.scrollLeft > 1
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    for (const tab of el.children) resize.observe(tab)
    return () => { el.removeEventListener('scroll', measure); resize.disconnect() }
  }, [ids])

  // The tab shown scrolls into view when it changes, clear of the fade (KERNEL-489).
  useLayoutEffect(() => { list()?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [props.value, ids])

  // One tab over: the first tab the fade hides on that side comes fully into view, or the last one on that side when the fade only covers part of a tab.
  const step = (dir: 1 | -1) => {
    const el = list()
    if (!el) return
    const fade = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0
    const box = el.getBoundingClientRect()
    const tabs = [...el.children] as HTMLElement[]
    const hidden = (dir > 0 ? tabs : [...tabs].reverse()).find((t) => {
      const r = t.getBoundingClientRect()
      return dir > 0 ? r.left >= box.right - fade : r.right <= box.left + fade
    })
    ;(hidden ?? tabs[dir > 0 ? tabs.length - 1 : 0])?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' })
  }

  return (
    <div ref={wrap} className="tab-strip">
      <Tabs {...props} />
      {more.left && <IconButton icon="right" size={14} label="More tabs" className="tab-more" data-side="left" tabIndex={-1} onClick={() => step(-1)} />}
      {more.right && <IconButton icon="right" size={14} label="More tabs" className="tab-more" data-side="right" tabIndex={-1} onClick={() => step(1)} />}
    </div>
  )
}

