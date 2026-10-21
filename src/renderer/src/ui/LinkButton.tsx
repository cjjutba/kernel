import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './display'
import type { SpinnerPattern } from './dotPatterns'

export type LinkVariant = 'inline' | 'action' | 'quiet'

export interface LinkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** inline is underlined, for a link inside a sentence or a one-off action (Undo, Open in editor). action is plain until pointed at (Inbox). quiet is muted, for a see-all or a card's Open. */
  variant?: LinkVariant
  /** Without one it takes the size of the text around it. */
  size?: 'meta' | 'ui'
  busy?: boolean
  busyLabel?: ReactNode
  busyPattern?: SpinnerPattern
}

/** The one text button that acts like a link (DESIGN.md, Buttons). Drive `busy` with `useBusy`, as for Button. */
export function LinkButton({ variant = 'inline', size, busy, busyLabel, busyPattern = 'ripple', disabled, className, children, type = 'button', ...rest }: LinkButtonProps) {
  return (
    <button type={type} className={['link-button', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <Spinner label={null} pattern={busyPattern} />}
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
}
