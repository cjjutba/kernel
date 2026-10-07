import { useState, type HTMLAttributes, type ReactNode } from 'react'
import type { BannerKind } from '@shared/types'
import { Icon, type IconName } from '../icons'
import { Button, IconButton } from './controls'

/** One icon per failure type (DESIGN.md Patterns). */
export const bannerIcon: Record<BannerKind, IconName> = {
  limit: 'clock', context: 'list', offline: 'wifi', auth: 'lock', setup: 'x', hooks: 'plug', retry: 'retry'
}

/** A failure banner: neutral surface, an icon for its type, never a red background. */
export function Banner({ kind, title, children, actions, onDismiss }: { kind: BannerKind; title: string; children?: ReactNode; actions?: ReactNode; onDismiss?: () => void }) {
  return (
    <div role="alert" className="banner" data-kind={kind}>
      {kind === 'retry' ? <span className="spin" aria-hidden="true" /> : <Icon name={bannerIcon[kind]} />}
      <div className="grow"><div className="banner-title">{title}</div>{children && <div className="muted">{children}</div>}</div>
      {actions}
      {onDismiss && <IconButton icon="close" label="Dismiss" size={14} onClick={onDismiss} />}
    </div>
  )
}

export type ChipKind = 'file' | 'image' | 'mention' | 'skill'
const chipIcon: Record<ChipKind, IconName> = { file: 'doc', image: 'image', mention: 'at', skill: 'slash' }

/** A reference in the composer or a message. Remove with the button, or Backspace when focused. */
export function Chip({ kind, children, onRemove }: { kind: ChipKind; children: ReactNode; onRemove?: () => void }) {
  return (
    <span className="chip" data-kind={kind}>
      <Icon name={chipIcon[kind]} size={12} />
      <span className="ellipsis" style={{ maxWidth: 220 }}>{children}</span>
      {onRemove && <button type="button" className="chip-x" aria-label={`Remove ${typeof children === 'string' ? children : kind}`} onClick={onRemove}><Icon name="close" size={10} /></button>}
    </span>
  )
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={['card', className].filter(Boolean).join(' ')} {...rest} />
}

/** A usage bar. `value` is 0 to 1. At 85% and over it turns from grey to the ink color (white in dark). */
export function Meter({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} className="meter" data-hot={v >= 0.85 ? 'true' : undefined}>
      <span style={{ width: `${v * 100}%` }} />
    </div>
  )
}

/** Code with a copy button. The button says "Copied" for 1.5s. */
export function CodeBlock({ children, label = 'Copy' }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(children).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <div className="codeblock">
      <pre className="code">{children}</pre>
      <Button size="md" variant="ghost" icon={copied ? 'check' : 'copy'} onClick={copy} aria-label={copied ? 'Copied' : label}>{copied ? 'Copied' : label}</Button>
    </div>
  )
}

/** A keyboard shortcut, like ⌘K. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

/** The letter square used for rooms, agents and people. */
export function Avatar({ name, size = 20, solid }: { name: string; size?: number; solid?: boolean }) {
  return <span className="avatar" data-solid={solid ? 'true' : undefined} aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}>{name.trim()[0]?.toUpperCase()}</span>
}

/** A spinning ring. Stops under reduced motion. */
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spin" role="status" aria-label={label} />
}

export function Skeleton({ width = '100%', height = 12 }: { width?: number | string; height?: number | string }) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height }} />
}

export function EmptyState({ icon, title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon"><Icon name={icon} size={18} /></span>}
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
      {action}
    </div>
  )
}
