import { useEffect, useRef, useState } from 'react'
import { actions } from '../store'
import { IconButton } from './controls'

/**
 * The one copy control: a clipboard icon with no word and no background that turns into a check for 1.5s. `label` is its tooltip
 * and aria-label, and `text` can be a function for text that is costly to build. Only a failure toasts; `failSub` says what to
 * show with it, such as the command the person can copy by hand.
 */
export function CopyButton({ text, label, className, box, disabled, failSub }: { text: string | (() => string); label: string; className?: string; box?: 'xs' | 'sm' | 'md'; disabled?: boolean; failSub?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => {
    const value = typeof text === 'function' ? text() : text
    void navigator.clipboard.writeText(value).then(
      () => { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500) },
      () => actions.ui.toast({ title: 'Could not copy', sub: failSub ?? 'The clipboard is not available.' })
    )
  }
  return <IconButton icon={copied ? 'check' : 'copy'} size={14} box={box} className={className} disabled={disabled} label={copied ? 'Copied' : label} onClick={copy} />
}
