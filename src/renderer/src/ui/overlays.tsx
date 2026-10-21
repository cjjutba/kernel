import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject, type WheelEvent } from 'react'
import { call } from '../api'
import { Icon, type IconName } from '../icons'
import { Button } from './controls'
import { useLayer } from './hooks'
import type { SpinnerPattern } from './dotPatterns'

export interface MenuEntry {
  id: string
  label: string
  icon?: IconName
  /** Drawn in place of `icon`, such as a project's picture. */
  leading?: ReactNode
  /** Makes the item a radio of its menu: it is announced as checked or not, and a checked one shows a check mark (SettingsProjectIcon.png). */
  checked?: boolean
  /** Shown on the right, for example "⌘N". */
  shortcut?: string
  /** A short word after the label, before the check, that says something about the item ("Detected", SettingsProjectTracker.png). */
  note?: string
  /** A nested menu, opened on hover, click or ArrowRight. */
  children?: MenuEntry[]
  /** A heading for the entries after it, up to the next one. `leading` draws before its label, such as a provider's mark. It isn't an item: no focus, no selection. */
  title?: boolean
  /** Drawn in place of the label, note and shortcut, for an item that needs more than one line (an account and its usage). */
  content?: ReactNode
  /** The accessible name, when `content` doesn't read well on its own. */
  ariaLabel?: string
  disabled?: boolean
  /** The menu stays open after this item is picked, for an action that shows its progress in the menu. Its owner closes the menu when the action is done (KERNEL-986). */
  keepOpen?: boolean
  /** Red text and icon. For the one destructive entry, such as Remove project (SidebarProjectMenu.png). */
  danger?: boolean
  onSelect?: () => void
}

/** A divider between groups of items. */
export const MENU_SEPARATOR = { id: '-' } as const

const ITEM_ON = ':is([role=menuitem], [role=menuitemradio]):not(:disabled)'

