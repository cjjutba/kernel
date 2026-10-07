import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { Button } from './controls'
import { useEscape, useOutside } from './hooks'

export interface MenuEntry {
  id: string
  label: string
  icon?: IconName
  /** Shown on the right, for example "⌘N". */
  shortcut?: string
  /** A nested menu, opened on hover, click or ArrowRight. */
  children?: MenuEntry[]
  disabled?: boolean
  onSelect?: () => void
}

/** A divider between groups of items. */
export const MENU_SEPARATOR = { id: '-' } as const

function MenuList({ items, onClose, onBack, label }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; onBack?: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true }) }, [])
  const onKey = (e: KeyboardEvent) => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [role=menuitem]:not(:disabled)') ?? [])]
    const i = nodes.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); nodes[(i + 1) % nodes.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nodes[(i - 1 + nodes.length) % nodes.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); nodes[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); nodes[nodes.length - 1]?.focus() }
    else if (e.key === 'ArrowLeft' && onBack) { e.preventDefault(); e.stopPropagation(); onBack() }
  }
  return (
    <div ref={ref} role="menu" aria-label={label} className="menu" onKeyDown={onKey}>
      {items.map((it) => {
        if (it.id === '-') return <div key={`sep-${items.indexOf(it)}`} role="separator" className="menu-sep" />
        const m = it as MenuEntry
        const sub = m.children?.length
        return (
          <div key={m.id} className="menu-row" onMouseEnter={() => sub && setOpen(m.id)} onMouseLeave={() => sub && setOpen(null)}>
            <button
              type="button" role="menuitem" className="menu-item" disabled={m.disabled} aria-haspopup={sub ? 'menu' : undefined} aria-expanded={sub ? open === m.id : undefined}
              onClick={() => { if (sub) setOpen(m.id); else { m.onSelect?.(); onClose() } }}
              onKeyDown={(e) => { if (sub && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setOpen(m.id) } }}
            >
              {m.icon && <Icon name={m.icon} />}
              <span className="grow ellipsis">{m.label}</span>
              {m.shortcut && <span className="menu-kbd">{m.shortcut}</span>}
              {sub ? <Icon name="right" size={12} /> : null}
            </button>
            {sub && open === m.id && (
              <div className="submenu"><MenuList items={m.children!} onClose={onClose} onBack={() => setOpen(null)} label={m.label} /></div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A menu with shortcuts and submenus. Position it by placing it in a `position: relative` parent (see Popover),
 * or pass `style`. Escape and a press outside call `onClose`.
 */
export function Menu({ items, onClose, label, style }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; label?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useOutside(ref, onClose)
  return <div ref={ref} className="menu-anchor" style={style}><MenuList items={items} onClose={onClose} label={label} /></div>
}

/** A single menu item, for menus that need custom rows. `Menu` builds these from `items`. */
export function MenuItem({ icon, shortcut, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; shortcut?: string }) {
  return (
    <button type="button" role="menuitem" className="menu-item" {...rest}>
      {icon && <Icon name={icon} />}
      <span className="grow ellipsis">{children}</span>
      {shortcut && <span className="menu-kbd">{shortcut}</span>}
    </button>
  )
}

/** Anything anchored below a trigger: a small panel that closes on Escape or an outside press. */
export function Popover({ open, onClose, children, label, align = 'left' }: { open: boolean; onClose: () => void; children: ReactNode; label: string; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose, open)
  useOutside(ref, onClose, open)
  if (!open) return null
  return <div ref={ref} role="dialog" aria-label={label} className="popover" style={{ [align]: 0 }}>{children}</div>
}

/**
 * The one modal shell. Blur scrim over the whole window (z-index 40), dialog above it (50), 14px radius, 1px border.
 * Escape and a press on the scrim call `onClose`. Focus moves in on open and back to the trigger on close.
 */
export function Modal({ title, onClose, children, footer, width, top, bare }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; top?: number; bare?: boolean }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not([data-close])')
    ;(first ?? ref.current)?.focus({ preventScroll: true })
    return () => before?.focus?.()
  }, [])
  const trap = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return
    const nodes = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea, select, [tabindex]:not([tabindex="-1"])')]
    if (!nodes.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="modal" style={{ width, top }} onKeyDown={trap}>
        {!bare && (
          <div className="modal-head">
            <h2 id={id}>{title}</h2>
            <button type="button" data-close className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
          </div>
        )}
        {bare && <h2 id={id} className="sr-only">{title}</h2>}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  )
}

/** Archive, discard, remove, retire. Red appears only on the final confirm button. */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', danger, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal title={title} onClose={onCancel} width={440} top={220} footer={<><span className="grow" /><Button onClick={onCancel}>{cancelLabel}</Button><Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="modal-body ink2">{body}</div>
    </Modal>
  )
}

/** How long a toast stays (DESIGN.md). */
export const TOAST_MS = 2600

export interface ToastProps { title: string; sub?: string; action?: { label: string; href?: string; onClick?: () => void }; onDismiss?: () => void }

/** One toast. It calls `onDismiss` after 2.6s, and stays while hovered or focused. */
export function Toast({ title, sub, action, onDismiss }: ToastProps) {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held || !onDismiss) return
    const t = setTimeout(onDismiss, TOAST_MS)
    return () => clearTimeout(t)
  }, [held, onDismiss])
  return (
    <div role="status" className="toast" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <Icon name="check" size={14} />
      <div className="grow"><div className="toast-title">{title}</div>{sub && <div className="muted">{sub}</div>}</div>
      {action && (action.href ? <a className="toast-action" href={action.href} onClick={action.onClick}>{action.label}</a> : <button type="button" className="toast-action" onClick={action.onClick}>{action.label}</button>)}
    </div>
  )
}

/** Bottom right, newest last. */
export function ToastStack({ children }: { children: ReactNode }) {
  return <div className="toast-stack" aria-live="polite">{children}</div>
}
