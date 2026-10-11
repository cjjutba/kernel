import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject, type WheelEvent } from 'react'
import { isWebUrl } from '@shared/previewUrl'
import { call } from '../api'
import { Icon, type IconName } from '../icons'
import { Button } from './controls'
import { useLayer } from './hooks'

export interface MenuEntry {
  id: string
  label: string
  icon?: IconName
  /** Drawn in place of `icon`, such as a room's picture. */
  leading?: ReactNode
  /** Makes the item a radio of its menu: it is announced as checked or not, and a checked one shows a check mark (SettingsRoomIcon.png). */
  checked?: boolean
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

const ITEM_ON = ':is([role=menuitem], [role=menuitemradio]):not(:disabled)'

function MenuList({ items, onClose, onBack, label, heading, initiallyOpen }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; onBack?: () => void; label?: string; heading?: string; initiallyOpen?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const openers = useRef<Record<string, HTMLButtonElement | null>>({})
  const [open, setOpen] = useState<string | null>(initiallyOpen ?? null)
  useEffect(() => { (ref.current?.querySelector<HTMLElement>(`${ITEM_ON}[aria-checked=true]`) ?? ref.current?.querySelector<HTMLElement>(ITEM_ON))?.focus({ preventScroll: true }) }, [])
  const onKey = (e: KeyboardEvent) => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(`:scope > .menu-row > ${ITEM_ON}`) ?? [])]
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
      {heading && <div className="menu-head" aria-hidden="true">{heading}</div>}
      {items.map((it) => {
        if (it.id === '-') return <div key={`sep-${items.indexOf(it)}`} role="separator" className="menu-sep" />
        const m = it as MenuEntry
        const sub = m.children?.length
        return (
          <div key={m.id} className="menu-row" onMouseEnter={() => sub && setOpen(m.id)} onMouseLeave={() => sub && setOpen(null)}>
            <button
              ref={(el) => { openers.current[m.id] = el }} type="button" role={m.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={m.checked} className="menu-item" data-danger={m.danger || undefined} disabled={m.disabled} aria-haspopup={sub ? 'menu' : undefined} aria-expanded={sub ? open === m.id : undefined}
              onClick={() => { if (sub) setOpen(m.id); else { m.onSelect?.(); onClose() } }}
              onKeyDown={(e) => { if (sub && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setOpen(m.id) } }}
            >
              {m.leading ?? (m.icon && <Icon name={m.icon} />)}
              <span className="grow ellipsis">{m.label}</span>
              {m.checked && <Icon name="check" size={14} stroke={1.5} />}
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
 * or pass `style`. Escape and a press outside call `onClose`. `heading` is a short title above the first item.
 */
export function Menu({ items, onClose, label, heading, style, initiallyOpen, anchorRef }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; label?: string; heading?: string; style?: React.CSSProperties; initiallyOpen?: string; anchorRef?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  return <div ref={ref} className="menu-anchor" style={style}><MenuList items={items} onClose={onClose} label={label} heading={heading} initiallyOpen={initiallyOpen} /></div>
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
export function ConfirmDialog({ title, body, children, extra, confirmLabel, cancelLabel = 'Cancel', danger, busy, busyLabel, disabled, onConfirm, onCancel }: { title: string; body: ReactNode; /** Extra content under the body, such as a path box or a checkbox. */ children?: ReactNode; /** A second way out, on the left of the footer, such as "Archive anyway" (ConfirmArchive.png). */ extra?: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; /** The confirm action is running: its button spins and says `busyLabel`, such as "Archiving". */ busy?: boolean; busyLabel?: string; /** The confirm button can't be pressed yet, such as while the dialog reads the branch. */ disabled?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const id = useId()
  return (
    <Modal
      title={title} onClose={onCancel} width={460} top={220} bare role="alertdialog" labelledBy={`${id}t`} describedBy={`${id}b`}
      footer={<>{extra}<span className="grow" /><Button variant="ghost" size="lg" onClick={onCancel}>{cancelLabel}</Button><Button variant={danger ? 'danger' : 'primary'} size="lg" busy={busy} busyLabel={busyLabel} disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button></>}
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
/** A leaving toast slides out, then its gap closes. `toast-out` and `toast-close` in ui.css end by then. */
const LEAVE_MS = 360
/** Let go this far right of where a swipe started, or past `FLICK_PX` while moving right faster than `FLICK` px per ms, and the toast leaves. */
const SWIPE_PX = 60
const FLICK = 0.3
const FLICK_PX = 16
/** A trackpad swipe has ended once its wheel events, momentum included, stop for this long. */
const WHEEL_END_MS = 120

export interface ToastProps { title: string; sub?: string; action?: { label: string; href?: string; onClick?: () => void; /** A bordered button, for an action that opens something in the app, not a link. */ boxed?: boolean }; onDismiss?: () => void }

/** A swipe in progress: `from` is where a pointer drag started (a trackpad swipe has none), `x` how far right the toast is, `v` its last speed. */
type Swipe = { from?: number; x: number; v: number; at: number; end?: ReturnType<typeof setTimeout> }

/**
 * One toast (WorkspaceToast.png, on one line where it fits, toast-motion-and-swipe). It slides in from the right, and after 2.6s
 * slides back out and calls `onDismiss` once its gap has closed. It stays while hovered or focused. Dragging it right, a two-finger
 * swipe right on a trackpad, or pressing its action dismisses it sooner. A toast without `onDismiss` stays put.
 */
export function Toast({ title, sub, action, onDismiss }: ToastProps) {
  const [held, setHeld] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const swipe = useRef<Swipe | null>(null)
  // Callers pass inline closures and re-render often. Keep the latest one in a ref so a render doesn't restart the timer.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const timed = !!onDismiss
  useEffect(() => {
    if (held || !timed || leaving) return
    const t = setTimeout(() => setLeaving(true), TOAST_MS)
    return () => clearTimeout(t)
  }, [held, timed, leaving])
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => dismiss.current?.(), LEAVE_MS)
    return () => clearTimeout(t)
  }, [leaving])
  useEffect(() => () => clearTimeout(swipe.current?.end), [])

  const begin = (at: number, from?: number) => {
    if (!box.current) return
    swipe.current = { from, x: 0, v: 0, at }
    box.current.dataset.swiping = ''
  }
  // The offset goes straight onto the element, so a drag doesn't render on every move. The toast never goes left of its place.
  const follow = (x: number, at: number) => {
    const s = swipe.current
    if (!s || !box.current) return
    const next = Math.max(0, x)
    s.v = (next - s.x) / Math.max(1, at - s.at)
    s.x = next
    s.at = at
    box.current.style.transform = next ? `translateX(${next}px)` : ''
  }
  // Far or fast enough and the toast slides on out from where it is. Otherwise it springs back.
  const settle = (at: number) => {
    const s = swipe.current
    swipe.current = null
    if (!s || !box.current) return
    clearTimeout(s.end)
    delete box.current.dataset.swiping
    if (s.x >= SWIPE_PX || (s.x >= FLICK_PX && s.v >= FLICK && at - s.at < 100)) setLeaving(true)
    else box.current.style.transform = ''
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!timed || leaving || swipe.current || e.button !== 0 || (e.target as Element).closest('a, button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    begin(e.timeStamp, e.clientX)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const from = swipe.current?.from
    if (from !== undefined) follow(e.clientX - from, e.timeStamp)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => { if (swipe.current?.from !== undefined) settle(e.timeStamp) }
  // With natural scrolling, the macOS default, fingers moving right report a negative deltaX. A mostly vertical scroll starts nothing.
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!timed || leaving || swipe.current?.from !== undefined) return
    if (!swipe.current) {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      begin(e.timeStamp)
    }
    const s = swipe.current
    if (!s) return
    follow(s.x - e.deltaX, e.timeStamp)
    clearTimeout(s.end)
    s.end = setTimeout(() => settle(performance.now()), WHEEL_END_MS)
  }
  const act = () => {
    action?.onClick?.()
    if (timed) setLeaving(true)
  }
  return (
    <div className="toast-slot" data-leaving={leaving || undefined}>
      <div
        ref={box} className="toast" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}
      >
        <span className="grow toast-text"><span className="toast-title">{title}</span>{sub && <> <span className="toast-sub">{sub}</span></>}</span>
        {action && (action.href
          // A plain click would navigate the app window away (KERNEL-294), so a web link opens in the browser.
          ? <a className="toast-action" href={action.href} onClick={(e) => { e.preventDefault(); if (isWebUrl(action.href!)) void call('system.openExternal', { url: action.href! }); act() }}>{action.label}</a>
          : <button type="button" className="toast-action" data-boxed={action.boxed || undefined} onClick={act}>{action.label}</button>)}
      </div>
    </div>
  )
}

/** Bottom right, 16px from the edges, newest last. */
export function ToastStack({ children }: { children: ReactNode }) {
  return <div className="toast-stack" role="status">{children}</div>
}
