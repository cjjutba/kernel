'use client'

import { useEffect, useRef, useState } from 'react'
import { PauseIcon, PlayIcon } from '@/components/ui/icons'

// A feature clip: a recording of the real app (demo/clips.ts), muted and looping. It loads once it nears the screen, plays
// while it is in view and pauses when it leaves. With reduced motion asked for it stays on its poster until played.

type Props = { name: string; width: number; height: number; label: string }

export function Clip({ name, width, height, label }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const held = useRef(false)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    held.current = matchMedia('(prefers-reduced-motion: reduce)').matches
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        if (entry.isIntersecting) {
          if (!video.getAttribute('src')) video.src = `/clips/${name}.mp4`
          if (!held.current) void video.play().catch(() => undefined)
        } else video.pause()
      },
      { threshold: 0.3 }
    )
    io.observe(video)
    return () => io.disconnect()
  }, [name])

  const toggle = () => {
    const video = ref.current
    if (!video) return
    if (video.paused) {
      held.current = false
      if (!video.getAttribute('src')) video.src = `/clips/${name}.mp4`
      void video.play().catch(() => undefined)
    } else {
      held.current = true
      video.pause()
    }
  }

  return (
    <div className="group relative">
      <video
        ref={ref}
        poster={`/clips/${name}.jpg`}
        width={width}
        height={height}
        muted
        loop
        playsInline
        preload="none"
        aria-label={label}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="block h-auto w-full"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? `Pause: ${label}` : `Play: ${label}`}
        className={`absolute right-3 bottom-3 inline-flex size-8 items-center justify-center rounded-full border border-edge bg-canvas/80 text-ink-2 backdrop-blur-nav transition hover:border-edge-hover hover:text-ink focus-visible:opacity-100 ${
          playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        }`}
      >
        {playing ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
      </button>
    </div>
  )
}
