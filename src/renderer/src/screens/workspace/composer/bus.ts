import type { ChatPart } from '@shared/types'

type Listener = (part: ChatPart) => void
const listeners = new Set<Listener>()

/** Put a chip into the open composer from anywhere in the workspace, for example "Send to agent" on a diff hunk. */
export function addToComposer(part: ChatPart) { for (const l of listeners) l(part) }

export function onAddToComposer(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** What a banner can ask the open composer to do: send (or queue) what is typed, or open the model picker. */
export type ComposerCommand = 'send' | 'model'
const commands = new Set<(c: ComposerCommand) => void>()

export function commandComposer(c: ComposerCommand) { for (const l of commands) l(c) }

export function onComposerCommand(listener: (c: ComposerCommand) => void) {
  commands.add(listener)
  return () => { commands.delete(listener) }
}
