import type { ChatPart } from '@shared/types'

/**
 * Unsent messages by chat id: the parts in the box, text and chips in order, and the workspace the chat belongs to. Module level, so
 * they outlive the composer: switching tabs or leaving the workspace keeps them. They are also written to `kernel.drafts` (KERNEL-201,
 * amending D-100), so a relaunch brings them back. localStorage may be missing or blocked, so every access is guarded.
 */
interface Draft { workspaceId: string; parts: ChatPart[] }
const saved = new Map<string, Draft>()

const KEY = 'kernel.drafts'
/** The write waits this long after the last change, so typing is one write and not one per key. */
const DELAY_MS = 500
/** A draft bigger than this once serialized stays in memory only. */
const MAX_DRAFT_BYTES = 100 * 1024

let loaded = false
let dirty = false
let timer: ReturnType<typeof setTimeout> | undefined
let listening = false

/** The drafts on disk, read once on first use. A value that isn't what this wrote is ignored. */
function load() {
  if (loaded) return
  loaded = true
  try {
    const file: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const drafts = (file as { v?: unknown; drafts?: unknown } | null)?.v === 1 ? (file as { drafts: unknown }).drafts : undefined
    if (!drafts || typeof drafts !== 'object') return
    for (const [chatId, d] of Object.entries(drafts as Record<string, Partial<Draft>>)) {
      if (!d || typeof d.workspaceId !== 'string' || !d.workspaceId || !Array.isArray(d.parts)) continue
      const parts = d.parts.filter((p): p is ChatPart => !!p && typeof p === 'object' && typeof p.type === 'string' && p.type !== 'image')
      if (parts.length && !saved.has(chatId)) saved.set(chatId, { workspaceId: d.workspaceId, parts })
    }
  } catch { /* nothing restored */ }
}

/** Writes the drafts that can be written now. Image chips hold a whole screenshot and are never written. */
function flush() {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!dirty) return
  dirty = false
  const drafts: Record<string, Draft> = {}
  for (const [chatId, d] of saved) {
    const parts = d.parts.filter((p) => p.type !== 'image')
    if (!d.workspaceId || !parts.length) continue
    const draft = { workspaceId: d.workspaceId, parts }
    if (JSON.stringify(draft).length > MAX_DRAFT_BYTES) continue
    drafts[chatId] = draft
  }
  try {
    if (Object.keys(drafts).length) localStorage.setItem(KEY, JSON.stringify({ v: 1, drafts }))
    else localStorage.removeItem(KEY)
  } catch {
    // Over the quota: the drafts stay in memory. The older copy goes, or a message sent since would come back after a restart.
    try { localStorage.removeItem(KEY) } catch { /* nothing to remove */ }
  }
}

function schedule() {
  dirty = true
  if (!listening && typeof window !== 'undefined') {
    listening = true
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, DELAY_MS)
}

export const loadDraft = (chatId: string): ChatPart[] | undefined => { load(); return saved.get(chatId)?.parts }

/** An empty draft is dropped instead of stored, so a sent message stays gone. `workspaceId` is the chat's workspace, or empty to keep the draft in memory only. */
export function saveDraft(chatId: string, parts: ChatPart[], workspaceId: string) {
  load()
  if (parts.length) saved.set(chatId, { workspaceId, parts })
  else saved.delete(chatId)
  schedule()
}

/** Forgets the drafts of chats that are gone, and their saved copy. An image chip holds its whole screenshot, so a stale draft is a real cost. */
export function dropDrafts(chatIds: Iterable<string>) {
  load()
  for (const id of chatIds) saved.delete(id)
  schedule()
}

/**
 * Forgets the drafts that can't go back to a chat: those of a workspace that is gone or archived, and those of a chat that is not in its
 * workspace's chat list once that list has loaded. A workspace that has not loaded its chats keeps its drafts, since nothing says a chat
 * is gone: after a launch only the workspaces you open have loaded.
 */
export function pruneDrafts(s: { workspaces: { id: string; status: string }[]; chats: Record<string, { id: string }[]> }, chatsLoaded: (workspaceId: string) => boolean) {
  load()
  let changed = false
  for (const [chatId, d] of [...saved]) {
    const ws = s.workspaces.find((w) => w.id === d.workspaceId)
    const gone = !ws || ws.status === 'archived' || (chatsLoaded(d.workspaceId) && !(s.chats[d.workspaceId] ?? []).some((c) => c.id === chatId))
    if (gone) { saved.delete(chatId); changed = true }
  }
  if (changed) schedule()
}