function MenuList({ items, onClose, onBack, label, heading, initiallyOpen }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; onBack?: () => void; label?: string; heading?: ReactNode; initiallyOpen?: string }) {
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
      {heading && <div className="menu-head" aria-hidden={typeof heading === 'string' || undefined}>{heading}</div>}
      {items.map((it) => {
        if (it.id === '-') return <div key={`sep-${items.indexOf(it)}`} role="separator" className="menu-sep" />
        const m = it as MenuEntry
        if (m.title) return <div key={m.id} className="menu-title" aria-hidden="true">{m.leading}{m.label}</div>
        const sub = m.children?.length
        return (
          <div key={m.id} className="menu-row" onMouseEnter={() => sub && setOpen(m.id)} onMouseLeave={() => sub && setOpen(null)}>
            <button
              ref={(el) => { openers.current[m.id] = el }} type="button" role={m.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={m.checked} className="menu-item" aria-label={m.ariaLabel} data-danger={m.danger || undefined} disabled={m.disabled} aria-haspopup={sub ? 'menu' : undefined} aria-expanded={sub ? open === m.id : undefined} data-rich={m.content ? true : undefined}
              onClick={() => { if (sub) setOpen(m.id); else { m.onSelect?.(); if (!m.keepOpen) onClose() } }}
              onKeyDown={(e) => { if (sub && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setOpen(m.id) } }}
            >
              {m.content ?? (
                <>
                  {m.leading ?? (m.icon && <Icon name={m.icon} />)}
                  <span className="grow ellipsis">{m.label}</span>
                  {m.note && <span className="menu-note">{m.note}</span>}
                  {m.checked ? <Icon name="check" size={14} /> : m.note ? <span className="menu-check-slot" aria-hidden="true" /> : null}
                  {m.shortcut && <span className="menu-kbd">{m.shortcut}</span>}
                  {sub ? <Icon name="right" size={12} /> : null}
                </>
              )}
            </button>
            {sub && open === m.id && (
              <Submenu><MenuList items={m.children!} onClose={onClose} onBack={() => { setOpen(null); openers.current[m.id]?.focus() }} label={m.label} /></Submenu>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A flyout: opens to the right, level with its row, and opens upward (its bottom level with the row's) when there is no room below. */
function Submenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [up, setUp] = useState(false)
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (r && r.bottom > window.innerHeight - 8) setUp(true)
  }, [])
  return <div ref={ref} className="submenu" data-up={up || undefined}>{children}</div>
}

/**
 * A menu with shortcuts and submenus. Position it by placing it in a `position: relative` parent (see Popover),
 * or pass `style`. Escape and a press outside call `onClose`. `heading` is a short title above the first item, or a few
 * lines of it, such as the account menu's accounts.
 */
export function Menu({ items, onClose, label, heading, style, initiallyOpen, anchorRef }: { items: (MenuEntry | typeof MENU_SEPARATOR)[]; onClose: () => void; label?: string; heading?: ReactNode; style?: React.CSSProperties; initiallyOpen?: string; anchorRef?: RefObject<HTMLElement | null> }) {
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
 * The one modal shell. Blur scrim over the whole window (z-index 40), dialog above it (50), 18px radius, 1px border.
 * Escape and a press on the scrim play a short exit, then call `onClose` once. Mark a custom footer's Cancel `data-dismiss`
 * (and leave its `onClick` off) to get the same exit. A close that follows an action calls its own handler and leaves at once.
 * Focus moves in on open and back to the trigger on close.
 */
export function Modal({ title, onClose, children, footer, width, top, bare, role = 'dialog', labelledBy, describedBy }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; top?: number; bare?: boolean; role?: 'dialog' | 'alertdialog'; labelledBy?: string; describedBy?: string }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const latest = useRef(onClose)
  latest.current = onClose
  const closingRef = useRef(false)
  const dismiss = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    // Reduced motion runs no exit, so no animationend would come.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) latest.current()
    else setClosing(true)
  }, [])
  useLayer({ onEscape: dismiss, blocking: true, ref })
  useEffect(() => {
    if (closing) ref.current?.setAttribute('inert', '')
  }, [closing])
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not([data-close])')
    ;(first ?? ref.current)?.focus({ preventScroll: true })
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
      <div className="scrim" data-closing={closing || undefined} onMouseDown={dismiss} />
      <div
        ref={ref} role={role} aria-modal="true" aria-labelledby={labelledBy ?? id} aria-describedby={describedBy} tabIndex={-1} className="modal" data-closing={closing || undefined} style={place} onKeyDown={trap}
        onClick={(e) => { if ((e.target as Element).closest('[data-dismiss]')) dismiss() }}
        onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget && e.animationName === 'modal-out') latest.current() }}
      >
        {!bare && (
          <div className="modal-head">
            <h2 id={id}>{title}</h2>
            <button type="button" data-close className="icon-btn" aria-label="Close" onClick={dismiss}><Icon name="close" /></button>
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
export function ConfirmDialog({ title, body, children, extra, confirmLabel, cancelLabel = 'Cancel', danger, busy, busyLabel, busyPattern, disabled, focusConfirm, onConfirm, onCancel, onDismiss }: { title: string; body: ReactNode; /** Extra content under the body, such as a path box or a checkbox. */ children?: ReactNode; /** A second way out, on the left of the footer, such as "Archive anyway" (ConfirmArchive.png). */ extra?: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; /** The confirm action is running: its button spins and says `busyLabel`, such as "Archiving". */ busy?: boolean; busyLabel?: string; busyPattern?: SpinnerPattern; /** The confirm button can't be pressed yet, such as while the dialog reads the branch. */ disabled?: boolean; onConfirm: () => void; onCancel: () => void; /** Escape and a press on the scrim call this, and the cancel button calls `onCancel`, when closing without answering is not the same as cancelling. */ onDismiss?: () => void; /** Focus starts on the confirm button. */ focusConfirm?: boolean }) {
  const id = useId()
  return (
    <Modal
      title={title} onClose={onDismiss ?? onCancel} width={480} top={220} role="alertdialog" describedBy={`${id}b`}
      footer={<>{extra}<span className="grow" /><Button variant="ghost" size="lg" {...(onDismiss ? { disabled, onClick: onCancel } : { 'data-dismiss': true })}>{cancelLabel}</Button><Button variant={danger ? 'danger' : 'primary'} size="lg" data-autofocus={focusConfirm || undefined} busy={busy} busyLabel={busyLabel} busyPattern={busyPattern} disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button></>}
    >
      <div className="confirm-body">
        <p id={`${id}b`}>{body}</p>
        {children}
      </div>
    </Modal>
  )
}

/** How long a toast stays (DESIGN.md). */
export const TOAST_MS = 5000
/** A leaving toast slides out, then its gap closes. `toast-out-*` and `toast-close` in ui.css end by then. */
const LEAVE_MS = 360
/** Let go this far right or down of where a swipe started, or past `FLICK_PX` while moving that way faster than `FLICK` px per ms, and the toast leaves. */
const SWIPE_PX = 60
const FLICK = 0.3
const FLICK_PX = 16
/** A swipe locks to right or down once it has travelled this far. */
const LOCK_PX = 6
/** A trackpad swipe has ended once its wheel events, momentum included, stop for this long. */
const WHEEL_END_MS = 120

/** A toast's button. `primary` fills it, for the action that fixes what went wrong. `kbd` is the shortcut that presses it, shown in its tooltip. */
export interface ToastButton { label: string; onClick?: () => void; primary?: boolean; kbd?: string }
export type ToastGlyph = 'done' | 'error' | 'merged' | 'plug' | 'download'
const glyphIcon: Record<ToastGlyph, IconName> = { done: 'check', error: 'alertCircle', merged: 'merged', plug: 'plug', download: 'download' }

export interface ToastProps { title: string; sub?: string; /** A third, quieter line: what the toast is about. */ detail?: string; glyph?: ToastGlyph; /** Up to two, drawn left to right with the last at the edge. */ actions?: ToastButton[]; /** Leave now, the way a timeout does. */ closing?: boolean; /** Stay until closed or an action is pressed, with no 5s timeout: a toast about something waiting on the person, such as a downloaded update. Needs `onDismiss`. */ stay?: boolean; onDismiss?: () => void }

/** A sub that is a path breaks at its slashes, not in the middle of a name. */
function breakAtSlashes(text: string): ReactNode[] {
  return text.split(/(?<=\/)/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]))
}

/** `sink` is the timeout and the action: down and faded. A swipe leaves the way it went. */
type Leave = 'sink' | 'right' | 'down'

/** A swipe in progress: `from` is where a pointer drag started (a trackpad swipe has none), `rx` and `ry` how far the fingers have moved right and down, `axis` the direction it locked to, `x` how far the toast is along it, `v` its last speed. */
type Swipe = { from?: { x: number; y: number }; rx: number; ry: number; axis?: 'x' | 'y'; x: number; v: number; at: number; end?: ReturnType<typeof setTimeout> }

/**
 * One toast (Pen 18.1 and 18.3, toast-motion-and-swipe): a glyph, the title over its sub, a close button, and up to two actions. It rises from the bottom, and after 5s sinks and
 * fades, then calls `onDismiss` once its gap has closed. It stays while hovered or focused. Dragging it right or down, a
 * two-finger swipe right or down on a trackpad, or pressing its action dismisses it sooner. A swipe leaves in its own direction.
 * A toast without `onDismiss` stays put.
 */
export function Toast({ title, sub, detail, glyph = 'done', actions, closing, stay, onDismiss }: ToastProps) {
  const [held, setHeld] = useState(false)
  const [leaving, setLeaving] = useState<Leave | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const swipe = useRef<Swipe | null>(null)
  // Callers pass inline closures and re-render often. Keep the latest one in a ref so a render doesn't restart the timer.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const timed = !!onDismiss
  useEffect(() => {
    if (held || !timed || stay || leaving) return
    const t = setTimeout(() => setLeaving('sink'), TOAST_MS)
    return () => clearTimeout(t)
  }, [held, timed, stay, leaving])
  useEffect(() => {
    if (closing && timed) setLeaving((l) => l ?? 'sink')
  }, [closing, timed])
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => dismiss.current?.(), LEAVE_MS)
    return () => clearTimeout(t)
  }, [leaving])
  useEffect(() => () => clearTimeout(swipe.current?.end), [])

  const begin = (at: number, from?: { x: number; y: number }) => {
    if (!box.current) return
    swipe.current = { from, rx: 0, ry: 0, x: 0, v: 0, at }
    box.current.dataset.swiping = ''
  }
  // The offset goes straight onto the element, so a drag doesn't render on every move. It locks to right or down after LOCK_PX,
  // and the toast never goes left or up of its place.
  const follow = (rx: number, ry: number, at: number) => {
    const s = swipe.current
    if (!s || !box.current) return
    s.rx = rx
    s.ry = ry
    if (!s.axis) {
      if (Math.max(Math.abs(rx), Math.abs(ry)) < LOCK_PX) return
      s.axis = Math.abs(rx) >= Math.abs(ry) ? 'x' : 'y'
    }
    const next = Math.max(0, s.axis === 'x' ? rx : ry)
    s.v = (next - s.x) / Math.max(1, at - s.at)
    s.x = next
    s.at = at
    box.current.style.transform = next ? (s.axis === 'x' ? `translateX(${next}px)` : `translateY(${next}px)`) : ''
  }
  // Far or fast enough and the toast slides on out from where it is, the way it went. Otherwise it springs back.
  const settle = (at: number) => {
    const s = swipe.current
    swipe.current = null
    if (!s || !box.current) return
    clearTimeout(s.end)
    delete box.current.dataset.swiping
    if (s.axis && (s.x >= SWIPE_PX || (s.x >= FLICK_PX && s.v >= FLICK && at - s.at < 100))) setLeaving(s.axis === 'x' ? 'right' : 'down')
    else box.current.style.transform = ''
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!timed || leaving || swipe.current || e.button !== 0 || (e.target as Element).closest('a, button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    begin(e.timeStamp, { x: e.clientX, y: e.clientY })
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const from = swipe.current?.from
    if (from) follow(e.clientX - from.x, e.clientY - from.y, e.timeStamp)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => { if (swipe.current?.from) settle(e.timeStamp) }
  // With natural scrolling, the macOS default, fingers moving right report a negative deltaX and fingers moving down a negative deltaY.
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!timed || leaving || swipe.current?.from) return
    if (!swipe.current) begin(e.timeStamp)
    const s = swipe.current
    if (!s) return
    follow(s.rx - e.deltaX, s.ry - e.deltaY, e.timeStamp)
    clearTimeout(s.end)
    s.end = setTimeout(() => settle(performance.now()), WHEEL_END_MS)
  }
  const act = (a: ToastButton) => {
    a.onClick?.()
    if (timed) setLeaving('sink')
  }
  return (
    <div className="toast-slot" data-leaving={leaving || undefined}>
      <div
        ref={box} className="toast" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}
      >
        <div className="toast-top">
          <span className="toast-glyph" data-glyph={glyph} aria-hidden="true"><Icon name={glyphIcon[glyph]} size={14} /></span>
          <span className="grow toast-text"><span className="toast-title">{title}</span>{sub && <span className="toast-sub">{breakAtSlashes(sub)}</span>}{detail && <span className="toast-detail">{detail}</span>}</span>
          {timed && <button type="button" className="toast-close" aria-label="Close" onClick={() => setLeaving('sink')}><Icon name="close" size={12} /></button>}
        </div>
        {!!actions?.length && (
          <div className="toast-actions">
            {actions.map((a) => (
              <button key={a.label} type="button" className="toast-action" data-primary={a.primary || undefined} data-tip={a.kbd ? a.label : undefined} data-tip-kbd={a.kbd}
                onClick={() => act(a)}>{a.label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Bottom right, newest last. */
export function ToastStack({ children }: { children: ReactNode }) {
  return <div className="toast-stack" role="status">{children}</div>
}
