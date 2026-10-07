import { useEffect, useRef } from 'react'

/** Call `onEscape` when Escape is pressed while `active`. Capture phase, so the innermost layer can stop it. */
export function useEscape(onEscape: (() => void) | undefined, active = true) {
  const ref = useRef(onEscape)
  ref.current = onEscape
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !ref.current) return
      e.stopPropagation()
      ref.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])
}

/** Call `onOutside` on a pointer press outside the element in `ref`. */
export function useOutside(ref: React.RefObject<HTMLElement | null>, onOutside: (() => void) | undefined, active = true) {
  useEffect(() => {
    if (!active || !onOutside) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [ref, onOutside, active])
}
