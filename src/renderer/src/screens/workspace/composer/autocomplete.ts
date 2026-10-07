import type { Skill } from '@shared/types'

/** The @ word at the end of the draft, if the caret is in one. */
export function mentionAt(draft: string): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(draft)
  return m ? { start: draft.length - m[2].length - 1, query: m[2] } : null
}

/** A / at the very start of the message: only the first word of a message can be a skill. */
export function slashAt(draft: string, hasEarlier: boolean): { query: string } | null {
  if (hasEarlier) return null
  const m = /^\/([^\s/]*)$/.exec(draft)
  return m ? { query: m[1] } : null
}

/** Skills whose name starts with, or contains, the query. Prefix matches first. */
export function filterSkills(skills: Skill[], query: string, limit = 8): Skill[] {
  const q = query.toLowerCase()
  const enabled = skills.filter((s) => s.enabled)
  if (!q) return enabled.slice(0, limit)
  const starts = enabled.filter((s) => s.name.toLowerCase().startsWith(q))
  const has = enabled.filter((s) => !starts.includes(s) && (s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)))
  return [...starts, ...has].slice(0, limit)
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** The line count a pasted text chip shows, and whether the paste is long enough to become one (over 4 lines or 280 characters). */
export function pasteLines(text: string) { return text.split('\n').length }
export function isLongPaste(text: string) { return text.length > 280 || pasteLines(text) > 4 }
