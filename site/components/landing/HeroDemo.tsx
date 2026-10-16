'use client'

import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'
import leadPlan from '@/public/images/lead-plan.png'
import { ReplayIcon } from '@/components/ui/icons'

/** The demo is the app at its own size. The frame scales it down to fit. */
const APP_WIDTH = 1440
/** Below this the app's sidebar, chat and panel don't fit, so phones and narrow windows keep the screenshot. */
const WIDE = '(min-width: 900px)'
/** Built by `pnpm demo:build` at the repo root: the real renderer on demo data (demo/README.md). */
const DEMO_SRC = '/demo/index.html'

type FromDemo = { source: 'kernel-demo'; type: 'ready' }

/**
 * The hero's product shot is the real Kernel UI, running on sample data in a frame, for the visitor to explore. Nothing
 * clicks by itself. The screenshot stays underneath until the app is ready, and it is all a phone sees.
 */
export function HeroDemo() {
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [wide, setWide] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [live, setLive] = useState(false)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const resize = new ResizeObserver(([entry]) => entry && setScale(entry.contentRect.width / APP_WIDTH))
    resize.observe(el)
    return () => resize.disconnect()
  }, [])

  // Load the app the first time the hero is on screen.
  useEffect(() => {
    const el = box.current
    if (!el || !wide || mounted) return
    const seen = new IntersectionObserver(([entry]) => entry?.isIntersecting && setMounted(true), { threshold: 0.2 })
    seen.observe(el)
    return () => seen.disconnect()
  }, [wide, mounted])

  useEffect(() => {
    const listen = (e: MessageEvent<FromDemo>) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow || e.data?.source !== 'kernel-demo') return
      if (e.data.type === 'ready') setLive(true)
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [])

  const startOver = () => {
    setLive(false)
    frame.current?.contentWindow?.postMessage({ source: 'kernel-site', type: 'restart' }, window.location.origin)
  }

  const showApp = wide && mounted
  return (
    <div className="mx-auto max-w-hero-shot">
      {/* The app sits in a bezel like a laptop's, with a glow along its top edge (globals.css, Demo bezel). */}
      <div className="demo-bezel">
        <span aria-hidden="true" className="demo-edge" />
        <div ref={box} className="demo-screen relative aspect-16/10 overflow-hidden bg-surface-2">
          <Image
            src={leadPlan}
            alt="Kernel open on a new chat in the Kernel project, with past chats and other projects in the sidebar"
            sizes="(max-width: 1328px) calc(100vw - 48px), 1280px"
            preload
            quality={90}
            className={`block h-auto w-full transition-opacity duration-fade ${live && showApp ? 'opacity-0' : ''}`}
            aria-hidden={live && showApp ? true : undefined}
          />
          {showApp && (
            <iframe
              ref={frame}
              src={DEMO_SRC}
              title="Kernel, running on sample data. Explore it."
              loading="eager"
              className={`demo-stage absolute top-0 left-0 z-raise bg-surface-2 ${live ? 'fade-in' : 'opacity-0'}`}
              style={{ transform: `scale(${scale})` }}
            />
          )}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 px-2 text-small text-faint max-nav:justify-center">
        <p className="flex items-center gap-2">
          <span aria-hidden="true" className="size-1.5 rounded-pill bg-faint" />
          {wide ? 'Live demo · Sample data' : 'Live demo on larger screens'}
        </p>
        {wide && (
          <button
            type="button"
            onClick={startOver}
            disabled={!mounted}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-faint transition-colors hover:bg-tint-soft hover:text-ink disabled:opacity-50"
          >
            <ReplayIcon size={12} />
            Start over
          </button>
        )}
      </div>
    </div>
  )
}
