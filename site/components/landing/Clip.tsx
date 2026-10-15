'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PauseIcon, PlayIcon } from '@/components/ui/icons'

// A feature clip: a recording of the real app (demo/clips.ts), muted. Only one clip plays at a time, so the page never
// has two stories running side by side:
//
// - On a wide screen the clip most in view plays, from the start, and the rest show their poster. When it ends, the next
//   clip in view takes over, so both cards of a row get their turn. A clip downloads only when it first plays.
// - On phones, on a connection that asks to save data, and with reduced motion asked for, nothing plays by itself. Each
//   clip shows its poster with a Play button and downloads when tapped.
//
// - With a mouse, resting the pointer on a card for a moment plays its clip there, picking up where it left off. Moving
//   away doesn't stop it: it plays to the end of its loop, and then autoplay picks again.
//
// Pausing a clip keeps it paused until you press Play, and hovering doesn't restart it. Pressing Play on another clip
// moves playback there.

type Props = { name: string; width: number; height: number; label: string }

/** Skips the clip's fade in from black when it restarts: the poster fades out over it instead. */
const START = 0.4
/** How much of a clip must be on screen to play by itself. */
const IN_VIEW = 0.5
/** How long the pointer rests on a card before its clip plays, so passing over cards doesn't flick them on. */
const HOVER_MS = 150

type Entry = {
  video: HTMLVideoElement
  ratio: number
  /** Paused by the visitor, so it never plays by itself. */
  held: boolean
  /** The pointer is on its card. */
  over: boolean
  /** `resume` continues from where the clip paused instead of starting over. */
  activate(on: boolean, resume?: boolean): void
}

const entries: Entry[] = []
let active: Entry | null = null
/** A clip the visitor started. It keeps playing while any of it is on screen. */
let chosen: Entry | null = null
/** A clip the pointer rested on. It plays until its loop ends, or until it leaves the screen. */
let hovered: Entry | null = null

const AUTO_QUERY = '(prefers-reduced-motion: no-preference) and (min-width: 761px)'
const saveData = () => Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData)
const autoplay = () => matchMedia(AUTO_QUERY).matches && !saveData()
const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches

function setActive(next: Entry | null, resume = false) {
  if (next === active) return
  const before = active
  active = next
  before?.activate(false)
  next?.activate(true, resume)
}

/** Picks the clip that should play now. `after` hands over to the next clip in view once that one ends. */
function elect(after?: Entry) {
  if (chosen && chosen.ratio > 0) return setActive(chosen)
  chosen = null
  if (!autoplay()) return setActive(null)
  if (hovered && hovered.ratio > 0 && !hovered.held) return setActive(hovered, true)
  hovered = null
  const ready = entries.filter((e) => !e.held && e.ratio >= IN_VIEW)
  if (!ready.length) return setActive(null)
  if (after && ready.length > 1 && ready.includes(after)) return setActive(ready[(ready.indexOf(after) + 1) % ready.length]!)
  // The clip playing keeps the turn while it is about as much in view as the best, so scrolling doesn't flip between two.
  const best = ready.reduce((a, b) => (b.ratio > a.ratio + 0.001 ? b : a))
  setActive(active && ready.includes(active) && active.ratio >= best.ratio - 0.15 ? active : best)
}

/** Waits for scrolling to settle before picking, so a card scrolled past doesn't start downloading. */
let settle = 0
function electSoon() {
  clearTimeout(settle)
  settle = window.setTimeout(() => elect(), 200)
}

