import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { ResolvedFile, ResolvedPath } from '@shared/types'
import { call } from '../../api'
import { actions, getState, go } from '../../store'
import { diffTab, fileTab } from './ChatTabs'
import type { Block } from './mdParse'

// ---------- Which workspace a message belongs to

/** The workspace of the agent that wrote the text below, or null where file mentions don't link (issues, History). */
export const FileLinkScope = createContext<string | null>(null)

/** What a message's mentions resolved to, by the text as the agent wrote it. Absent while unresolved. */
export interface FileLinks { workspaceId: string; found: ReadonlyMap<string, ResolvedPath> }

// ---------- Finding mentions in text

const PATH = /^(?:~\/|\/|\.\.?\/)?[\w@.+\-/]+(?:(?::\d+(?:-\d+)?)|(?:#L\d+(?:-L\d+)?))?$/
const VERSION = /^v?\d+(?:\.\d+)+(?:[-+][\w.]+)?$/
const SUFFIX = /(?::\d+(?:-\d+)?|#L\d+(?:-L\d+)?)$/
/** The most mentions one message sends to be resolved. */
const MAX_MENTIONS = 40

/** Whether `raw` could be a file or folder: a slash or an extension, and not a version number or a link. */
export function looksLikePath(raw: string): boolean {
  if (raw.length < 2 || raw.length > 300 || raw.includes('://') || !PATH.test(raw)) return false
  const bare = raw.replace(SUFFIX, '')
  if (VERSION.test(bare) || /^[\d./-]+$/.test(bare)) return false
  return bare.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(bare)
}

/** A word of plain text without the punctuation around it, with where the path starts and ends in the word. */
const WORD = /\S+/g
const LEAD = /^[([{"'<]+/
const TRAIL = /[.,;:!?)\]}"'>]+$/
export function wordCore(word: string): { start: number; end: number; raw: string } {
  const start = LEAD.exec(word)?.[0].length ?? 0
  const rest = word.slice(start)
  const end = start + rest.length - (TRAIL.exec(rest)?.[0].length ?? 0)
  return { start, end, raw: word.slice(start, end) }
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

/** The mentions in one piece of inline markdown: inline code, and plain words outside bold, italic and links. */
export function mentionsIn(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(INLINE)) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) { const raw = part.slice(1, -1).trim(); if (looksLikePath(raw)) out.push(raw) }
    else if (!/^(\*|\[)/.test(part)) for (const m of part.matchAll(WORD)) { const { raw } = wordCore(m[0]); if (looksLikePath(raw)) out.push(raw) }
  }
  return out
}

/** The inline texts of parsed blocks. Fenced code is left out: it never links. */
export function blockTexts(blocks: Block[]): string[] {
  return blocks.flatMap((b): string[] => {
    switch (b.type) {
      case 'p': case 'h': return [b.text]
      case 'ul': case 'ol': return b.items.flatMap((i) => [i.text, ...blockTexts(i.children)])
      case 'quote': return blockTexts(b.blocks)
      case 'table': return [...b.head, ...b.rows.flat()]
      default: return []
    }
  })
}

/** The line and range a mention names: `path:12`, `path:12-30`, `path#L12-L30`. */
export function lineOf(raw: string): { line?: number; endLine?: number } {
  const m = /(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L(\d+))?)$/.exec(raw)
  if (!m) return {}
  const line = Number(m[1] ?? m[3])
  const end = m[2] ?? m[4]
  return { line, ...(end && Number(end) > line && { endLine: Number(end) }) }
}

// ---------- Resolving

/** Hits kept for the session, so a message that scrolls away and back doesn't ask again. A miss isn't kept: the file may come later in the turn. */
const kept = new Map<string, ResolvedPath>()
const keptKey = (workspaceId: string, raw: string) => `${workspaceId}\0${raw}`
const KEPT_MAX = 2000

/**
 * Resolves the mentions in `texts` once the element behind `ref` has been on screen, in one call. The answers are kept for the
 * session, and the call is made again only when the mentions change (a reply still streaming).
 */
export function useFileLinks(workspaceId: string | null, texts: string[], ref: RefObject<Element | null>): FileLinks | undefined {
  const mentions = useMemo(() => [...new Set(texts.flatMap(mentionsIn))].slice(0, MAX_MENTIONS), [texts.join('\n')])
  const key = mentions.join('\n')
  const [seen, setSeen] = useState(false)
  const [version, bump] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (seen || !mentions.length || !el) return
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return }
    const watch = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setSeen(true); watch.disconnect() } })
    watch.observe(el)
    return () => watch.disconnect()
  }, [seen, key])
  useEffect(() => {
    if (!workspaceId || !seen) return
    const todo = mentions.filter((m) => !kept.has(keptKey(workspaceId, m)))
    if (!todo.length) return
    let live = true
    call('workspaces.resolvePaths', { workspaceId, paths: todo }).then((found) => {
      for (const [raw, r] of Object.entries(found)) if (r) { kept.set(keptKey(workspaceId, raw), r); if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value as string) }
      if (live) bump((n) => n + 1)
    }).catch(() => undefined)
    return () => { live = false }
  }, [workspaceId, seen, key])
  return useMemo(() => {
    if (!workspaceId || !seen) return undefined
    const found = new Map<string, ResolvedPath>()
    for (const m of mentions) { const r = kept.get(keptKey(workspaceId, m)); if (r) found.set(m, r) }
    return found.size ? { workspaceId, found } : undefined
  }, [workspaceId, seen, key, version])
}

