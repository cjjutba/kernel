import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Icon } from '../../../ui'
import { useLayer } from '../../../ui/hooks'

/** What the arrow keys move between in a where-row menu: its search field and its rows. */
const STOPS = 'input, [role^="menuitem"]'

/**
 * A menu of New chat's where row. It opens upward and ends 8px above the message box, so it never covers the box's toolbar however tall the
 * box has grown. Arrow keys move between its field and rows (Home and End once the field is not focused), Escape closes and hands focus back
 * to the button, Tab closes. `onKey` sees a key first and may take it.
 */
export function WherePop({ anchorRef, label, width, onClose, onKey, focusFirst = true, children }: {
  anchorRef: RefObject<HTMLElement | null>; label: string; width: number; onClose: (refocus?: boolean) => void
  onKey?: (e: KeyboardEvent) => void
  /** Focus the checked row, else the first stop, when the menu opens. Off for one that focuses its own. */
  focusFirst?: boolean; children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [bottom, setBottom] = useState<number | undefined>()
  useLayer({ onEscape: () => onClose(true), onOutside: () => onClose(), ref, anchorRef })
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const box = anchor?.closest('.composer-inner')?.querySelector('.cmp-box')
    if (anchor && box) setBottom(Math.round(anchor.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 8))
  }, [])
  useEffect(() => {
    if (!focusFirst) return
    const stops = [...(ref.current?.querySelectorAll<HTMLElement>(STOPS) ?? [])]
    ;(stops.find((s) => s.getAttribute('aria-checked') === 'true') ?? stops[0])?.focus({ preventScroll: true })
  }, [])
  const keys = (e: KeyboardEvent) => {
    onKey?.(e)
    if (e.defaultPrevented) return
    const all = [...(ref.current?.querySelectorAll<HTMLElement>(STOPS) ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => { e.preventDefault(); e.stopPropagation(); all[(to + all.length) % all.length]?.focus() }
    const typing = e.target instanceof HTMLInputElement
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home' && !typing) move(0)
    else if (e.key === 'End' && !typing) move(all.length - 1)
    else if (e.key === 'Tab') { e.preventDefault(); onClose(true) }
  }
  return (
    <div ref={ref} className="menu where-pop" role="menu" aria-label={label} style={{ width, bottom }} onKeyDown={keys}>
      {children}
    </div>
  )
}

/** A menu's search field. */
export function PopSearch({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="pick-search where-search">
      <Icon name="search" size={14} />
      <input type="text" aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus />
    </label>
  )
}
