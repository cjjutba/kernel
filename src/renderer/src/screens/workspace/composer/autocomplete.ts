import type { BuiltinCommand, Skill } from '@shared/types'

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

type Named = { name: string; description: string; aliases?: string[] }

/** How well a row matches the query: 0 a whole name or alias, 1 the start of one, 2 anywhere in a name or the description, -1 not at all. */
function matchRank(r: Named, q: string): number {
  const names = [r.name, ...(r.aliases ?? [])].map((n) => n.toLowerCase())
  if (names.includes(q)) return 0
  if (names.some((n) => n.startsWith(q))) return 1
  return names.some((n) => n.includes(q)) || r.description.toLowerCase().includes(q) ? 2 : -1
}

/** Rows matching the query, closest first, in list order within each rank. */
function ranked<T extends Named>(rows: T[], query: string, limit: number): T[] {
  const q = query.toLowerCase()
  if (!q) return rows.slice(0, limit)
  return rows.map((r) => ({ r, rank: matchRank(r, q) })).filter((x) => x.rank >= 0).sort((a, b) => a.rank - b.rank).map((x) => x.r).slice(0, limit)
}

/** Skills whose name is, starts with, or contains the query. Closer matches first. */
export function filterSkills(skills: Skill[], query: string, limit = 8): Skill[] {
  return ranked(skills.filter((s) => s.enabled), query, limit)
}

/** A row of the / menu: a skill, or one of Claude Code's own commands. */
export interface SlashRow { name: string; description: string; command: boolean; argumentHint: string; aliases?: string[] }

/**
 * The / menu: skills and Claude Code's own commands, each under its heading, at most 8 rows. The group with the closer
 * match comes first; skills first while nothing is typed (WorkspaceSlash.png). A skill named like a command is left out,
 * because /name runs Claude Code's command.
 */
export function slashMenu(skills: Skill[], commands: BuiltinCommand[], query: string): { label: string; rows: SlashRow[] }[] {
  const taken = new Set(commands.map((c) => c.name))
  const s: SlashRow[] = filterSkills(skills.filter((x) => !taken.has(x.name)), query, 8).map((x) => ({ name: x.name, description: x.description, command: false, argumentHint: '' }))
  const c: SlashRow[] = ranked(commands, query, 8).map((x) => ({ ...x, command: true }))
  const q = query.toLowerCase()
  const best = (rows: SlashRow[]) => (rows.length ? matchRank(rows[0], q) : 3)
  const [first, second] = q && best(c) <= best(s) ? [{ label: 'Commands', rows: c }, { label: 'Skills', rows: s }] : [{ label: 'Skills', rows: s }, { label: 'Commands', rows: c }]
  first.rows = first.rows.slice(0, second.rows.length ? 5 : 8)
  second.rows = second.rows.slice(0, 8 - first.rows.length)
  return [first, second].filter((g) => g.rows.length)
}

/**
 * Enter on a / row sends it at once when nothing more is needed, as in Claude Code: the name was typed in full, or it is a
 * command whose arguments are optional (/clear, /compact). Otherwise the row becomes a chip to type the rest after.
 */
export function runsOnEnter(row: SlashRow, query: string): boolean {
  const q = query.toLowerCase()
  if ([row.name, ...(row.aliases ?? [])].some((n) => n.toLowerCase() === q)) return true
  const hint = row.argumentHint.trim()
  return row.command && (!hint || hint.startsWith('[') || /optional/i.test(hint))
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** The line count a pasted text chip shows, and whether the paste is long enough to become one (over 4 lines or 280 characters). */
export function pasteLines(text: string) { return text.split('\n').length }
export function isLongPaste(text: string) { return text.length > 280 || pasteLines(text) > 4 }
