import type { AppUpdate } from '@shared/types'

/** "0.2.0" reads as "0.2" (WhatsNew.png, Welcome.png). A patch release keeps its number, so 0.2.1 reads as "0.2.1". */
export const short = (v: string) => v.replace(/^(\d+\.\d+)\.0$/, '$1')

const SECTION_ORDER = ['New', 'Improved', 'Fixed'] as const
type SectionTitle = (typeof SECTION_ORDER)[number]

export interface NotesSection {
  title: SectionTitle
  /** Every change in the section. */
  count: number
  /** A new note with a title: the title in bold over its sentence. */
  highlights: { title: string; text: string }[]
  /** Changes without an area. */
  lines: string[]
  /** The lines fold into one "Show N changes" row: a section of notes from before areas, in a release with more than one section. A release with a single short list, such as a patch, lists it open. */
  fold: boolean
  /** One row per area, closed until opened. */
  groups: { area: string; lines: string[] }[]
}

export interface WhatsNewView {
  /** An update that has downloaded or is downloading: Later and Restart to update. Otherwise Done. */
  ready: boolean
  /** The update is still downloading: Restart to update waits, and the footer shows the percentage (Pen 17.4, WhatsNewDownloading). */
  downloading: boolean
  /** The check failed and there are no notes to show: the body says so calmly, and the toast carries the reason (Pen 17.4, WhatsNewCheckFailed). */
  failed: boolean
  /** Opened before Kernel answered `update.get`. */
  loading: boolean
  /** Opened from the sidebar, the account menu or the palette, showing the running version's notes. */
  current: boolean
  title: string
  /** The meta line under the title: from and to versions for an update, and a plain sentence otherwise. */
  from?: string
  to?: string
  note?: string
  sections: NotesSection[]
}

/**
 * Which What's new to show (Pen 17.2, 17.4). Right after an update installs, that version's notes. With an update
 * downloaded or downloading, the new version's notes and the offer to restart. Otherwise, the running version's notes
 * (KERNEL-154): the sidebar, the account menu and the palette open it whatever the updater is doing. A failed check with
 * no notes to show says so calmly.
 */
export function whatsNewView(u: AppUpdate | null | undefined): WhatsNewView {
  const base = { ready: false, downloading: false, failed: false, loading: false, current: false }
  if (!u) return { ...base, loading: true, current: true, title: "What's new", sections: [] }
  if (u.installed && u.version) {
    return { ...base, title: `You're on Kernel ${short(u.version)}`, note: "Installed just now. Your agents picked up where they were.", sections: notesSections(u.notes) }
  }
  if (u.status === 'ready' && u.version) return { ...base, ready: true, title: `Kernel ${short(u.version)} is ready`, from: u.current, to: u.version, sections: notesSections(u.notes) }
  if (u.status === 'downloading' && u.version) {
    return { ...base, ready: true, downloading: true, title: `Kernel ${short(u.version)} is available`, from: u.current, to: u.version, sections: notesSections(u.notes) }
  }
  const sections = notesSections(u.currentNotes)
  if (u.error && u.status === 'error' && sections.length === 0) return { ...base, failed: true, current: true, title: "What's new", sections }
  return { ...base, current: true, title: u.current ? `What's new in ${short(u.current)}` : "What's new", ...(u.current ? { note: `You're on ${u.current}.` } : {}), sections }
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
    if (!s) sections.set(title, (s = { title, count: 0, highlights: [], lines: [], fold: false, groups: [] }))
    return s
  }
  for (const note of notes ?? []) {
    const m = /^(New|Improved|Fixed)(?::\s*(.+))?$/.exec(note.title.trim())
    if (!m) {
      section('New').highlights.push({ title: note.title, text: note.body })
      continue
    }
    const title = m[1] as SectionTitle
    const lines = note.body.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const s = section(title)
    if (m[2]) s.groups.push({ area: m[2], lines })
    else s.lines.push(...lines)
  }
  const ordered = SECTION_ORDER.flatMap((t) => sections.get(t) ?? [])
  return ordered.map((s) => {
    s.count = s.highlights.length + s.lines.length + s.groups.reduce((n, g) => n + g.lines.length, 0)
    s.fold = ordered.length > 1 && s.lines.length > 0 && s.highlights.length === 0 && s.groups.length === 0
    return s
  })
}
