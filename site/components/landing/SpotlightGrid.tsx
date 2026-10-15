'use client'

import { useRef, type ReactNode } from 'react'

// The landing page's cards, with a light that follows the pointer: each `.spot-card` inside brightens its border nearest
// the pointer, so moving over a group of cards lights the edges it passes (globals.css, Spotlight cards). The bento, the
// privacy map and the closing panel all use it. One listener on the wrapper sets each card's pointer position as CSS
// variables, so nothing re-renders. Mouse only: touch screens never see it.

export function SpotlightGrid({ className, children }: { className: string; children: ReactNode }) {
  const grid = useRef<HTMLDivElement>(null)
  const move = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || !grid.current) return
    for (const card of grid.current.querySelectorAll<HTMLElement>('.spot-card')) {
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${e.clientX - r.left}px`)
      card.style.setProperty('--my', `${e.clientY - r.top}px`)
    }
  }
  return (
    <div ref={grid} onPointerMove={move} className={`spot-grid ${className}`}>
      {children}
    </div>
  )
}
