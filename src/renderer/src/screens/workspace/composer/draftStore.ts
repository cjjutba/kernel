import type { ChatPart } from '@shared/types'

/** Unsent messages by chat id: the parts in the box, text and chips in order. Module level, so they outlive the composer: switching tabs or leaving the workspace keeps them. */
const saved = new Map<string, ChatPart[]>()

export const loadDraft = (chatId: string): ChatPart[] | undefined => saved.get(chatId)

/** An empty draft is dropped instead of stored, so a sent message stays gone. */
export function saveDraft(chatId: string, parts: ChatPart[]) {
  if (parts.length) saved.set(chatId, parts)
  else saved.delete(chatId)
}
