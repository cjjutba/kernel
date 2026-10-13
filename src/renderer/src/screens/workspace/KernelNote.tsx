import { useId, useState } from 'react'
import type { ChatItem } from '@shared/types'
import { Button, Icon } from '../../ui'
import { useCopy } from './MessageActions'

const textOf = (item: Extract<ChatItem, { kind: 'user' }>) => item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ').trim()

/**
 * Kernel's own message in a chat, such as its restart nudge, as one note line like the quit note, not the user's bubble
 * (KERNEL-120). Clicking it, or Enter, opens the full text with Copy: the line itself unfolds, or when `lead` is set the message shows under it. `lead` is the line to show when the message follows a
 * quit or crash note and folds into it, so a relaunch is one line.
 */
export function KernelNote({ item, lead }: { item: Extract<ChatItem, { kind: 'user' }>; lead?: string }) {
  const [open, setOpen] = useState(false)
  const body = useId()
  const text = textOf(item)
  const [copied, copy] = useCopy(text)
  return (
    <div className="msg msg-kernel" data-open={open || undefined}>
      <button type="button" className="note inline knote" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
        <Icon name="right" size={12} />
        <span className="note-text">{lead ?? text}</span>
        <span className="note-rule" aria-hidden="true" />
      </button>
      {open && (
        <div id={body} className="knote-full">
          {lead && <p className="selectable">{text}</p>}
          <Button variant="ghost" icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
      )}
    </div>
  )
}