function subscribeAuto(onChange: () => void) {
  const mq = matchMedia(AUTO_QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function Clip({ name, width, height, label }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const entry = useRef<Entry | null>(null)
  const [playing, setPlaying] = useState(false)
  /** The poster covers the video until the clip has played a frame, and again once another clip takes over. */
  const [covered, setCovered] = useState(true)
  const auto = useSyncExternalStore(subscribeAuto, autoplay, () => true)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    const self: Entry = {
      video,
      ratio: 0,
      held: false,
      over: false,
      activate(on, resume) {
        if (on) {
          const fresh = !video.getAttribute('src')
          if (fresh) video.src = `/clips/${name}.mp4`
          if (fresh || !resume || video.ended || video.currentTime < START) video.currentTime = START
          void video.play().catch(() => undefined)
        } else {
          video.pause()
          setCovered(true)
        }
      }
    }
    entry.current = self
    // In page order, so a row hands over left to right.
    entries.push(self)
    entries.sort((a, b) => (a.video.compareDocumentPosition(b.video) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return
        self.ratio = e.isIntersecting ? e.intersectionRatio : 0
        electSoon()
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] }
    )
    io.observe(video)
    const again = () => {
      video.currentTime = START
      void video.play().catch(() => undefined)
    }
    const onEnded = () => {
      if (active !== self) return
      if (chosen === self) return again()
      if (hovered === self) {
        // Still under the pointer, it loops. Left alone, it hands back to autoplay.
        if (self.over) return again()
        hovered = null
      }
      if (entries.filter((e) => !e.held && e.ratio >= IN_VIEW).length < 2) again()
      else elect(self)
    }
    video.addEventListener('ended', onEnded)

    // The whole card answers the pointer, not only the clip.
    const card = video.closest('article') ?? video
    let rest = 0
    const onEnter = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || !finePointer()) return
      self.over = true
      clearTimeout(rest)
      rest = window.setTimeout(() => {
        if (!self.over || self.held || !autoplay()) return
        hovered = self
        elect()
      }, HOVER_MS)
    }
    const onLeave = () => {
      self.over = false
      clearTimeout(rest)
    }
    card.addEventListener('pointerenter', onEnter as EventListener)
    card.addEventListener('pointerleave', onLeave)
    return () => {
      io.disconnect()
      clearTimeout(rest)
      video.removeEventListener('ended', onEnded)
      card.removeEventListener('pointerenter', onEnter as EventListener)
      card.removeEventListener('pointerleave', onLeave)
      entries.splice(entries.indexOf(self), 1)
      if (chosen === self) chosen = null
      if (hovered === self) hovered = null
      if (active === self) active = null
    }
  }, [name])

  // A change between autoplay and tap to play (a window resized past the phone width) re-picks the clip.
  useEffect(() => {
    elect()
  }, [auto])

  const toggle = () => {
    const self = entry.current
    if (!self) return
    if (active === self && !self.video.paused) {
      self.held = true
      if (chosen === self) chosen = null
      if (hovered === self) hovered = null
      self.video.pause()
      return
    }
    self.held = false
    chosen = self
    if (active === self) void self.video.play().catch(() => undefined)
    else setActive(self, true)
  }

  const tapToPlay = !auto && !playing && covered
  return (
    <div className="group relative">
      <video
        ref={ref}
        poster={`/clips/${name}.jpg`}
        width={width}
        height={height}
        muted
        playsInline
        preload="none"
        aria-label={label}
        onPlaying={() => {
          setPlaying(true)
          setCovered(false)
        }}
        onPause={() => setPlaying(false)}
        className="block h-auto w-full"
      />
      <div
        aria-hidden="true"
        style={{ backgroundImage: `url(/clips/${name}.jpg)` }}
        className={`pointer-events-none absolute inset-0 bg-cover bg-center transition-opacity duration-500 ${covered ? 'opacity-100' : 'opacity-0'}`}
      />
      {tapToPlay ? (
        <button
          type="button"
          onClick={toggle}
          aria-label={`Play: ${label}`}
          className="absolute inset-0 flex items-center justify-center bg-canvas/20 transition-colors hover:bg-canvas/10"
        >
          <span className="inline-flex h-10 items-center gap-2 rounded-full border border-edge bg-canvas/80 px-4 text-ui font-medium text-ink backdrop-blur-nav">
            <PlayIcon size={13} />
            Play
          </span>
        </button>
      ) : (
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
      )}
    </div>
  )
}
