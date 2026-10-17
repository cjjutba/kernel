import type { AppUpdate } from '@shared/types'

/** "0.2.0" reads as "0.2" (WhatsNew.png, Welcome.png). A patch release keeps its number, so 0.2.1 reads as "0.2.1". */
export const short = (v: string) => v.replace(/^(\d+\.\d+)\.0$/, '$1')

/** A section with this many lines or fewer lists them flat, with no area rows. A longer flat list folds after FOLD_AT. */
export const FLAT_MAX = 7
export const FOLD_AT = 5

const SECTION_ORDER = ['New', 'Improved', 'Fixed'] as const
type SectionTitle = (typeof SECTION_ORDER)[number]

export interface NotesSection {
  title: SectionTitle
  /** Every change in the section. */
  count: number
  /** A new note with a title: the title in bold over its sentence. */
  highlights: { title: string; text: string }[]
  /** Changes without an area, listed flat. */
  lines: string[]
  /** One row per area, closed until opened. */
  groups: { area: string; lines: string[] }[]
}

export interface WhatsNewView {
  /** A downloaded update: Later and Restart to update. Otherwise Done. */
  ready: boolean
  /** Opened before Kernel answered `update.get`. */
  loading: boolean
  /** Opened from the sidebar, the account menu or the palette, showing the running version's notes. */
  current: boolean
  title: string
  /** The meta line under the title: from and to versions for a ready update, and a short note otherwise. */
  from?: string
  to?: string
  note?: string
  sections: NotesSection[]
}

/**
 * Which What's new to show. Right after an update installs, that version's notes. With an update downloaded, the new
 * version's notes and the offer to restart (WhatsNew.png). Otherwise, the running version's notes (KERNEL-154): the
 * sidebar, the account menu and the palette open it whatever the updater is doing.
 */
export function whatsNewView(u: AppUpdate | null | undefined): WhatsNewView {
  if (!u) return { ready: false, loading: true, current: true, title: "What's new in Kernel", sections: [] }
  if (u.installed && u.version) return { ready: false, loading: false, current: false, title: `What's new in Kernel ${short(u.version)}`, to: u.version, note: 'Just installed', sections: notesSections(u.notes) }
  if (u.status === 'ready' && u.version) return { ready: true, loading: false, current: false, title: `Kernel ${short(u.version)} is ready`, from: u.current, to: u.version, sections: notesSections(u.notes) }
  return {
    ready: false,
    loading: false,
    current: true,
    title: u.current ? `What's new in Kernel ${short(u.current)}` : "What's new in Kernel",
    ...(u.current ? { to: u.current, note: 'Your version' } : {}),
    sections: notesSections(u.currentNotes)
  }
}

/**
 * The notes `parseNotes` read, back in sections (scripts/notes.ts renderApp). "New", "Improved" and "Fixed" list their
 * changes, "Improved: Chat" lists one area's, and any other title is a new feature with its sentence under it. Notes
 * from before areas existed read the same way, as titled features and flat lists.
 */
export function notesSections(notes: { title: string; body: string }[] | undefined): NotesSection[] {
  const sections = new Map<SectionTitle, NotesSection>()
  const section = (title: SectionTitle) => {
    let s = sections.get(title)
    if (!s) sections.set(title, (s = { title, count: 0, highlights: [], lines: [], groups: [] }))
    return s
  }
  for (const note of notes ?? []) {
    const m = /^(New|Improved|Fixed)(?::\s*(.+))?$/.exec(note.title.trim())
    if (!m) {
      section('New').highlights.push({ title: note.title, text: note.body })
      continue
    }
    const title = m[1] as SectionTitle
    const lines = note.body.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (title === 'Fixed' ? unfix(l) : l))
    if (!lines.length) continue
    const s = section(title)
    if (m[2]) s.groups.push({ area: m[2], lines })
    else s.lines.push(...lines)
  }
  return SECTION_ORDER.flatMap((t) => {
    const s = sections.get(t)
    if (!s) return []
    const grouped = s.groups.reduce((n, g) => n + g.lines.length, 0)
    s.count = s.highlights.length + s.lines.length + grouped
    // A short section isn't worth folding: its areas list flat after the lines without one.
    if (s.lines.length + grouped <= FLAT_MAX) return [{ ...s, lines: [...s.lines, ...s.groups.flatMap((g) => g.lines)], groups: [] }]
    return [s]
  })
}

/** The Fixed heading already says it, so a line drops its leading "Fixed". */
function unfix(line: string): string {
  const rest = line.replace(/^Fixed\s+/, '')
  return rest === line ? line : rest.charAt(0).toUpperCase() + rest.slice(1)
}
