import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Icon, type IconName } from '../icons'
import { Button } from './controls'
import { useLayer } from './hooks'

export interface MenuEntry {
  id: string
  label: string
  icon?: IconName
  /** Shown on the right, for example "⌘N". */
  shortcut?: string
  /** A nested menu, opened on hover, click or ArrowRight. */
  children?: MenuEntry[]
  disabled?: boolean
  /** Red text and icon. For the one destructive entry, such as Remove room (SidebarRoomMenu.png). */
  danger?: boolean
  onSelect?: () => void
}

/** A divider between groups of items. */
export const MENU_SEPARATOR = { id: '-' } as const

function MenuList({ items, onClose, onBack, label, initiallyOpen }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; onBack?: () => void; label?: string; initiallyOpen?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const openers = useRef<Record<string, HTMLButtonElement | null>>({})
  const [open, setOpen] = useState<string | null>(initiallyOpen ?? null)
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true }) }, [])
  const onKey = (e: KeyboardEvent) => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(':scope > .menu-row > [role=menuitem]:not(:disabled)') ?? [])]
    const i = nodes.indexOf(document.activeElement as HTMLElement)
    const handled = (go: () => void) => { e.preventDefault(); e.stopPropagation(); go() }
    if (e.key === 'ArrowDown') handled(() => nodes[(i + 1) % nodes.length]?.focus())
    else if (e.key === 'ArrowUp') handled(() => nodes[(i - 1 + nodes.length) % nodes.length]?.focus())
    else if (e.key === 'Home') handled(() => nodes[0]?.focus())
    else if (e.key === 'End') handled(() => nodes[nodes.length - 1]?.focus())
    else if (e.key === 'ArrowLeft' && onBack) handled(onBack)
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
              ref={(el) => { openers.current[m.id] = el }} type="button" role="menuitem" className="menu-item" data-danger={m.danger || undefined} disabled={m.disabled} aria-haspopup={sub ? 'menu' : undefined} aria-expanded={sub ? open === m.id : undefined}
              onClick={() => { if (sub) setOpen(m.id); else { m.onSelect?.(); onClose() } }}
              onKeyDown={(e) => { if (sub && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setOpen(m.id) } }}
            >
              {m.icon && <Icon name={m.icon} />}
              <span className="grow ellipsis">{m.label}</span>
              {m.shortcut && <span className="menu-kbd">{m.shortcut}</span>}
              {sub ? <Icon name="right" size={12} /> : null}
            </button>
            {sub && open === m.id && (
              <div className="submenu"><MenuList items={m.children!} onClose={onClose} onBack={() => { setOpen(null); openers.current[m.id]?.focus() }} label={m.label} /></div>
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
export function Menu({ items, onClose, label, style, initiallyOpen, anchorRef }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; label?: string; style?: React.CSSProperties; initiallyOpen?: string; anchorRef?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  return <div ref={ref} className="menu-anchor" style={style}><MenuList items={items} onClose={onClose} label={label} initiallyOpen={initiallyOpen} /></div>
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

/**
 * Anything anchored to a trigger: a small panel that closes on Escape or an outside press. It opens below the trigger, or above it
 * with `side="top"` for triggers at the bottom of the window. Pass the trigger's wrapper as `anchorRef` so pressing the trigger
 * toggles it instead of closing then reopening.
 */
export function Popover({ open, onClose, children, label, align = 'left', side = 'bottom', className, anchorRef }: { open: boolean; onClose: () => void; children: ReactNode; label: string; align?: 'left' | 'right'; side?: 'top' | 'bottom'; className?: string; anchorRef?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef }, open)
  if (!open) return null
  return <div ref={ref} role="dialog" aria-label={label} className={['popover', className].filter(Boolean).join(' ')} data-side={side} style={{ [align]: 0 }}>{children}</div>
}

/**
 * The one modal shell. Blur scrim over the whole window (z-index 40), dialog above it (50), 14px radius, 1px border.
 * Escape and a press on the scrim call `onClose`. Focus moves in on open and back to the trigger on close.
 */
export function Modal({ title, onClose, children, footer, width, top, bare, role = 'dialog', labelledBy, describedBy }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; top?: number; bare?: boolean; role?: 'dialog' | 'alertdialog'; labelledBy?: string; describedBy?: string }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose })
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
  // `top` is where the canvas puts the dialog in a 900px tall window. tokens.css moves it up in a short one (D-080).
  const place = { width, ...(top !== undefined && { '--modal-y': top }) } as CSSProperties
  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div ref={ref} role={role} aria-modal="true" aria-labelledby={labelledBy ?? id} aria-describedby={describedBy} tabIndex={-1} className="modal" style={place} onKeyDown={trap}>
        {!bare && (
          <div className="modal-head">
            <h2 id={id}>{title}</h2>
            <button type="button" data-close className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
          </div>
        )}
        {bare && !labelledBy && <h2 id={id} className="sr-only">{title}</h2>}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  )
}

/** Archive, discard, remove, retire. Red appears only on the final confirm button. */
export function ConfirmDialog({ title, body, children, extra, confirmLabel, cancelLabel = 'Cancel', danger, busy, onConfirm, onCancel }: { title: string; body: ReactNode; /** Extra content under the body, such as a path box or a checkbox. */ children?: ReactNode; /** A second way out, on the left of the footer, such as "Archive anyway" (ConfirmArchive.png). */ extra?: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; /** Disables the confirm button while the action runs. */ busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const id = useId()
  return (
    <Modal
      title={title} onClose={onCancel} width={460} top={220} bare role="alertdialog" labelledBy={`${id}t`} describedBy={`${id}b`}
      footer={<>{extra}<span className="grow" /><Button variant="ghost" size="lg" onClick={onCancel}>{cancelLabel}</Button><Button variant={danger ? 'danger' : 'primary'} size="lg" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button></>}
    >
      <div className="confirm-body">
        <h2 id={`${id}t`}>{title}</h2>
        <p id={`${id}b`}>{body}</p>
        {children}
      </div>
    </Modal>
  )
}

/** How long a toast stays (DESIGN.md). */
export const TOAST_MS = 2600

export interface ToastProps { title: string; sub?: string; action?: { label: string; href?: string; onClick?: () => void }; onDismiss?: () => void }

/** One toast (WorkspaceToast.png). It calls `onDismiss` after 2.6s, and stays while hovered or focused. */
export function Toast({ title, sub, action, onDismiss }: ToastProps) {
  const [held, setHeld] = useState(false)
  // Callers pass inline closures and re-render often. Keep the latest one in a ref so a render doesn't restart the timer.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const timed = !!onDismiss
  useEffect(() => {
    if (held || !timed) return
    const t = setTimeout(() => dismiss.current?.(), TOAST_MS)
    return () => clearTimeout(t)
  }, [held, timed])
  return (
    <div className="toast" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <span className="grow toast-text"><span className="toast-title">{title}</span>{sub && <span className="toast-sub">{sub}</span>}</span>
      {action && (action.href
        ? <a className="toast-action" href={action.href} onClick={action.onClick}>{action.label}</a>
        : <button type="button" className="toast-action" onClick={action.onClick}>{action.label}</button>)}
      <button type="button" className="toast-x" aria-label="Dismiss" onClick={onDismiss}><Icon name="close" size={10} stroke={2} /></button>
    </div>
  )
}

/** Bottom right, 16px from the edges, newest last. */
export function ToastStack({ children }: { children: ReactNode }) {
  return <div className="toast-stack" role="status">{children}</div>
}
