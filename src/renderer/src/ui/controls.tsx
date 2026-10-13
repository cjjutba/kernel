import { useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from 'react'
import { Icon, type IconName, type IconSize } from '../icons'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'merged'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** sm is 26px, for a toolbar or a card row (Run, Stop, Open). md is 28px, lg 32px. */
  size?: 'sm' | 'md' | 'lg'
  icon?: IconName
  /** The work this button started is running: it spins, says `busyLabel` and can't be pressed again (DESIGN.md, Busy buttons). */
  busy?: boolean
  /** What it says while busy, such as "Archiving". Without one it keeps its label. */
  busyLabel?: ReactNode
}

/** Primary is ink on canvas. Danger is red and belongs on the final confirm button only. Merged is purple, for merged PRs only. */
export function Button({ variant = 'secondary', size = 'md', icon, busy, busyLabel, disabled, className, children, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'secondary' && variant, size !== 'md' && size, className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spin" aria-hidden="true" /> : icon && <Icon name={icon} size={14} />}
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
}

/** `label` is required: it is the accessible name and the tooltip. `busy` swaps the icon for a spinner and the label for `busyLabel`.
 *  `size` is the icon. `box` is the button: 28px by default, md 26px, sm 24px and xs 22px for toolbars and dense rows. */
export function IconButton({ icon, label, size = 16, box, busy, busyLabel, disabled, className, type = 'button', ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & { icon: IconName; label: string; size?: IconSize; box?: 'xs' | 'sm' | 'md'; busy?: boolean; busyLabel?: string }) {
  return (
    <button type={type} className={['icon-btn', box, className].filter(Boolean).join(' ')} aria-label={busy && busyLabel ? busyLabel : label} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spin" aria-hidden="true" /> : <Icon name={icon} size={size} />}
    </button>
  )
}

/** A rounded filter or toggle. `pressed` marks the active one. */
export function Pill({ pressed, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return <button type={type} className={['pill', className].filter(Boolean).join(' ')} aria-pressed={pressed} {...rest} />
}

export interface TabItem { id: string; label: ReactNode }

/** Arrow keys move between tabs; the selected tab is the only one in the tab order. `underline` draws text tabs on a hairline (Settings, Providers). */
export function Tabs({ tabs, value, onChange, label, variant = 'pill' }: { tabs: TabItem[]; value: string; onChange: (id: string) => void; label: string; variant?: 'pill' | 'underline' }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + tabs.length) % tabs.length
    onChange(tabs[next].id)
    refs.current[next]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className={variant === 'underline' ? 'row tabs-underline' : 'row'} style={variant === 'underline' ? undefined : { gap: 2 }}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el }} type="button" role="tab" className="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>{t.label}</button>
      ))}
    </div>
  )
}

/** On/off switch (Settings rows). Name it with `label`, or wrap it in a labelled row. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="toggle" onClick={() => onChange(!checked)}><span /></button>
}

/** A checkbox and its label, one row. `align="top"` pins the box to the first line of a label that wraps or has a second line. Pass the
 *  row's own class (a bordered option, a list item) as `className`; the box itself always looks the same. */
export function Checkbox({ checked, onChange, align = 'center', className, children, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> & { checked: boolean; onChange: (checked: boolean) => void; align?: 'center' | 'top'; children: ReactNode }) {
  return (
    <label className={['check', className].filter(Boolean).join(' ')} data-align={align === 'top' ? 'top' : undefined}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} {...rest} />
      {children}
    </label>
  )
}

/** A native select with the canvas chrome, so keyboard and screen readers work for free. `inline` is the bare value with up and down
 *  chevrons, for a settings row inside a popover (New chat's branch options). */
export function Select({ options, label, variant = 'field', className, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-label'> & { options: { value: string; label: string }[]; label: string; variant?: 'field' | 'inline' }) {
  return (
    <span className={[variant === 'inline' ? 'select-inline' : 'select', className].filter(Boolean).join(' ')}>
      <select aria-label={label} {...rest}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      <Icon name={variant === 'inline' ? 'chevrons' : 'chevron'} size={12} />
    </span>
  )
}

/** A select drawn as a chip: `children` show the choice (a name, a value, a letter tile), and the real select lies over the chip, invisible,
 *  so the keyboard and screen readers work. `label` is the select's accessible name. */
export function SelectChip({ options, value, onChange, label, className, children }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; label: string; className?: string; children: ReactNode }) {
  return (
    <span className={['select-chip', className].filter(Boolean).join(' ')}>
      {children}
      <Icon name="chevron" size={12} />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  )
}

/** One choice of a few (Theme: Dark, Light, System). Arrow keys move and select, like a radio group. `busy` puts the spinner arc before an option's label, for a script that is running. */
export function SegmentedControl({ options, value, onChange, label }: { options: { value: string; label: string; busy?: boolean }[]; value: string; onChange: (v: string) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { refs.current[i] = el }} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)} onKeyDown={(e) => onKey(e, i)} aria-label={o.busy ? `${o.label}, running` : undefined}>{o.busy && <span className="spin" aria-hidden="true" />}{o.label}</button>
      ))}
    </div>
  )
}
