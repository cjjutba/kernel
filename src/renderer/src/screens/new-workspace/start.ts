import type { ChatPart, Effort, HeldChat, LeadMode, PermissionMode } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, loadWorkspace } from '../../store'
import { openLeadChat, openNewChat } from '../../lead'
import { focusComposerWhenOpen } from '../workspace/composer/bus'
import { clearDraft, loadPicks, newChatDraftOf } from '../workspace/composer/draftStore'
import { briefParts, leadMessage } from './brief'
import { startAnywayLine } from './taken'

export interface ChatStart {
  roomId: string
  parts: ChatPart[]
  model: string
  effort: Effort
  plan: boolean
  /** The permission mode the box picked, left out while it follows the room or Settings. */
  mode?: PermissionMode
  /** The target branch picked, empty for the room's default. */
  baseRef: string
  /** Hand off or Build here, left out while it follows the room or Settings. */
  leadMode?: LeadMode
}

/**
 * Starts a chat with the room's Lead, sends the brief there and lands on it as soon as the engine answers, before its worktree
 * exists (KERNEL-542). Resolves with why it couldn't send, and nothing once it has. The room's box keeps its draft until a send
 * succeeds. The new chat opens with its right panel closed, whatever the global setting says, until the toggle is pressed there (KERNEL-788).
 */
export async function startChat(c: ChatStart): Promise<string | undefined> {
  let chat
  // The chat's own worktree starts from the target branch picked here, else the latest default branch (KERNEL-405).
  try { chat = await call('lead.start', { roomId: c.roomId, ...leadMessage(c.parts), model: c.model, effort: c.effort, plan: c.plan, ...(c.mode ? { mode: c.mode } : {}), ...(c.baseRef ? { baseRef: c.baseRef } : {}), ...(c.leadMode ? { leadMode: c.leadMode } : {}) }) }
  catch (e) { return cleanError(e) }
  clearDraft(newChatDraftOf(c.roomId))
  // The message is sent. Landing on it is best effort, since the engine pushes the same workspace and chat.
  try { await loadWorkspace(chat.workspaceId) } catch { /* the push brings it */ }
  // The engine answered before the worktree exists and pushes the workspace, so the chat opens now and says what it waits for.
  actions.chats.upsert(chat)
  actions.ui.holdPanel(chat.workspaceId)
  focusComposerWhenOpen(chat.id)
  // The workspace screen clears the tab when the workspace changes, so the tab is set after the navigation (lead.ts).
  await openLeadChat(c.roomId, chat.id)
}

/**
 * New chat again after the issue warning's Cancel. The page it came from is still under the warning with its words, chip and picks, so
 * closing the warning is enough. Had the user gone elsewhere meanwhile, the page opens with the source and picks it had. Nothing was sent.
 */
export function backToNewChat(h: HeldChat) {
  const { route } = getState().ui
  if (route.name === 'leadNew' && route.roomId === h.roomId) actions.ui.closeModal()
  else openNewChat(h.roomId, { source: h.source, picks: h.picks })
}

/**
 * Start anyway on the issue warning. The Lead is told the user knows, so it passes confirm when it hands the issue off. A chat
 * that can't be sent goes back to New chat with the reason, since the warning has nowhere to show it.
 */
export async function startHeld(h: HeldChat): Promise<void> {
  const { model, effort, plan, baseRef, leadMode } = h.picks
  const issue = h.source.kind === 'issue' ? h.source.id : ''
  const mode = loadPicks(newChatDraftOf(h.roomId))?.mode
  const failed = await startChat({ roomId: h.roomId, parts: issue ? briefParts(h.parts, null, [startAnywayLine(issue)]) : h.parts, model, effort, plan, mode, baseRef, leadMode })
  if (!failed) return
  backToNewChat(h)
  actions.ui.toast({ title: failed })
}
