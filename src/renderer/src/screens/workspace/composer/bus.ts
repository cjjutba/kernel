import type { ChatPart } from '@shared/types'

type Listener = (part: ChatPart) => void
const listeners = new Set<Listener>()

/** Put a chip into the open composer from anywhere in the workspace, for example "Send to agent" on a diff hunk. */
export function addToComposer(part: ChatPart) { for (const l of listeners) l(part) }

export function onAddToComposer(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** How long a request to focus a new chat's composer stays good. A chat that never opens must not take focus later. */
const FOCUS_TTL = 5000
let pendingFocus: { chatId: string; at: number } | null = null

/**
 * Ask for the caret in this chat's composer once the chat opens. The composer renders a frame or two after the create
 * call returns, so this is a flag the composer takes when its chat changes, not an event that could arrive too early.
 */
export function focusComposerWhenOpen(chatId: string) { pendingFocus = { chatId, at: Date.now() } }

/** True once for the chat that was asked for, so only a newly created chat takes focus and not every tab switch. */
export function takeComposerFocus(chatId: string) {
  if (!pendingFocus || pendingFocus.chatId !== chatId) return false
  const fresh = Date.now() - pendingFocus.at < FOCUS_TTL
  pendingFocus = null
  return fresh
}

/** What a banner can ask the open composer to do: send (or queue) what is typed, or open the model picker. */
export type ComposerCommand = 'send' | 'model'
const commands = new Set<(c: ComposerCommand) => void>()

export function commandComposer(c: ComposerCommand) { for (const l of commands) l(c) }

export function onComposerCommand(listener: (c: ComposerCommand) => void) {
  commands.add(listener)
  return () => { commands.delete(listener) }
}
