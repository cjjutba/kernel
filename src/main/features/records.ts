import type { Chat, ChatItem, Effort, Provider, NoteRef, Workspace } from '@shared/types'
import { newId, type Store } from '../db'
import { bus } from '../bus'
import { LEAD_CHAT, NEW_CHAT, NEW_TAB } from './shared'

// Kernel's reads and writes of rooms, workspaces and chats, as plain functions of the Store and the bus (KERNEL-325).
// Kernel keeps a one-line method for each, and `Feature` a protected one, so a feature calls them without importing Kernel.

export function mustRoom(store: Store, id: string) { const r = store.room(id); if (!r) throw new Error(`Unknown room ${id}`); return r }
export function mustWs(store: Store, id: string) { const w = store.workspace(id); if (!w) throw new Error(`Unknown workspace ${id}`); return w }

export function mustChat(store: Store, chatId: string): Chat {
  const c = store.chat(chatId)
  if (!c) throw new Error('That chat no longer exists.')
  return c
}

export function chatTabs(store: Store, workspaceId: string): Chat[] { return store.chats(workspaceId).filter((c) => !c.closed) }

export function saveWs(store: Store, ws: Workspace) { store.saveWorkspace(ws); bus.push({ type: 'workspace', workspace: ws }); return ws }

/**
 * Saves a change to the workspace as it is in the store now, never a copy read before an await, which would put back
 * whatever changed meanwhile (KERNEL-70). An archived workspace only changes through archive and restore, so a slow
 * PR refresh or setup that finishes late leaves it archived. A key set to undefined is dropped when it is stored.
 */
export function updateWs(store: Store, id: string, patch: Partial<Workspace>, o: { archived?: boolean } = {}): Workspace {
  const cur = mustWs(store, id)
  if (cur.status === 'archived' && !o.archived) return cur
  return saveWs(store, { ...cur, ...patch })
}

export function saveChat(store: Store, chat: Chat): Chat {
  store.saveChat(chat)
  bus.push({ type: 'chat', chat })
  return chat
}

/**
 * A chat opened with a placeholder name ("New chat", "New tab", the Lead's "Lead") is auto-named. A workspace's title or a
 * fork's is not (KERNEL-202). `threadId` puts a Lead tab in its Lead chat (KERNEL-337).
 */
export function newChat(store: Store, workspaceId: string, title: string, o: { provider?: Provider; model: string; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal'; terminal?: Chat['terminal']; threadId?: string }): Chat {
  const kind = o.kind ?? 'chat'
  const auto = kind === 'chat' && (title === NEW_CHAT || title === NEW_TAB || title === LEAD_CHAT)
  return store.saveChat({ id: newId(), workspaceId, title, kind, ...(o.provider && o.provider !== 'claude' ? { provider: o.provider } : {}), model: o.model, effort: o.effort, plan: o.plan, ...(o.terminal ? { terminal: o.terminal } : {}), ...(auto ? { autoTitle: { turns: 0 } } : {}), ...(o.threadId ? { threadId: o.threadId } : {}), createdAt: Date.now() })
}

/** PR instructions and notes go to the workspace's first chat. */
export function prChat(store: Store, id: string): Chat | undefined {
  const chats = chatTabs(store, id)
  return chats.find((c) => c.kind !== 'terminal') ?? chats[0]
}

/** `pr` is the PR state the note is about, which draws that state's icon before the text. `refs` are words in it that open a workspace. */
export function note(store: Store, workspaceId: string, text: string, pr?: 'merged' | 'closed' | 'cifail', refs?: NoteRef[]) {
  const chat = prChat(store, workspaceId)
  if (!chat) return
  const item: ChatItem = { kind: 'note', id: newId(), ts: Date.now(), text, ...(pr ? { pr } : {}), ...(refs?.length ? { refs } : {}) }
  store.saveItem(chat.id, item)
  bus.push({ type: 'chat.item', chatId: chat.id, item })
}
