import { useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from 'react'
import { Icon, type IconName } from '../icons'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'merged'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'lg'
  icon?: IconName
}

/** Primary is ink on canvas. Danger is red and belongs on the final confirm button only. Merged is purple, for merged PRs only. */
export function Button({ variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'secondary' && variant, size === 'lg' && 'lg', className].filter(Boolean).join(' ')
  return <button type={type} className={cls} {...rest}>{icon && <Icon name={icon} size={14} />}{children}</button>
}

/** `label` is required: it is the accessible name and the tooltip. */
export function IconButton({ icon, label, size = 16, className, type = 'button', ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & { icon: IconName; label: string; size?: number }) {
  return <button type={type} className={['icon-btn', className].filter(Boolean).join(' ')} aria-label={label} title={label} {...rest}><Icon name={icon} size={size} /></button>
}

/** A rounded filter or toggle. `pressed` marks the active one. */
export function Pill({ pressed, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return <button type={type} className={['pill', className].filter(Boolean).join(' ')} aria-pressed={pressed} {...rest} />
}

export interface TabItem { id: string; label: ReactNode }

/** Arrow keys move between tabs; the selected tab is the only one in the tab order. */
export function Tabs({ tabs, value, onChange, label }: { tabs: TabItem[]; value: string; onChange: (id: string) => void; label: string }) {
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
    <div role="tablist" aria-label={label} className="row" style={{ gap: 2 }}>
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

/** A native select with the canvas chrome, so keyboard and screen readers work for free. */
export function Select({ options, label, className, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-label'> & { options: { value: string; label: string }[]; label: string }) {
  return (
    <span className={['select', className].filter(Boolean).join(' ')}>
      <select aria-label={label} {...rest}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      <Icon name="chevron" size={11} />
    </span>
  )
}

/** One choice of a few (Theme: Dark, Light, System). Arrow keys move and select, like a radio group. */
export function SegmentedControl({ options, value, onChange, label }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; label: string }) {
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
        <button key={o.value} ref={(el) => { refs.current[i] = el }} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)} onKeyDown={(e) => onKey(e, i)}>{o.label}</button>
      ))}
    </div>
  )
}
