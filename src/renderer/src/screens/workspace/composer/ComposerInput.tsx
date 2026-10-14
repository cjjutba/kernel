import type { ComponentProps } from 'react'
import { DraftInput } from './draft'
import './composer.css'

/** The message box's input with the "⌘L to focus" hint in its top right corner while the box is empty. */
export function ComposerInput({ d, disabled, ...rest }: ComponentProps<typeof DraftInput>) {
  const hint = !disabled && !d.parts.length
  return (
    <div className="cmp-field" data-hint={hint || undefined}>
      <DraftInput d={d} disabled={disabled} {...rest} />
      {hint && <span className="cmp-hint" aria-hidden="true">⌘L to focus</span>}
    </div>
  )
}
