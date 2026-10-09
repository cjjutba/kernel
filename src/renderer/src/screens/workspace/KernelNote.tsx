import type { ChatItem } from '@shared/types'
import { copyText, MessageActions } from './MessageActions'

const textOf = (item: Extract<ChatItem, { kind: 'user' }>) => item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')

/** Kernel's own message in a chat, such as its restart nudge: a note with Copy, not the user's bubble (KERNEL-120). */
export function KernelNote({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  return (
    <div className="msg msg-kernel">
      <div className="note"><span className="grow">{textOf(item)}</span></div>
      <MessageActions label="Message actions" items={[{ label: 'Copy', onClick: () => void copyText(textOf(item)) }]} />
    </div>
  )
}
