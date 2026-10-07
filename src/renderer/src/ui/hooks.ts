import { useEffect, useRef, type RefObject } from 'react'

/**
 * Open layers (menus, popovers, modals), oldest first. Escape and outside presses go to the top layer only,
 * so a menu inside a modal closes first and a confirm dialog over a modal doesn't close both.
 */
interface Layer { escape?: () => void; outside?: () => void; ref?: RefObject<HTMLElement | null>; anchorRef?: RefObject<HTMLElement | null> }

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
let installed = false

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
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

/** Register an open layer while `active`. Only the newest layer reacts to Escape or a press outside `ref`. */
export function useLayer(opts: { onEscape?: () => void; onOutside?: () => void; ref?: RefObject<HTMLElement | null>; anchorRef?: RefObject<HTMLElement | null> }, active = true) {
  const latest = useRef(opts)
  latest.current = opts
  useEffect(() => {
    if (!active) return
    install()
    const layer: Layer = {
      escape: latest.current.onEscape ? () => latest.current.onEscape?.() : undefined,
      outside: latest.current.onOutside ? () => latest.current.onOutside?.() : undefined,
      get ref() { return latest.current.ref },
      get anchorRef() { return latest.current.anchorRef }
    }
    stack.push(layer)
    return () => { const i = stack.indexOf(layer); if (i >= 0) stack.splice(i, 1) }
  }, [active])
}

/** Escape closes the top layer only. */
export function useEscape(onEscape: (() => void) | undefined, active = true) {
  useLayer({ onEscape }, active && !!onEscape)
}

/** A press outside `ref` closes the top layer only. */
export function useOutside(ref: RefObject<HTMLElement | null>, onOutside: (() => void) | undefined, active = true) {
  useLayer({ onOutside, ref }, active && !!onOutside)
}
