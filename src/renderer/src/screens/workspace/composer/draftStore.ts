import { EFFORT_LABELS, PERMISSION_MODES, type ChatPart, type Effort, type PermissionMode } from '@shared/types'

/**
 * What a New chat box picked for its chat, a field only once it is picked. A field left out follows the Lead, so a box nobody
 * touched follows Settings, Models and effort as it changes (KERNEL-544). Picks live with the box's draft, in memory and on disk.
 */
export interface DraftPicks { model?: string; effort?: Effort; plan?: boolean; mode?: PermissionMode }

/**
 * Unsent messages by chat id: the parts in the box, text and chips in order, and the workspace the chat belongs to. Module level, so
 * they outlive the composer: switching tabs or leaving the workspace keeps them. They are also written to `kernel.drafts` (KERNEL-201,
 * amending D-100), so a relaunch brings them back. localStorage may be missing or blocked, so every access is guarded.
 * A New chat box's draft also holds its picks, which stay when its text is empty.
 */
interface Draft { workspaceId: string; parts: ChatPart[]; picks?: DraftPicks }
const saved = new Map<string, Draft>()

/** The New chat box's draft. It belongs to no chat or workspace, so it is never pruned, and it goes to disk like a chat's. */
export const NEW_CHAT_DRAFT = 'new-chat'
/** The draft of a room's own New chat box, in the Lead's workspace when the room has no chat (KERNEL-366). Kept per room, so one room's text never shows in another. */
export const newChatDraftOf = (roomId: string) => `${NEW_CHAT_DRAFT}:${roomId}`
const isNewChatDraft = (key: string) => key === NEW_CHAT_DRAFT || key.startsWith(`${NEW_CHAT_DRAFT}:`)
/** Whether a draft can be written to disk: it names its workspace, or it is a New chat box's. */
const lasting = (key: string, workspaceId: string) => !!workspaceId || isNewChatDraft(key)

const KEY = 'kernel.drafts'
/** The write waits this long after the last change, so typing is one write and not one per key. */
const DELAY_MS = 500
/** A draft bigger than this once serialized stays in memory only. */
const MAX_DRAFT_BYTES = 100 * 1024

/** Off in fixture mode, which must not read or write what a real launch saved. */
let enabled = true
export const persistDrafts = (on: boolean) => { enabled = on }
let loaded = false
let dirty = false
let timer: ReturnType<typeof setTimeout> | undefined
let listening = false

/** The picks a file holds, field by field: a value that isn't a model id, an effort or a boolean is dropped. */
function picksOf(v: unknown): DraftPicks | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { model, effort, plan, mode } = v as Record<string, unknown>
  const out: DraftPicks = {}
  if (typeof model === 'string' && model.trim()) out.model = model
  if (typeof effort === 'string' && Object.keys(EFFORT_LABELS).includes(effort)) out.effort = effort as Effort
  if (typeof plan === 'boolean') out.plan = plan
  if (typeof mode === 'string' && PERMISSION_MODES.includes(mode as PermissionMode)) out.mode = mode as PermissionMode
  return Object.keys(out).length ? out : undefined
}

/** The drafts on disk, read once on first use. A value that isn't what this wrote is ignored. */
function load() {
  if (loaded || !enabled) return
  loaded = true
  try {
    const file: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const drafts = (file as { v?: unknown; drafts?: unknown } | null)?.v === 1 ? (file as { drafts: unknown }).drafts : undefined
    if (!drafts || typeof drafts !== 'object') return
    for (const [chatId, d] of Object.entries(drafts as Record<string, Partial<Omit<Draft, 'picks'>> & { picks?: unknown }>)) {
      if (!d || typeof d.workspaceId !== 'string' || !lasting(chatId, d.workspaceId) || !Array.isArray(d.parts)) continue
      const parts = d.parts.filter((p): p is ChatPart => !!p && typeof p === 'object' && typeof p.type === 'string' && p.type !== 'image')
      const picks = picksOf(d.picks)
      if ((parts.length || picks) && !saved.has(chatId)) saved.set(chatId, { workspaceId: d.workspaceId, parts, ...(picks ? { picks } : {}) })
    }
  } catch { /* nothing restored */ }
}

/** Writes the drafts that can be written now. Image chips hold a whole screenshot and are never written. A draft with picks and no parts is still written. */
function flush() {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!dirty || !enabled) return
  dirty = false
  const drafts: Record<string, Draft> = {}
  for (const [chatId, d] of saved) {
    const parts = d.parts.filter((p) => p.type !== 'image')
    if (!lasting(chatId, d.workspaceId) || (!parts.length && !d.picks)) continue
    const draft: Draft = { workspaceId: d.workspaceId, parts, ...(d.picks ? { picks: d.picks } : {}) }
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

/** The parts of a draft, or nothing when it has none: a draft kept only for its picks has no text to bring back. */
export const loadDraft = (chatId: string): ChatPart[] | undefined => { load(); const d = saved.get(chatId); return d?.parts.length ? d.parts : undefined }

/**
 * An empty draft is dropped instead of stored, so a sent message stays gone, unless it has picks, which an empty box keeps.
 * `workspaceId` is the chat's workspace, or empty to keep the draft in memory only.
 */
export function saveDraft(chatId: string, parts: ChatPart[], workspaceId: string) {
  load()
  const picks = saved.get(chatId)?.picks
  if (parts.length || picks) saved.set(chatId, { workspaceId, parts, ...(picks ? { picks } : {}) })
  else saved.delete(chatId)
  schedule()
}

const pickListeners = new Set<() => void>()
/** Calls `fn` when a draft's picks change, for a box that shows them. Returns the way to stop. */
export function onPicksChange(fn: () => void): () => void {
  pickListeners.add(fn)
  return () => { pickListeners.delete(fn) }
}

/** The picks of a box's draft. The same object until they change. */
export const loadPicks = (key: string): DraftPicks | undefined => { load(); return saved.get(key)?.picks }

/** Adds picks to a box's draft, over the ones it has. The text stays. */
export function savePicks(key: string, patch: DraftPicks) {
  load()
  const d = saved.get(key)
  saved.set(key, { workspaceId: d?.workspaceId ?? '', parts: d?.parts ?? [], picks: { ...d?.picks, ...patch } })
  schedule()
  for (const fn of [...pickListeners]) fn()
}

/** A send: the draft goes with its text and its picks, so the box starts from the Lead again. */
export function clearDraft(key: string) {
  load()
  const had = saved.get(key)?.picks
  saved.delete(key)
  schedule()
  if (had) for (const fn of [...pickListeners]) fn()
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
    if (isNewChatDraft(chatId)) continue
    const ws = s.workspaces.find((w) => w.id === d.workspaceId)
    const gone = !ws || ws.status === 'archived' || (chatsLoaded(d.workspaceId) && !(s.chats[d.workspaceId] ?? []).some((c) => c.id === chatId))
    if (gone) { saved.delete(chatId); changed = true }
  }
  if (changed) schedule()
}