// ---------- Line and folder focus

export interface LineRange { start: number; end: number; n: number }
const lines = new Map<string, LineRange>()
const folders = new Map<string, { path: string; n: number }>()
const listeners = new Set<() => void>()
let seq = 0
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
const emit = () => listeners.forEach((f) => f())

/** Asks the file tab of `path` to scroll to the lines and mark them. */
export function focusLines(workspaceId: string, path: string, line: number, endLine?: number) {
  lines.set(`${workspaceId}\0${path}`, { start: line, end: Math.max(line, endLine ?? line), n: ++seq })
  emit()
}
/** The range the last link to `path` named, if any. */
export function useLineFocus(workspaceId: string, path: string): LineRange | undefined {
  return useSyncExternalStore(subscribe, () => lines.get(`${workspaceId}\0${path}`))
}

/** Asks the Files panel to open `path`, a folder, and scroll to it. */
export function focusFolder(workspaceId: string, path: string) {
  folders.set(workspaceId, { path, n: ++seq })
  emit()
}
export function useFolderFocus(workspaceId: string) {
  return useSyncExternalStore(subscribe, () => folders.get(workspaceId))
}

// ---------- Opening

/** Brings the workspace on screen, whichever one the click came from. */
function show(workspaceId: string) {
  const { route } = getState().ui
  if (route.name !== 'workspace' || route.workspaceId !== workspaceId) go({ name: 'workspace', workspaceId })
}

/** Whether the mention still points at something, since an answer kept from earlier may be of a file that has gone. Resolving the path doesn't read the file, so a binary or large one passes. */
async function stillThere(workspaceId: string, r: ResolvedFile): Promise<boolean> {
  try { return !!(await call('workspaces.resolvePaths', { workspaceId, paths: [r.path] }))[r.path] } catch { return false }
}

/** Opens what a mention resolved to: a file or picture in a tab of the workspace, a folder in the Files panel, or with `diff` the file's diff when it changed. */
export async function openMention(workspaceId: string, r: ResolvedFile, o: { diff?: boolean } = {}): Promise<void> {
  if (!(await stillThere(workspaceId, r))) { actions.ui.toast({ title: 'This file no longer exists' }); return }
  show(workspaceId)
  if (r.kind === 'dir') {
    actions.ui.setRightPanel(true)
    actions.ui.setWorkspaceView({ right: 'files', leadRight: 'files' })
    focusFolder(workspaceId, r.path.replace(/\/$/, ''))
    return
  }
  if (o.diff) {
    const changed = await call('workspaces.changes', { workspaceId }).catch(() => [])
    if (changed.some((c) => c.path === r.path)) { actions.ui.openTab(workspaceId, diffTab(r.path)); return }
  }
  if (r.line) focusLines(workspaceId, r.path, r.line, r.endLine)
  actions.ui.openTab(workspaceId, fileTab(r.path))
}

/** A bare name's match picked from the menu, resolved on its own so its sensitive flag and line come with it. Null when it is gone. */
export async function resolveMatch(workspaceId: string, path: string, raw: string): Promise<ResolvedFile | null> {
  // `./` anchors it to the worktree: a file at the root has no slash, and the engine would read it as a bare name and list the matches again.
  const asked = `./${path}${SUFFIX.exec(raw)?.[0] ?? ''}`
  const r = (await call('workspaces.resolvePaths', { workspaceId, paths: [asked] }).catch(() => ({} as Record<string, ResolvedPath>)))[asked]
  return r && !('matches' in r) ? r : null
}

/** The accessible name of a link. */
export function linkLabel(r: ResolvedPath, raw: string): string {
  if (!r) return raw
  if ('matches' in r) return `Choose a file named ${raw}`
  if (r.kind === 'dir') return `Open folder ${r.path}`
  return `Open ${r.path}${r.line ? ` at line ${r.line}` : ''}`
}
