import type { HTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Icon, type IconName } from '../icons'
import { Spinner } from './display'
import './splitButton.css'

export interface SplitButtonProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'onClick'> {
  /** sm is 26px with the `--r-sm` radius (Run, Open). md is 28px with `--r` (Open in, Create PR, Settings files). */
  size?: 'sm' | 'md'
  icon?: IconName
  /** The main half's content. Leave it out for an icon-only half, which is wider than tall. */
  children?: ReactNode
  /** The main half's own props: its aria-label, tooltip data attributes and `aria-busy`. */
  mainProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled' | 'type'> & { [K in `data-${string}`]?: string | undefined }
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  busyLabel?: ReactNode
  /** The caret's accessible name, such as "Run scripts". */
  caretLabel: string
  expanded: boolean
  onCaret: () => void
  caretDisabled?: boolean
  /** The caret's wrapper, which a `Menu` anchors to. */
  anchorRef?: Ref<HTMLSpanElement>
  /** The open menu, drawn inside the caret's wrapper. */
  menu?: ReactNode
}

/** One joined control for every split button: a hairline frame, a main half that acts and a caret half that opens a menu. Tone comes from `color` and `border-color` on the frame. */
export function SplitButton({ size = 'md', icon, children, mainProps, onClick, disabled, busy, busyLabel, caretLabel, expanded, onCaret, caretDisabled, anchorRef, menu, className, ...rest }: SplitButtonProps) {
  const label = busy && busyLabel !== undefined ? busyLabel : children
  return (
    <span className={['split', className].filter(Boolean).join(' ')} data-size={size} {...rest}>
      <button type="button" className="split-main" data-icon-only={label === undefined || label === null || undefined} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick} {...mainProps}>
        {busy ? <Spinner label={null} pattern="ripple" /> : icon && <Icon name={icon} size={14} />}
        {label}
      </button>
      <span ref={anchorRef} className="split-anchor">
        <button type="button" className="split-caret" aria-label={caretLabel} aria-haspopup="menu" aria-expanded={expanded} disabled={caretDisabled} onClick={onCaret}>
          <Icon name="chevron" size={12} />
        </button>
        {menu}
      </span>
    </span>
  )
}
