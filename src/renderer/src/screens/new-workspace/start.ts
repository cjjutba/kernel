import type { ChatPart, Effort, HeldChat } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions } from '../../store'
import { openLeadChat } from '../../lead'
import { focusComposerWhenOpen } from '../workspace/composer/bus'
import { clearDraft, NEW_CHAT_DRAFT } from '../workspace/composer/draftStore'
import { briefParts, leadMessage } from './brief'
import { startAnywayLine } from './taken'

export interface ChatStart {
  roomId: string
  parts: ChatPart[]
  model: string
  effort: Effort
  plan: boolean
  /** The target branch picked, empty for the room's default. */
  baseRef: string
}

/**
 * Opens a new chat with the room's Lead, sends the brief there and lands on it as soon as the engine answers, before its worktree
 * exists (KERNEL-542). Resolves with why it couldn't send, and nothing once it has. The box keeps its draft until a send succeeds.
 */
export async function startChat(c: ChatStart): Promise<string | undefined> {
  let chat
  // The chat's own worktree starts from the target branch picked here, else the latest default branch (KERNEL-405).
  try { chat = await call('lead.start', { roomId: c.roomId, ...leadMessage(c.parts), model: c.model, effort: c.effort, plan: c.plan, ...(c.baseRef ? { baseRef: c.baseRef } : {}) }) }
  catch (e) { return cleanError(e) }
  clearDraft(NEW_CHAT_DRAFT)
  // The engine answered before the worktree exists and pushes the workspace, so the chat opens now and says what it waits for.
  actions.chats.upsert(chat)
  // The dialog hands focus back to its trigger as it closes, so the composer takes it a frame later.
  focusComposerWhenOpen(chat.id)
  actions.ui.closeModal()
  // The workspace screen clears the tab when the workspace changes, so the tab is set after the navigation (lead.ts).
  await openLeadChat(c.roomId, chat.id)
}

/** New chat again, with the words, source and picks it had when the issue warning stopped it. Nothing was sent. */
export const backToNewChat = (h: HeldChat) => actions.ui.openModal({ name: 'newWorkspace', roomId: h.roomId, source: h.source, picks: h.picks })

/**
 * Start anyway on the issue warning. The Lead is told the user knows, so it passes confirm when it hands the issue off. A chat
 * that can't be sent goes back to New chat with the reason, since the warning has nowhere to show it.
 */
export async function startHeld(h: HeldChat): Promise<void> {
  const { model, effort, plan, baseRef } = h.picks
  const issue = h.source.kind === 'issue' ? h.source.id : ''
  const failed = await startChat({ roomId: h.roomId, parts: issue ? briefParts(h.parts, null, [startAnywayLine(issue)]) : h.parts, model, effort, plan, baseRef })
  if (!failed) return
  backToNewChat(h)
  actions.ui.toast({ title: failed })
}
