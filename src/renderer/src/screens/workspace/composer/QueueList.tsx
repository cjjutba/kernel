import type { ChatPart, QueuedMessage } from '@shared/types'
import { Button, Icon } from '../../../ui'

const textOf = (parts: ChatPart[]) => parts.map((p) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : p.name)).join(' ').trim()

/** Messages typed while the agent works. They go out in order when the turn ends. Edit one to pull it back into the box. */
export function QueueList({ queue, onEdit, onNow, onRemove }: { queue: QueuedMessage[]; onEdit: (q: QueuedMessage) => void; onNow: (q: QueuedMessage) => void; onRemove: (q: QueuedMessage) => void }) {
  if (!queue.length) return null
  return (
    <ul className="queue" aria-label="Queued messages">
      {queue.map((q) => (
        <li key={q.id} className="queue-row">
          <span className="muted" style={{ fontSize: 12 }}>Queued</span>
          <button type="button" className="queue-text ellipsis" title="Edit this message" onClick={() => onEdit(q)}>{textOf(q.parts)}</button>
          <Button className="queue-now" onClick={() => onNow(q)}>Send now</Button>
          <button type="button" className="queue-x" aria-label="Remove queued message" onClick={() => onRemove(q)}><Icon name="close" size={10} stroke={2} /></button>
        </li>
      ))}
    </ul>
  )
}
