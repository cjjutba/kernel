import type { ChatPart, QueuedMessage, QueueReason } from '@shared/types'
import { Button, Icon } from '../../../ui'
import { NoteText } from '../NoteText'
import type { WaitLine } from '../waitLines'

/** The message as one line: its text, with skills as `/name`. Files and images are counted by `extras`, not folded in. */
const lineOf = (parts: ChatPart[]) => parts.map((p) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : '')).join(' ').replace(/\s+/g, ' ').trim()

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "+1 file", "+2 images": what the message carries besides its text. */
function extras(parts: ChatPart[]): string {
  const files = parts.filter((p) => p.type === 'file').length
  const images = parts.filter((p) => p.type === 'image').length
  const other = parts.filter((p) => p.type !== 'text' && p.type !== 'skill' && p.type !== 'file' && p.type !== 'image').length
  const bits = [files && plural(files, 'file'), images && plural(images, 'image'), other && plural(other, 'link')].filter(Boolean)
  return bits.length ? `+${bits.join(', ')}` : ''
}

/** What the tray's first line says. A running turn needs none: the transcript already shows the agent working. */
const WAITING: Partial<Record<QueueReason, string>> = {
  offline: 'Queued. Sends when you are back online.',
  capacity: 'Queued. Sends when an agent slot frees up. Change the limit in Settings, Models and effort.',
  moving: 'Queued. Sends once the chats moving to the new account have re-read their history, two at a time.',
  worktree: 'Queued. Sends when the worktree is ready.',
  paused: 'Queued. Sends when you resume the project.',
  merge: 'Queued. Sends when the work it waits for merges.',
  move: 'Queued. Sends when you choose how this chat moves to another account.',
  limit: 'Close to your usage limit. Sends when it resets or usage drops.'
}

/** Send now can't help while the Mac is offline or the worktree isn't made yet. It does start a brief held for a merge (KERNEL-259). */
export const canSendNow = (why?: QueueReason) => why !== 'offline' && why !== 'worktree'

/**
 * Messages typed while the agent works, or held for another reason (`why`), in a tray above the composer. Only the oldest has Send now, since they go out in order. They go out in
 * order once nothing holds them. Edit one to pull it back into the box.
 */
export function QueueList({ queue, why, held, running, sending, onEdit, onNow, onRemove, setupShown }: {
  queue: QueuedMessage[]
  /** What the queue waits for (KERNEL-273). */
  why?: QueueReason
  /** For `merge`, the PRs still to merge, each opening its workspace. */
  held?: WaitLine
  /** A turn is running, so Send now stops it. */
  running?: boolean
  /** The id of the message whose Send now is in flight. */
  sending?: string | null
  onEdit: (q: QueuedMessage) => void
  onNow: (q: QueuedMessage) => void
  onRemove: (q: QueuedMessage) => void
  /** WorktreeWait is on screen and already shows the messages waiting for the worktree. */
  setupShown?: boolean
}) {
  // WorktreeWait shows the messages waiting for the worktree, with their own Edit and Cancel (KERNEL-430). Without it they show here (KERNEL-1018).
  if (!queue.length || (why === 'worktree' && setupShown)) return null
  const waiting = why ? WAITING[why] : undefined
  const named = why === 'merge' ? held : undefined
  const stops = !!running && !why
  const many = queue.length > 1
  return (
    <div className="queue-tray">
      {(waiting || many) && (
        <div className="queue-head" role="status">
          {waiting && <span className="queue-why">{named ? <NoteText text={named.text} refs={named.refs} /> : waiting}</span>}
          {many && <span className="queue-count">{queue.length} queued</span>}
        </div>
      )}
      <ul className="queue" aria-label="Queued messages">
        {queue.map((q, i) => {
          const text = lineOf(q.parts)
          const more = extras(q.parts)
          return (
            <li key={q.id} className="queue-row">
              <div className="queue-row-in">
                <span className="queue-icon" aria-hidden="true"><Icon name="clock" size={12} /></span>
                <button type="button" className="queue-text" data-tip="Edit this message" onClick={() => onEdit(q)}>
                  <span className="ellipsis">{text || (more ? 'Attachment' : '')}</span>
                </button>
                {more && <span className="queue-extra">{more}</span>}
                {i === 0 && canSendNow(why) && (
                  <Button variant="ghost" className="queue-now" busy={sending === q.id} busyLabel="Sending" disabled={!!sending} data-tip={stops ? 'Stop this turn and send now' : 'Send now'} data-tip-kbd="⌘⇧↵" onClick={() => onNow(q)}>Send now</Button>
                )}
                <button type="button" className="queue-x" aria-label="Remove queued message" onClick={() => onRemove(q)}><Icon name="close" size={12} /></button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
