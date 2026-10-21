import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { atEnd, entryInView, JUMP_OFFSET, markFit, railKey, railTime, type RailEntry } from './railEntries'

/** The jumped-to message keeps its ring this long. The last 400ms fade it (`jump-ring` in workspace.css). */
const RING_MS = 1200
/** The list's padding, which a row scrolled into view keeps clear of the edge. */
const LIST_PAD = 6
/** Half the height of the preview card, which sits level with the mark it shows. */
const PEEK_HALF = 39

interface ViewProps {
  entries: RailEntry[]
  /** The entry in view, drawn in `--ink` and as the selected option. */
  current: number
  /** The row under the pointer or the keys. */
  at: number
  open: boolean
  id: string
  button?: ButtonHTMLAttributes<HTMLButtonElement>
  listRef?: (el: HTMLDivElement | null) => void
  onPick?: (i: number) => void
  onPoint?: (i: number, e: PointerEvent) => void
  /** The mark under the pointer, which grows and shows its message beside the rail (KERNEL-1095). `peekTop` is where that card sits, level with the mark. */
  hot?: number
  peekTop?: number
}

/** The rail, one mark per entry, and its list while open. Drawn from state, so a test can draw the open list. */
export function RailView({ entries, current, at, open, id, button, listRef, onPick, onPoint, hot, peekTop }: ViewProps) {
  const listId = `${id}-list`
  return (
    <>
      <button type="button" className="rail-btn" aria-label="Jump to message" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${id}-${at}` : undefined} {...button}>
        {entries.map((e, i) => <span key={e.id} className="rail-m" aria-hidden="true" data-update={e.update || undefined} data-now={i === current || undefined} data-hot={i === hot || undefined} />)}
      </button>
      {hot !== undefined && !open && entries[hot] && (
        <div className="rail-peek" style={{ top: peekTop }} aria-hidden="true">
          <div className="rail-peek-top"><span className="rail-peek-who">{entries[hot].update ? 'Update' : 'You'}</span><span>{railTime(entries[hot].ts)}</span><span className="rail-peek-n">{hot + 1} of {entries.length}</span></div>
          <p className="rail-peek-tx">{entries[hot].label}</p>
        </div>
      )}
      {open && (
        <div className="rail-pop">
          <div className="rail-jump">
          <div className="rail-jump-head" aria-hidden="true"><span>{entries.length} messages</span><span>Jump to</span></div>
          <div id={listId} ref={listRef} className="rail-list" role="listbox" aria-label="Jump to message" onMouseDown={(e) => e.preventDefault()}>
            {entries.map((e, i) => (
              <div key={e.id} id={`${id}-${i}`} className="rail-opt" role="option" aria-selected={i === current} aria-label={e.more ? `${e.label}, and ${e.more} more` : undefined}
                data-now={i === current || undefined} data-update={e.update || undefined} data-active={i === at || undefined}
                onPointerMove={(ev) => onPoint?.(i, ev)} onClick={() => onPick?.(i)}>
                <span className="rail-opt-mk" aria-hidden="true" />
                <span className="rail-opt-tx">{e.label}</span>
                {e.more > 0 && <span className="rail-opt-nx" aria-hidden="true">+{e.more}</span>}
                {e.ts !== undefined && <span className="rail-opt-time" aria-hidden="true">{railTime(e.ts)}</span>}
              </div>
            ))}
          </div>
          </div>
        </div>
      )}
    </>
  )
}

const targetOf = (box: HTMLElement, id: string) => box.querySelector<HTMLElement>(`[data-jump="${CSS.escape(id)}"]`)
/** Where the box scrolls to so `el`'s top sits JUMP_OFFSET under the box's top. */
const placeOf = (box: HTMLElement, el: HTMLElement) => box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - JUMP_OFFSET

/**
 * The chat rail (KERNEL-599): a button on the chat column's right edge with a mark per message, whose list jumps the transcript
 * to one. It is hidden below two entries. Hover or keyboard focus opens the list; the keys move through it while focus stays on
 * the rail, so the rows are options named by `aria-activedescendant`.
 */
/** The transcript's glider, which every scroll Kernel makes itself goes through (KERNEL-862). `glide` runs one toward a goal asked again each frame, `stop` ends it. */
export interface RailGlide { glide: (goal: () => number, done: (landed: boolean, replaced?: boolean) => void) => void; stop: () => void }

export function ChatRail({ entries, scroller, glide: glider }: { entries: RailEntry[]; scroller: RefObject<HTMLElement | null>; glide?: RailGlide }) {
  const id = useId()
  const count = entries.length
  const [current, setCurrent] = useState(count - 1)
  // The mark under the pointer and where its preview sits. A pointer shows the message beside its mark and a click jumps to it. The list, which names every message, is for the keyboard (KERNEL-1095).
  const [hot, setHot] = useState<{ i: number; top: number } | null>(null)
  const [focus, setFocus] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [pick, setPick] = useState<number | null>(null)
  const open = count >= 2 && focus && !dismissed
  const at = Math.min(pick ?? current, count - 1)
  const wrap = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const byKey = useRef(false)
  const point = useRef({ x: 0, y: 0 })
  const entriesNow = useRef(entries)
  entriesNow.current = entries
  // Tells the transcript a jump is scrolling its view, so it counts as the reader's own scroll and the chat doesn't follow its end back over it (KERNEL-605).
  const glideNow = useRef(glider)
  glideNow.current = glider
  // A jump holds the entry it went to as the one in view until the reader scrolls by hand, since a message near the end can't reach the top.
  const forced = useRef<string | undefined>(undefined)
  const glide = useRef<(() => void) | undefined>(undefined)
  const ring = useRef<{ el: HTMLElement; timer: number } | undefined>(undefined)

  const measure = useCallback(() => {
    const box = scroller.current
    if (!box) return
    const all = entriesNow.current
    const held = forced.current ? all.findIndex((e) => e.id === forced.current) : -1
    if (held >= 0) { setCurrent(held); return }
    const top = box.getBoundingClientRect().top
    const byId = new Map<string, Element>()
    box.querySelectorAll('[data-jump]').forEach((el) => byId.set(el.getAttribute('data-jump')!, el))
    setCurrent(entryInView(all.map((e) => { const el = byId.get(e.id); return el ? el.getBoundingClientRect().top - top : NaN }), atEnd(box)))
  }, [scroller])

  useLayoutEffect(measure, [entries, measure])
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const byHand = (e: Event) => { if (e.type === 'pointerdown' && e.target !== box) return; forced.current = undefined; schedule() }
    const hand = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    box.addEventListener('scroll', schedule, { passive: true })
    hand.forEach((t) => box.addEventListener(t, byHand, { passive: true }))
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    resize?.observe(box)
    return () => {
      cancelAnimationFrame(frame)
      box.removeEventListener('scroll', schedule)
      hand.forEach((t) => box.removeEventListener(t, byHand))
      resize?.disconnect()
    }
  }, [scroller, measure])

  // The marks tighten when the stack would pass the column's height.
  useLayoutEffect(() => {
    const el = wrap.current
    const host = el?.parentElement
    if (!el || !host) return
    const fit = () => { const { mark, gap } = markFit(count, host.clientHeight); el.style.setProperty('--rail-mark', `${mark}px`); el.style.setProperty('--rail-gap', `${gap}px`) }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver(fit)
    resize.observe(host)
    return () => resize.disconnect()
  }, [count])

  // The list opens with the entry in view showing, and a key that moves the active row keeps it showing. The pointer doesn't scroll the list.
  const reveal = (i: number) => {
    const box = list.current
    const row = box?.children[i]
    if (!box || !(row instanceof HTMLElement)) return
    const top = row.offsetTop - LIST_PAD
    const bottom = row.offsetTop + row.offsetHeight + LIST_PAD
    if (top < box.scrollTop) box.scrollTop = top
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight
  }
  useLayoutEffect(() => { if (open) reveal(at) }, [open])
  useLayoutEffect(() => { if (open && byKey.current) reveal(at); byKey.current = false }, [at])

  const clearRing = () => {
    if (ring.current) { window.clearTimeout(ring.current.timer); ring.current.el.removeAttribute('data-jumped'); ring.current = undefined }
  }
  const light = (el: HTMLElement) => {
    clearRing()
    el.setAttribute('data-jumped', '')
    ring.current = { el, timer: window.setTimeout(clearRing, RING_MS) }
  }
  useEffect(() => () => { glide.current?.(); clearRing() }, [])

  /** Glides the message's top to JUMP_OFFSET under the view's top, then rings it. */
  const jump = (i: number) => {
    const box = scroller.current
    const entry = entriesNow.current[i]
    const el = box && entry ? targetOf(box, entry.id) : null
    if (!box || !entry || !el) return
    glide.current?.()
    clearRing()
    forced.current = entry.id
    setCurrent(i)
    // A message near the end can't reach the top, so the view stops at the end. Rows far from the view measure a frame after they show, so the goal is read again every frame.
    const goal = () => Math.max(0, Math.min(placeOf(box, el), box.scrollHeight - box.clientHeight))
    const stop = () => { if (glide.current === stop) glide.current = undefined; glideNow.current?.stop() }
    glide.current = stop
    if (Math.abs(goal() - box.scrollTop) < 1) { glide.current = undefined; light(el); return }
    const run = glideNow.current
    if (!run) { glide.current = undefined; light(el); return }
    run.glide(goal, (landed, replaced) => {
      if (glide.current === stop) glide.current = undefined
      if (landed || replaced) light(el)
    })
  }

  /** The mark nearest the pointer, and the top of a preview card 78px tall level with it, kept inside the column. */
  const peek = (clientY: number) => {
    const el = wrap.current
    const marks = el ? Array.from(el.querySelectorAll<HTMLElement>('.rail-m')) : []
    if (!el || !marks.length) return
    let best = 0
    let gap = Infinity
    marks.forEach((m, i) => { const r = m.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - clientY); if (d < gap) { gap = d; best = i } })
    const r = marks[best].getBoundingClientRect()
    const host = el.getBoundingClientRect()
    setHot((h) => (h?.i === best ? h : { i: best, top: Math.round(r.top + r.height / 2 - host.top - PEEK_HALF) }))
  }

  const key = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const next = railKey(e.key, { open, active: at, count })
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    byKey.current = true
    setDismissed(!next.open)
    setPick(next.open ? next.active : null)
    if (next.jump) jump(next.active)
  }

  if (count < 2) return null
  return (
    <div ref={wrap} className="chat-rail" onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.pointerType === 'pen') peek(e.clientY) }} onPointerLeave={() => { setHot(null); setPick(null) }}>
      <RailView entries={entries} current={current} at={at} open={open} id={id} listRef={(el) => { list.current = el }} hot={hot?.i} peekTop={hot?.top}
        button={{
          // Focus from a press doesn't open the list: a press jumps. Focus from Tab does.
          onFocus: (e) => { if (e.currentTarget.matches(':focus-visible')) { setFocus(true); setDismissed(false); setHot(null) } },
          onBlur: () => { setFocus(false); setPick(null) },
          onKeyDown: key,
          onClick: (e) => { if (e.detail > 0 && hot) { jump(hot.i); setHot(null); e.currentTarget.blur() } else setDismissed(false) }
        }}
        onPick={(i) => { setDismissed(true); setPick(null); jump(i) }}
        onPoint={(i, e) => { if (e.clientX === point.current.x && e.clientY === point.current.y) return; point.current = { x: e.clientX, y: e.clientY }; setPick(i) }} />
    </div>
  )
}
