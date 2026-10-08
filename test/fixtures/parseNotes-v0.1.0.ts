// parseNotes exactly as it shipped in Kernel 0.1.0, copied from `git show v0.1.0:src/main/updater.ts`. Installed
// 0.1.0 copies run this on the notes of their first update, and save what it returns for What's new after the
// restart. test/releaseNotes.test.ts runs the app notes from scripts/notes.ts through it. Don't edit it.

type Note = { title: string; body: string }
type UpdateInfo = { version: string; releaseNotes?: string | { version: string; note: string | null }[] | null }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/**
 * Release notes to What's new items. Each `###` heading (or `<h3>`, since the GitHub feed sends HTML) is a title,
 * and the text under it until the next heading is the body. Text before the first heading is dropped.
 */
export function parseNotes(raw: UpdateInfo['releaseNotes']): Note[] {
  if (!raw) return []
  const text = Array.isArray(raw) ? raw.map((r) => r.note ?? '').join('\n') : raw
  const md = text
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n### $1\n')
    .replace(/<br\s*\/?>|<\/(p|li|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? m)
  const notes: Note[] = []
  for (const line of md.split('\n').map((l) => l.trim())) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) notes.push({ title: heading[1].trim(), body: '' })
    else if (line && notes.length) {
      const n = notes[notes.length - 1]
      n.body = n.body ? `${n.body} ${line.replace(/^[-*]\s+/, '')}` : line.replace(/^[-*]\s+/, '')
    }
  }
  return notes.filter((n) => n.title)
}
