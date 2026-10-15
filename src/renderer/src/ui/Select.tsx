import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { useLayer } from './hooks'
import { edgeIndex, flattenOptions, isGroup, nextIndex, typeaheadIndex, type SelectOption, type SelectOptions } from './selectModel'

export type { SelectGroup, SelectOption, SelectOptions } from './selectModel'

/** A row under the choices that does something instead of picking a value: "Custom folder…", "Choose image…". */
export interface SelectAction { label: string; icon?: IconName; onSelect: () => void }

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOptions<ReactNode>
  /** The accessible name. Required unless `labelledBy` points at a visible label. */
  label: string
  labelledBy?: string
  /** Shown when `value` matches no choice and isn't empty. Without one the raw value shows. */
  placeholder?: string
  disabled?: boolean
  /** A muted word inside the button before the value ("Run by"). */
  prefix?: string
  /** Drawn before the value in the button, such as a project's picture. */
  leading?: ReactNode
  actions?: SelectAction[]
  /** Which edge the list lines up with. Controls at the right of a row open to the left. */
  align?: 'left' | 'right'
  /** `field` is a bordered input (Settings rows). `chip` is a filled filter chip (Issues). `plain` is text and a chevron, for a value at the end of a menu row. */
  variant?: 'field' | 'chip' | 'plain'
  className?: string
  /** Controlled open state, for fixtures that shoot the list open. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const TYPE_MS = 500

/**
 * The one dropdown (KERNEL-680; native selects are banned, see test/noNativeSelect.test.ts). A button shows the value; its list is a
 * `.menu` listbox under it, or above it when there is no space below. Arrow keys, Home and End move and skip disabled rows, typing jumps
 * to a row, Enter or Space picks, Escape closes and returns to the button, Tab closes. The list opens on the row that is picked.
 */
export function Select({ value, onChange, options, label, labelledBy, placeholder, disabled, prefix, leading, actions = [], align = 'left', variant = 'field', className, open: openProp, onOpenChange }: SelectProps) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (o: boolean) => { if (openProp === undefined) setOpenState(o); onOpenChange?.(o) }
  const [side, setSide] = useState<'bottom' | 'top'>('bottom')
  const [active, setActive] = useState(-1)
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })

  const flat = flattenOptions(options)
  const rows: { label: string; disabled?: boolean }[] = [...flat, ...actions.map((a) => ({ label: a.label }))]
  const selected = flat.findIndex((o) => o.value === value)
  const current = flat[selected]
  const shown = current?.label ?? (value ? placeholder ?? value : placeholder ?? '')

  const close = (restore = true) => { setOpen(false); if (restore) button.current?.focus() }
  useLayer({ onEscape: close, onOutside: () => close(false), ref: list, anchorRef: wrap }, open)

  // Open on the picked row, or the first one that can be picked. Flip above the button when the space below is too short.
  useLayoutEffect(() => {
    if (!open) return
    setActive(selected >= 0 && !flat[selected].disabled ? selected : edgeIndex(rows, 'first'))
    const box = wrap.current?.getBoundingClientRect()
    const height = Math.min(list.current?.scrollHeight ?? 0, 320)
    if (box) setSide(window.innerHeight - box.bottom < height + 12 && box.top > window.innerHeight - box.bottom ? 'top' : 'bottom')
  }, [open])
  useEffect(() => {
    if (!open || active < 0) return
    const node = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    node?.focus({ preventScroll: true })
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const choose = (i: number) => {
    if (i < 0 || rows[i]?.disabled) return
    close()
    if (i >= flat.length) actions[i - flat.length].onSelect()
    else if (flat[i].value !== value) onChange(flat[i].value)
  }
  const onListKey = (e: KeyboardEvent) => {
    const go = (i: number) => { e.preventDefault(); if (i >= 0) setActive(i) }
    if (e.key === 'ArrowDown') go(nextIndex(rows, active, 1))
    else if (e.key === 'ArrowUp') go(nextIndex(rows, active < 0 ? rows.length : active, -1))
    else if (e.key === 'Home') go(edgeIndex(rows, 'first'))
    else if (e.key === 'End') go(edgeIndex(rows, 'last'))
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active) }
    else if (e.key === 'Tab') close(false)
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now()
      typed.current = { text: now - typed.current.at > TYPE_MS ? e.key : typed.current.text + e.key, at: now }
      go(typeaheadIndex(rows, typed.current.text, active))
    }
  }
  const onButtonKey = (e: KeyboardEvent) => {
    if (open || disabled) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true) }
  }

  let index = -1
  const option = (o: SelectOption<ReactNode>) => {
    const i = ++index
    const picked = o.value === value
    return (
      <button
        key={`o-${o.value}`} type="button" role="option" aria-selected={picked} aria-disabled={o.disabled || undefined} disabled={o.disabled} tabIndex={-1}
        data-index={i} data-desc={o.description ? '' : undefined} className="menu-item select-opt" onClick={() => choose(i)} onMouseMove={() => !o.disabled && active !== i && setActive(i)}
      >
        {o.leading}
        <span className="select-opt-text"><span className="ellipsis">{o.label}</span>{o.description && <span className="select-opt-desc">{o.description}</span>}</span>
        {picked ? <Icon name="check" size={14} /> : <span className="menu-check-slot" aria-hidden="true" />}
      </button>
    )
  }

  return (
    <span ref={wrap} className={['select', className].filter(Boolean).join(' ')}>
      <button
        ref={button} type="button" className="select-trigger" data-variant={variant} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={labelledBy ? undefined : `${label}, ${shown}`} aria-labelledby={labelledBy ? `${labelledBy} ${id}-value` : undefined} disabled={disabled}
        onClick={() => setOpen(!open)} onKeyDown={onButtonKey}
      >
        {prefix && <span className="select-prefix">{prefix}</span>}
        {leading}
        <span id={`${id}-value`} className="select-value ellipsis">{shown}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div ref={list} id={id} role="listbox" aria-label={label} className="menu select-pop" data-side={side} data-align={align} onKeyDown={onListKey}>
          {options.map((o, g) => isGroup(o)
            ? (
              <div key={`g-${g}`} role="group" aria-label={o.label || undefined}>
                {o.label ? <div className="menu-title" aria-hidden="true">{o.label}</div> : g > 0 && <div role="separator" className="menu-sep" />}
                {o.options.map(option)}
              </div>
            )
            : option(o))}
          {actions.length > 0 && <div role="separator" className="menu-sep" />}
          {actions.map((a, k) => {
            const i = flat.length + k
            return (
              <button key={`a-${a.label}`} type="button" role="option" aria-selected={false} tabIndex={-1} data-index={i} className="menu-item select-opt" onClick={() => choose(i)} onMouseMove={() => active !== i && setActive(i)}>
                {a.icon && <Icon name={a.icon} size={14} />}
                <span className="select-opt-text"><span className="ellipsis">{a.label}</span></span>
              </button>
            )
          })}
        </div>
      )}
    </span>
  )
}
