import type { ChatPart } from '@shared/types'

type Listener = (part: ChatPart) => void
const listeners = new Set<Listener>()

/** Put a chip into the open composer from anywhere in the workspace, for example "Send to agent" on a diff hunk. */
export function addToComposer(part: ChatPart) { for (const l of listeners) l(part) }

export function onAddToComposer(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
