'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import type { DocHeading } from '@/lib/docs'

// On this page: the page's sections, with the one you're reading lit and a bar on the rail that slides to it as you
// scroll. A section counts as read once its heading passes the line under the sticky nav.

const LINE = 112

export function Toc({ headings }: { headings: DocHeading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? '')
  const list = useRef<HTMLUListElement>(null)
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null)

  const measure = useCallback(() => {
    const ids = headings.map((h) => h.id)
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[]
    if (!els.length) return
    // At the bottom of the page the last sections may never reach the line, so the last one wins there.
    const atEnd = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
    let current = els[0]!.id
    for (const el of els) if (el.getBoundingClientRect().top <= LINE) current = el.id
    if (atEnd) current = els.at(-1)!.id
    setActive(current)
  }, [headings])

  useEffect(() => {
    let frame = requestAnimationFrame(measure)
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [measure])

  useLayoutEffect(() => {
    const item = list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(active)}"]`)
    if (item) setBar({ top: item.offsetTop, height: item.offsetHeight })
  }, [active])

  const go = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    e.preventDefault()
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
    history.replaceState(null, '', `#${id}`)
    setActive(id)
  }

  if (!headings.length) return null
  return (
    <nav aria-label="On this page">
      <p className="flex items-center gap-2 text-small font-medium text-ink">
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
        </svg>
        On this page
      </p>
      <div className="relative mt-3">
        <span aria-hidden="true" className="absolute top-0 bottom-0 left-0 w-px bg-line" />
        {bar ? (
          <span
            aria-hidden="true"
            className="toc-bar absolute left-0 w-px bg-ink"
            style={{ transform: `translateY(${bar.top}px)`, height: bar.height }}
          />
        ) : null}
        <ul ref={list} className="flex flex-col">
          {headings.map((h) => {
            const on = h.id === active
            return (
              <li key={h.id} data-id={h.id}>
                <a
                  href={`#${h.id}`}
                  onClick={(e) => go(e, h.id)}
                  aria-current={on ? 'location' : undefined}
                  className={`block py-1 text-small transition-colors duration-200 ${h.depth === 3 ? 'pl-6' : 'pl-3.5'} ${on ? 'text-ink' : 'text-muted hover:text-ink-2'}`}
                >
                  {h.text}
                </a>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
