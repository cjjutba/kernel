'use client'

import { useEffect, useState, type ReactNode } from 'react'

/** The sticky nav's bar: clear at the very top of the page, and a blurred background with a hairline once you scroll. */
export function NavFrame({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const read = () => setScrolled(window.scrollY > 8)
    const frame = requestAnimationFrame(read)
    window.addEventListener('scroll', read, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', read)
    }
  }, [])
  return (
    <header
      data-scrolled={scrolled || undefined}
      className={`sticky top-0 z-5 border-b transition-colors duration-300 ${
        scrolled ? 'border-white/6 bg-canvas/72 backdrop-blur-nav' : 'border-transparent bg-transparent'
      }`}
    >
      {children}
    </header>
  )
}
