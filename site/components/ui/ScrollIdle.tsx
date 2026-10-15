'use client'

import { useEffect } from 'react'

// The app's scrollbars, on the site (src/renderer/src/ui/scrollIdle.ts, KERNEL-597, KERNEL-602). Every scroll area, the
// page included, draws one thin thumb on its edge that shows only while the area scrolls and fades out 800ms after
// (globals.css, Scrollbars). This sets `data-scrolling` on whatever scrolls, through one capturing listener per event
// on the document, so the sidebar, the page, search results and code blocks all behave alike and nothing renders.
// A press on a native scrollbar holds the thumb up until the button is released, as in the app.

const IDLE_MS = 800

function hasScrollbar(el: Element): boolean {
  const s = getComputedStyle(el)
  if (s.scrollbarWidth === 'none') return false
  const scrollsY = (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
  const scrollsX = (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
  return scrollsY || scrollsX
}

function onScrollbar(el: Element, x: number, y: number): boolean {
  const r = el.getBoundingClientRect()
  return x - r.left - el.clientLeft >= el.clientWidth || y - r.top - el.clientTop >= el.clientHeight
}

export function ScrollIdle() {
  useEffect(() => {
    const timers = new Map<Element, ReturnType<typeof setTimeout>>()
    let held: Element | undefined
    const clear = (el: Element) => {
      clearTimeout(timers.get(el))
      timers.delete(el)
    }
    const touch = (el: Element) => {
      el.setAttribute('data-scrolling', '')
      clear(el)
      if (el === held) return
      timers.set(
        el,
        setTimeout(() => {
          timers.delete(el)
          el.removeAttribute('data-scrolling')
        }, IDLE_MS)
      )
    }
    const release = () => {
      const el = held
      held = undefined
      if (el) touch(el)
    }
    // The page's own scroll comes from the document, and its scrollbar takes its style from <html>.
    const onScroll = (e: Event) => touch(e.target instanceof Element ? e.target : document.documentElement)
    const onMove = (e: PointerEvent) => {
      if (e.buttons === 0) release()
    }
    const onDown = (e: PointerEvent) => {
      const root = document.documentElement
      const target = e.target instanceof Element ? e.target : null
      // The page's scrollbar sits past the root's client width.
      const el = e.clientX >= root.clientWidth ? root : target && hasScrollbar(target) && onScrollbar(target, e.clientX, e.clientY) ? target : null
      if (!el) return
      release()
      held = el
      clear(el)
      el.setAttribute('data-scrolling', '')
    }
    const options = { capture: true, passive: true } as const
    document.addEventListener('scroll', onScroll, options)
    document.addEventListener('pointermove', onMove, options)
    document.addEventListener('pointerdown', onDown, options)
    document.addEventListener('pointerup', release, options)
    document.addEventListener('pointercancel', release, options)
    window.addEventListener('blur', release)
    return () => {
      document.removeEventListener('scroll', onScroll, options)
      document.removeEventListener('pointermove', onMove, options)
      document.removeEventListener('pointerdown', onDown, options)
      document.removeEventListener('pointerup', release, options)
      document.removeEventListener('pointercancel', release, options)
      window.removeEventListener('blur', release)
      for (const el of timers.keys()) el.removeAttribute('data-scrolling')
      timers.forEach((t) => clearTimeout(t))
    }
  }, [])
  return null
}
