import type { ChatPart, QueuedMessage } from '@shared/types'

/**
 * Whether Escape in the box stops the running turn. It comes last: an open @ or / menu closes first, a picker or a popover closes through its
 * own layer before the key reaches the box, and a chip's popover takes its own Escape. The draft is never touched.
 */
export function escapeStops(s: { running: boolean; stopping: boolean; menuOpen: boolean; autocompleteOpen: boolean }): boolean {
  return s.running && !s.stopping && !s.menuOpen && !s.autocompleteOpen
}

const BREAK: ChatPart = { type: 'text', text: '\n\n' }

/** The box after Stop: what was typed, then each dropped message in the order it was queued, a blank line between them (D-030). */
export function queueBackInBox(draft: ChatPart[], queue: QueuedMessage[]): ChatPart[] {
  return queue.reduce<ChatPart[]>((box, q) => (q.parts.length ? [...box, ...(box.length ? [BREAK] : []), ...q.parts] : box), draft)
}
