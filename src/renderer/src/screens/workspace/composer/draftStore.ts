import type { ChatPart } from '@shared/types'

/**
 * Unsent messages by chat id: the parts in the box, text and chips in order. Module level, so they outlive the composer:
 * switching tabs or leaving the workspace keeps them. They last until the app quits and are never written to disk.
 */
const saved = new Map<string, ChatPart[]>()

export const loadDraft = (chatId: string): ChatPart[] | undefined => saved.get(chatId)

/** An empty draft is dropped instead of stored, so a sent message stays gone. */
export function saveDraft(chatId: string, parts: ChatPart[]) {
  if (parts.length) saved.set(chatId, parts)
  else saved.delete(chatId)
}

/** Forgets the drafts of chats that are gone. An image chip holds its whole screenshot, so a stale draft is a real cost. */
export function dropDrafts(chatIds: Iterable<string>) {
  for (const id of chatIds) saved.delete(id)
}

/** Forgets every draft whose chat is not in `live`. Returns whether any draft is left to check. */
export function pruneDrafts(live: ReadonlySet<string>) {
  for (const id of [...saved.keys()]) if (!live.has(id)) saved.delete(id)
  return saved.size > 0
}

/** The ids of the chats a draft can still go back to: those of every workspace that is not archived. */
export function liveChatIds(s: { workspaces: { id: string; status: string }[]; chats: Record<string, { id: string }[]> }): Set<string> {
  const live = new Set<string>()
  for (const w of s.workspaces) if (w.status !== 'archived') for (const c of s.chats[w.id] ?? []) live.add(c.id)
  return live
}
