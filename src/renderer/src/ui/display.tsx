import { useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import type { BannerKind } from '@shared/types'
import { Icon, type IconName } from '../icons'
import { Button, IconButton } from './controls'
import { useSwipeDismiss } from './useSwipeDismiss'
import { dotPatterns, type SpinnerPattern } from './dotPatterns'

/** One icon per failure type (DESIGN.md Patterns). */
export const bannerIcon: Record<BannerKind, IconName> = {
  limit: 'clock', context: 'context', offline: 'wifioff', auth: 'key', setup: 'close', hooks: 'plug', retry: 'history', trust: 'shield'
}

/**
 * A banner: neutral surface, an icon for its type, never a red background. `warn` is a heads-up that stops nothing, with a warning triangle (KERNEL-619). With `onDismiss` it has a close button that shows on
 * hover or focus, and dragging it right, or swiping right on a trackpad, closes it too, as it does a toast.
 */
export function Banner({ kind, title, children, actions, onDismiss }: { kind: BannerKind | 'warn'; title: string; children?: ReactNode; actions?: ReactNode; onDismiss?: () => void }) {
  const { ref, leaving, leave, handlers } = useSwipeDismiss<HTMLDivElement>(onDismiss)
  return (
    <div role="alert" className="banner" data-kind={kind} data-dismissible={onDismiss ? '' : undefined} data-leaving={leaving || undefined} ref={ref} {...handlers}>
      {kind === 'retry' ? <Spinner label={null} pattern="rotate" /> : <Icon name={kind === 'warn' ? 'warning' : bannerIcon[kind]} />}
      <div className="grow"><div className="banner-title">{title}</div>{children && <div className="muted">{children}</div>}</div>
      {actions}
      {onDismiss && <IconButton className="banner-close" icon="close" label="Dismiss" size={12} onClick={leave} />}
    </div>
  )
}

export type ChipKind = 'file' | 'image' | 'mention' | 'skill'
const chipIcon: Partial<Record<ChipKind, IconName>> = { file: 'doc', image: 'image' }
const chipGlyph: Partial<Record<ChipKind, string>> = { mention: '@', skill: '/' }

/** A reference in the composer or a message. Remove with the button, or Backspace when focused. */
export function Chip({ kind, children, onRemove }: { kind: ChipKind; children: ReactNode; onRemove?: () => void }) {
  return (
    <span className="chip" data-kind={kind}>
      {chipIcon[kind] ? <Icon name={chipIcon[kind]} size={12} /> : <span aria-hidden="true" className="muted">{chipGlyph[kind]}</span>}
      <span className="ellipsis" style={{ maxWidth: 220 }}>{children}</span>
      {onRemove && <button type="button" className="chip-x" aria-label={`Remove ${typeof children === 'string' ? children : kind}`} onClick={onRemove}><Icon name="close" size={12} /></button>}
    </span>
  )
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={['card', className].filter(Boolean).join(' ')} {...rest} />
}

/** How full a meter reads: amber from 75%, red from 90%, the context ring's steps (CONTEXT_NEAR, CONTEXT_WARN). `value` is 0 to 1. */
export const meterLevel = (value: number): 'near' | 'full' | undefined => (value >= 0.9 ? 'full' : value >= 0.75 ? 'near' : undefined)

/** A usage bar. `value` is 0 to 1. Grey, then amber from 75% and red from 90%, as the context ring does (feat-providers-redesign, amends D-026). */
export function Meter({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} className="meter" data-level={meterLevel(v)}>
      <span style={{ width: `${v * 100}%` }} />
    </div>
  )
}

/** Code with a copy button. The button says "Copied" for 1.5s. `inline` is the setup canvases' command line: Copy beside the command, outlined, with no icon. */
export function CodeBlock({ children, label = 'Copy', inline }: { children: string; label?: string; inline?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(children).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <div className="codeblock" data-inline={inline || undefined}>
      <pre className="code">{children}</pre>
      <Button size="md" variant={inline ? 'secondary' : 'ghost'} icon={inline ? undefined : copied ? 'check' : 'copy'} onClick={copy} aria-label={copied ? 'Copied' : label}>{copied ? 'Copied' : label}</Button>
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

/** A stable offset into the 1s loop from an id, so a row keeps its rhythm across renders and rows run out of step. */
function phaseOf(seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return `${((h % 10) / 10).toFixed(1)}s`
}

/**
 * The loader: a 3x3 grid of dots whose opacity loops once a second, in a pattern that says what kind of wait it is (the library is in `dotPatterns.ts`, shown in DevUi, and which place uses which is in DESIGN.md, Motion). It is sized in em, so it follows the text beside it, and it always sits beside words.
 * A string `label` makes it a status. `null` makes it decorative, for a button or row that already shows a word. `seed` starts the loop at a point taken from an id. Under reduced motion it holds a still frame that shows the pattern's shape (KERNEL-714, KERNEL-740, KERNEL-759).
 */
export function Spinner({ label = 'Loading', pattern = 'wave', seed, className }: { label?: string | null; pattern?: SpinnerPattern; seed?: string; className?: string }) {
  const a11y = label === null ? { 'aria-hidden': true as const } : { role: 'status', 'aria-label': label }
  const cls = `dots${className ? ` ${className}` : ''}`
  const { n, shape, dots, still } = dotPatterns[pattern]
  const style = { '--n': n, ...(seed ? { '--phase': phaseOf(seed) } : null) } as CSSProperties
  return (
    <span className={cls} data-pattern={pattern} data-shape={shape} style={style} {...a11y}>
      {dots.map((d, i) => <i key={i} data-shape={d.shape} style={{ '--k': d.at, '--a': d.peak, '--s': still.includes(i) ? 0.4 : undefined } as CSSProperties} />)}
    </span>
  )
}

export function Skeleton({ width = '100%', height = 12 }: { width?: number | string; height?: number | string }) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height }} />
}

export function EmptyState({ icon, title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon"><Icon name={icon} size={20} /></span>}
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
      {action}
    </div>
  )
}
