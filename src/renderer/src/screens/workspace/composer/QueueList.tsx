import type { ChatPart, QueuedMessage, QueueReason } from '@shared/types'
import { Button, Icon } from '../../../ui'

const textOf = (parts: ChatPart[]) => parts.map((p) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : p.name)).join(' ').trim()

/** What the note above the queue says. A running turn needs none: the transcript already shows the agent working. */
const WAITING: Partial<Record<QueueReason, string>> = {
  offline: 'Queued. Sends when you are back online.',
  capacity: 'Queued. Sends when an agent slot frees up. Change the limit in Settings, Models.',
  paused: 'Queued. Sends when you resume the room.',
  setup: 'Queued. Sends when setup passes.'
}

/** Send now can't help while the Mac is offline or setup hasn't passed. */
const canSendNow = (why?: QueueReason) => why !== 'offline' && why !== 'setup'

/** Messages typed while the agent works, or held for another reason (`why`). They go out in order once nothing holds them. Edit one to pull it back into the box. */
export function QueueList({ queue, why, onEdit, onNow, onRemove }: { queue: QueuedMessage[]; /** What the queue waits for (KERNEL-273). */ why?: QueueReason; onEdit: (q: QueuedMessage) => void; onNow: (q: QueuedMessage) => void; onRemove: (q: QueuedMessage) => void }) {
  if (!queue.length) return null
  const waiting = why ? WAITING[why] : undefined
  return (
    <div className="queue">
      {waiting && <div className="note" role="status">{waiting}</div>}
      <ul className="queue" aria-label="Queued messages">
        {queue.map((q) => (
          <li key={q.id} className="queue-row">
            {!waiting && <span className="muted" style={{ fontSize: 12 }}>Queued</span>}
            <button type="button" className="queue-text ellipsis" data-tip="Edit this message" onClick={() => onEdit(q)}>{textOf(q.parts)}</button>
            {canSendNow(why) && <Button className="queue-now" onClick={() => onNow(q)}>Send now</Button>}
            <button type="button" className="queue-x" aria-label="Remove queued message" onClick={() => onRemove(q)}><Icon name="close" size={10} stroke={2} /></button>
          </li>
        ))}
      </ul>
    </div>
  )
}
