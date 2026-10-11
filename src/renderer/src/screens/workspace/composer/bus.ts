import type { ChatPart } from '@shared/types'

type Listener = (part: ChatPart) => void
const listeners = new Set<Listener>()

/** Put a chip into the open composer from anywhere in the workspace, for example "Send to agent" on a diff hunk. */
export function addToComposer(part: ChatPart) { for (const l of listeners) l(part) }

export function onAddToComposer(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** How long a request to focus a composer stays good. A chat that never opens must not take focus later. */
const FOCUS_TTL = 5000
/** A chat, or whichever chat a workspace opens on. */
type FocusTarget = { chatId: string } | { workspaceId: string }
let pendingFocus: (FocusTarget & { at: number }) | null = null
const focusAsks = new Set<() => void>()

function askFocus(target: FocusTarget) {
  pendingFocus = { ...target, at: Date.now() }
  for (const l of focusAsks) l()
}

/**
 * Ask for the caret in this chat's composer once the chat opens. The composer renders a frame or two after the create
 * call returns, so this is a flag the composer takes when its chat changes, not only an event that could arrive too early.
 */
export function focusComposerWhenOpen(chatId: string) { askFocus({ chatId }) }

/** The same for whichever chat the workspace opens on, for a workspace row in the sidebar. */
export function focusComposerIn(workspaceId: string) { askFocus({ workspaceId }) }

/** True once for the chat that was asked for, so only a new chat or a sidebar row takes focus and not every tab switch. */
export function takeComposerFocus(chat: { id: string; workspaceId: string }) {
  const p = pendingFocus
  if (!p || ('chatId' in p ? p.chatId !== chat.id : p.workspaceId !== chat.workspaceId)) return false
  pendingFocus = null
  return Date.now() - p.at < FOCUS_TTL
}

/** Told on every request, so a composer already showing the chat takes the caret: its chat won't change to make it look. */
export function onComposerFocusAsked(listener: () => void) {
  focusAsks.add(listener)
  return () => { focusAsks.delete(listener) }
}

/** What a banner can ask the open composer to do: send (or queue) what is typed, or open the model picker. */
export type ComposerCommand = 'send' | 'model'
const commands = new Set<(c: ComposerCommand) => void>()

export function commandComposer(c: ComposerCommand) { for (const l of commands) l(c) }

export function onComposerCommand(listener: (c: ComposerCommand) => void) {
  commands.add(listener)
  return () => { commands.delete(listener) }
}
