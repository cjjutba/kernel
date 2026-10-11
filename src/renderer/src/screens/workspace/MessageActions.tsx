import { useState } from 'react'
import { actions } from '../../store'
import { cleanError } from '../../api'
import { IconButton, useBusy, type IconName } from '../../ui'

/** What a failed action says. A channel that no lane has built yet rejects with "Not built yet: ...", which is fine to show as it is. */
export async function attempt(title: string, fn: () => Promise<unknown>) {
  try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
}

/** Copies `text` and says "Copied" for 1.5s. Only a failure toasts. */
export function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard.writeText(text).then(
    () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
    () => actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' })
  )
  return [copied, copy]
}

export interface MessageAction { icon: IconName; label: string; busyLabel?: string; onClick: () => unknown }

/**
 * Copy, then retry, edit and fork, as icon buttons under a message. Each one's label is its tooltip (DESIGN.md). Copy turns
 * into a check for 1.5s instead of toasting, and an action that waits on the main process spins until it settles. Hidden
 * until the message is hovered or something in it has focus (DESIGN.md), but the row keeps its height so nothing shifts.
 */
export function MessageActions({ copy, items = [], align = 'start', label }: { copy: string; items?: MessageAction[]; align?: 'start' | 'end'; label: string }) {
  const [copied, onCopy] = useCopy(copy)
  const [busy, run] = useBusy()
  return (
    <div className="msg-acts" data-align={align} role="group" aria-label={label}>
      <IconButton icon={copied ? 'check' : 'copy'} size={14} label={copied ? 'Copied' : 'Copy'} onClick={onCopy} />
      {items.map((a) => (
        <IconButton key={a.label} icon={a.icon} size={14} label={a.label} busy={busy === a.label} busyLabel={a.busyLabel} disabled={busy !== null}
          onClick={() => void run(a.label, async () => a.onClick())} />
      ))}
    </div>
  )
}
