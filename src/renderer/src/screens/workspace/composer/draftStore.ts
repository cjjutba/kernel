import type { ChatPart } from '@shared/types'

/** What an unsent message holds: the chips and text added so far, then the text in the live box. */
export interface Saved { segs: ChatPart[]; draft: string }

/** Unsent messages by chat id. Module level, so they outlive the composer: switching tabs or leaving the workspace keeps them. */
const saved = new Map<string, Saved>()

export const loadDraft = (chatId: string): Saved | undefined => saved.get(chatId)

/** An empty draft is dropped instead of stored, so a sent message stays gone. */
export function saveDraft(chatId: string, d: Saved) {
  if (d.segs.length || d.draft) saved.set(chatId, { segs: d.segs, draft: d.draft })
  else saved.delete(chatId)
}
