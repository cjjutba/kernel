'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import type { DitheringProps } from '@paper-design/shaders-react'

// The site's one motion texture: a field of dithered square dots (Paper's Dithering shader, WebGL). The hero, the
// closing panel and the footer each draw it differently, with their own shape, grain and pace.
//
// - Loads after the page, and only once its box comes near the screen, so it stays out of the first load and pages
//   that never scroll to it never start it. The library pauses it while it is off screen or the tab is hidden.
// - Holds one still frame with reduced motion. Under browser automation it draws nothing: the shaders paint a moment
//   after load, and e2e screenshots taken either side of that moment wouldn't match.
// - Takes its gray from the site's tokens, and draws at one pixel per dot even on retina screens.
// Decorative: the box is hidden from screen readers and lets clicks through.

const Dithering = dynamic(() => import('./ditherShader').then((m) => m.Dithering), { ssr: false })

/** Token grays for the dots, darkest first. */
type Tone = 'line-strong' | 'edge' | 'rule'

type Props = {
  shape: NonNullable<DitheringProps['shape']>
  type?: DitheringProps['type']
  /** Dot size in CSS pixels. */
  size?: number
  scale?: number
  /** How fast it moves. Kept slow everywhere, so it reads as a surface rather than an animation. */
  speed?: number
  /** Where in its motion it starts, in ms, which sets the still frame too. */
  frame?: number
  tone?: Tone
  /** The box: position, size, and its mask (globals.css, Dither fields). */
  className: string
}

export function Dither({ shape, type = '4x4', size = 3, scale = 1, speed = 0.3, frame = 0, tone = 'rule', className }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [color, setColor] = useState<string | null>(null)
  const [clear, setClear] = useState('')
  const [near, setNear] = useState(false)
  const [still, setStill] = useState(false)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const root = getComputedStyle(document.documentElement)
    setColor(root.getPropertyValue(`--color-${tone}`).trim())
    setClear(root.getPropertyValue('--color-clear').trim())
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => setStill(motion.matches)
    onMotion()
    motion.addEventListener('change', onMotion)
    const seen = new IntersectionObserver(([entry]) => entry?.isIntersecting && !navigator.webdriver && setNear(true), { rootMargin: '400px 0px' })
    seen.observe(el)
    return () => {
      seen.disconnect()
      motion.removeEventListener('change', onMotion)
    }
  }, [tone])

  return (
    <div ref={box} aria-hidden="true" className={`pointer-events-none ${className}`}>
      {color && near ? (
        <Dithering
          colorBack={clear}
          colorFront={color}
          shape={shape}
          type={type}
          size={size}
          scale={scale}
          frame={frame}
          speed={still ? 0 : speed}
          minPixelRatio={1}
          maxPixelCount={1920 * 1080}
          className="size-full"
        />
      ) : null}
    </div>
  )
}
