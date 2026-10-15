import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Open layers (menus, popovers, modals), oldest first. Escape and outside presses go to the top layer only,
 * so a menu inside a modal closes first and a confirm dialog over a modal doesn't close both.
 */
interface Layer { escape?: () => void; outside?: () => void; blocking?: boolean; ref?: RefObject<HTMLElement | null>; anchorRef?: RefObject<HTMLElement | null> }

/** A handler for the screen's own Escape or the toast's. It returns true when it took the key. `inField` says the key came from a text field that was not the composer. */
type EscapeHandler = (e: KeyboardEvent, inField: boolean) => boolean | void
const screenHandlers: EscapeHandler[] = []
const toastHandlers: EscapeHandler[] = []

/**
 * A text field being edited owns Escape: it cancels or clears, and nothing behind it reacts to the same key. The composer is not one:
 * an Escape it does not use (nothing running, no menu) goes on to the screen and the toast.
 */
function ownsEscape(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-composer-input]')) return false
  return target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|range|color|file)$/.test(target.type))
}

/** The Escape that no layer and no field took: the screen's own first (newest registered first), then a toast. The first handler that returns true ends it. */
function dispatchEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
  const inField = ownsEscape(e.target)
  for (const list of [screenHandlers, toastHandlers]) {
    for (const h of [...list].reverse()) {
      if (h(e, inField)) { e.preventDefault(); return }
    }
  }
}

/**
 * Is a press at `target` outside the layer? A press inside the layer, or inside its `anchor` (the trigger that opened it),
 * is not: the trigger's own click handler toggles the layer, so closing it here too would reopen it.
 */
export function isOutsidePress(target: Node | null, layer: HTMLElement | null | undefined, anchor?: HTMLElement | null): boolean {
  if (!layer || !target) return false
  if (layer.contains(target)) return false
  return !anchor?.contains(target)
}
const stack: Layer[] = []

/** Close the open menus and popovers in `layers`, newest first. Only a layer with an outside handler is one: a modal or an escape-only layer (a comment box) is never closed this way. */
function closeLayers(layers: Layer[]) {
  for (const l of [...layers].reverse()) if (!l.blocking) l.outside?.()
}

/** A move to another chat, tab or screen closes every open menu and popover. Background events never call this. */
export function closeAllLayers() {
  closeLayers(stack)
}
let installed = false

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', dispatchEscape)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    // The topmost layer that handles Escape. A layer with only an outside handler doesn't swallow it.
    const top = [...stack].reverse().find((l) => l.escape)
    if (!top) return
    e.stopPropagation()
    top.escape?.()
  }, true)
  document.addEventListener('mousedown', (e) => {
    const top = stack[stack.length - 1]
    if (top?.outside && isOutsidePress(e.target as Node, top.ref?.current, top.anchorRef?.current)) top.outside()
  })
}

/** Is this element somewhere focus can go back to? */
function usable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && el !== document.body && !el.hasAttribute('disabled') && !el.closest('[inert]')
}

/** Is focus lost: on the page body, or still inside the layer that is going away? */
function focusLost(layer: HTMLElement | null | undefined): boolean {
  const cur = document.activeElement
  return !cur || cur === document.body || !!layer?.contains(cur)
}

/** Where focus goes when an overlay closes with nothing else taking it: the element that opened it, or the composer when that is gone. */
export function returnFocus(opener: HTMLElement | null | undefined, layer?: HTMLElement | null) {
  if (!focusLost(layer)) return
  const to = usable(opener) ? opener : document.querySelector<HTMLElement>('[data-composer-input]')
  to?.focus({ preventScroll: true })
}

/**
 * Register an open layer while `active`. Only the newest layer reacts to Escape or a press outside `ref`. A `blocking` layer (a modal)
 * closes the menus and popovers below it when it opens, through their own handlers. Layers opened after it are left alone.
 * A menu, picker or modal (a layer with an outside handler, or a blocking one) notes the focused element as it opens and gives focus back
 * to it on close, or to the composer if that element is gone. A close that left focus on another field leaves it there.
 */
export function useLayer(opts: { onEscape?: () => void; onOutside?: () => void; blocking?: boolean; ref?: RefObject<HTMLElement | null>; anchorRef?: RefObject<HTMLElement | null> }, active = true) {
  const latest = useRef(opts)
  latest.current = opts
  const opener = useRef<HTMLElement | null>(null)
  const seen = useRef(false)
  if (active && !seen.current) {
    seen.current = true
    opener.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  if (!active) { seen.current = false; opener.current = null }
  useEffect(() => {
    if (!active) return
    install()
    const layer: Layer = {
      escape: latest.current.onEscape ? () => latest.current.onEscape?.() : undefined,
      outside: latest.current.onOutside ? () => latest.current.onOutside?.() : undefined,
      blocking: latest.current.blocking,
      get ref() { return latest.current.ref },
      get anchorRef() { return latest.current.anchorRef }
    }
    const from = opener.current
    const below = [...stack]
    stack.push(layer)
    if (layer.blocking) closeLayers(below)
    return () => {
      const i = stack.indexOf(layer)
      if (i >= 0) stack.splice(i, 1)
      const restores = !!(latest.current.onOutside || latest.current.blocking)
      const el = layer.ref?.current
      if (restores) returnFocus(from, el)
    }
  }, [active])
}

/** The screen's own Escape (leave Settings, back out of a question). It comes after any open layer and any field being edited, and before a toast. Return true when it took the key. */
export function useScreenEscape(handler: EscapeHandler, active = true) {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!active) return
    install()
    const h: EscapeHandler = (e, inField) => latest.current(e, inField)
    screenHandlers.push(h)
    return () => { const i = screenHandlers.indexOf(h); if (i >= 0) screenHandlers.splice(i, 1) }
  }, [active])
}

/** A toast's Escape, last of all. It never sees a key that a layer, a field or the screen took. */
export function useToastEscape(handler: EscapeHandler) {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    install()
    const h: EscapeHandler = (e, inField) => latest.current(e, inField)
    toastHandlers.push(h)
    return () => { const i = toastHandlers.indexOf(h); if (i >= 0) toastHandlers.splice(i, 1) }
  }, [])
}

/** Escape closes the top layer only. */
export function useEscape(onEscape: (() => void) | undefined, active = true) {
  useLayer({ onEscape }, active && !!onEscape)
}

/**
 * Which button's work is running (DESIGN.md, Busy buttons). `run(key, fn)` marks `key` busy until `fn` settles, and does
 * nothing while another run is going, so a double click, Enter or a shortcut can't start the work twice. Give the button
 * that started it `busy={busy === key}` and disable the rest with `busy !== null`. `fn` handles its own errors.
 */
export function useBusy<K extends string = string>(): [busy: K | null, run: (key: K, fn: () => Promise<unknown>) => Promise<void>] {
  const [busy, setBusy] = useState<K | null>(null)
  const running = useRef(false)
  const run = useCallback(async (key: K, fn: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    setBusy(key)
    try { await fn() } finally { running.current = false; setBusy(null) }
  }, [])
  return [busy, run]
}
