import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Hover this long before the first tooltip shows. Once one has shown, the next shows at once until the pointer rests for `WARM_MS`. */
const OPEN_MS = 450
const WARM_MS = 400
const GAP = 6
const EDGE = 6

const CANDIDATES = '[data-tip], button[aria-label], a[aria-label], [role="button"][aria-label]'

interface Tip { el: HTMLElement; text: string; kbd?: string }

/**
 * What `target` shows on hover: the nearest element's `data-tip`, or the `aria-label` of a button or link with no visible text
 * (an icon button). `data-tip=""` turns it off, and `data-tip-kbd` adds a shortcut. A disabled control, or one whose menu is open, shows none.
 */
export function tipFor(target: EventTarget | null): Tip | null {
  if (!(target instanceof Element)) return null
  const el = target.closest<HTMLElement>(CANDIDATES)
  if (!el || el.matches(':disabled, [aria-expanded="true"]')) return null
  const explicit = el.dataset.tip
  if (explicit !== undefined) return explicit ? { el, text: explicit, kbd: el.dataset.tipKbd } : null
  if (el.textContent?.trim()) return null
  const label = el.getAttribute('aria-label')
  return label ? { el, text: label, kbd: el.dataset.tipKbd } : null
}

/**
 * One tooltip for the whole app, mounted once in App. It listens on the document, so every icon button gets a tooltip from its
 * `aria-label` without wrapping each one. It shows on hover and when Tab moves focus, below the control or above it near the
 * bottom of the window, and hides on press, key, scroll or when the control goes away. Screen readers already read the label.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current: Tip | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let warmUntil = 0
    // A pressed control stays quiet until the pointer moves off it, so a click, or a dialog closing over it, doesn't bring its
    // tooltip straight back. Only a real move counts: the hover events Chromium sends when a layer goes away come without one.
    let pressed: HTMLElement | null = null
    // Focus shows a tooltip only when Tab moved it, not when a closing dialog or menu hands focus back to its trigger.
    let tabbed = false
    const show = (next: Tip | null) => { current = next; setTip(next) }
    const hide = () => {
      clearTimeout(timer)
      if (current) warmUntil = Date.now() + WARM_MS
      show(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const next = tipFor(e.target)
      if (next?.el === current?.el) return
      clearTimeout(timer)
      if (!next || next.el === pressed) { hide(); return }
      if (current || Date.now() < warmUntil) show(next)
      else timer = setTimeout(() => show(next), OPEN_MS)
    }
    const out = (e: PointerEvent) => {
      const to = e.relatedTarget as Node | null
      if (current && !(to && current.el.contains(to))) hide()
    }
    const down = (e: PointerEvent) => {
      pressed = tipFor(e.target)?.el ?? null
      tabbed = false
      hide()
      warmUntil = 0
    }
    const key = (e: KeyboardEvent) => {
      tabbed = e.key === 'Tab'
      hide()
    }
    const focus = (e: FocusEvent) => {
      const next = tipFor(e.target)
      if (tabbed && next && next.el === e.target) { clearTimeout(timer); show(next) }
    }
    const blur = () => { if (current) hide() }
    const move = (e: PointerEvent) => {
      if (pressed && !(e.target instanceof Node && pressed.contains(e.target))) pressed = null
      if (current && !current.el.isConnected) hide()
    }
    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', out, true)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointermove', move, { capture: true, passive: true })
    document.addEventListener('focusin', focus, true)
    document.addEventListener('focusout', blur, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', out, true)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('focusin', focus, true)
      document.removeEventListener('focusout', blur, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Placed after render, once its size is known: centered under the control, flipped above near the bottom, kept inside the window.
  useLayoutEffect(() => {
    const node = ref.current
    if (!tip || !node) return
    const r = tip.el.getBoundingClientRect()
    const { offsetWidth: w, offsetHeight: h } = node
    const below = r.bottom + GAP
    const top = below + h > window.innerHeight - EDGE ? r.top - GAP - h : below
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), window.innerWidth - w - EDGE)
    node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
    node.style.visibility = 'visible'
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div ref={ref} className="tooltip" aria-hidden="true" style={{ visibility: 'hidden' }}>
      {tip.text}
      {tip.kbd && <span className="tooltip-kbd">{tip.kbd}</span>}
    </div>,
    document.body
  )
}
