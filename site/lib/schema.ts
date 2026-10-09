import { z } from 'zod'

// Shared with the release scripts at the repo root (scripts/notes.ts), which run this file with Node's type
// stripping. Keep zod as its only import, with no relative imports, enums or namespaces (D-058).

export const ChangeItem = z.object({
  /** Bold lead in, such as "Checkpoints." */
  lead: z.string().optional(),
  text: z.string(),
  pr: z.number().int().positive().optional()
})

export const Section = z.object({ title: z.string().min(1), items: z.array(ChangeItem).min(1) })

/** The title a compiled minor release starts with. The schema refuses it, so a release can't ship until it's written. */
export const PLACEHOLDER_TITLE = 'TITLE: write me'

export const Release = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().min(1).refine((t) => t !== PLACEHOLDER_TITLE, `write a title instead of "${PLACEHOLDER_TITLE}"`),
  image: z.object({ src: z.string(), alt: z.string() }).optional(),
  intro: z.string().optional(),
  sections: z.array(Section).min(1)
})

/** A minor release on the changelog page, with its patch releases (oldest first) shown as "New in x.y.z". */
export const ChangelogEntry = Release.extend({ patches: z.array(Release) })

export const UpNext = z.object({ title: z.string(), intro: z.string(), items: z.array(ChangeItem) })

export const Changelog = z.object({ releases: z.array(ChangelogEntry).min(1), upNext: UpNext })

export type ChangeItem = z.infer<typeof ChangeItem>
export type Section = z.infer<typeof Section>
export type Release = z.infer<typeof Release>
export type ChangelogEntry = z.infer<typeof ChangelogEntry>
export type UpNext = z.infer<typeof UpNext>

// Release files: site/content/releases/<version>.md. Frontmatter, then "## Section" headings with "- item" bullets.

const ReleaseFrontmatter = z.strictObject({
  version: z.string(),
  date: z.string(),
  title: z.string(),
  image: z.string().optional(),
  imageAlt: z.string().optional(),
  intro: z.string().optional()
})

/** Zod issues as "field: message" lines. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
}

/**
 * Splits `---` frontmatter from the body. The frontmatter is a flat subset of YAML: one `key: value` per line, with
 * the value in double quotes when it contains `: ` or starts with a quote. `bodyLine` is the body's first line number.
 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string; bodyLine: number } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') throw new Error('the file must start with a --- line')
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new Error('the frontmatter has no closing --- line')
  const data: Record<string, string> = {}
  for (const [i, line] of lines.slice(1, end).entries()) {
    if (!line.trim()) continue
    const kv = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(line)
    if (!kv) throw new Error(`line ${i + 2}: "${line}" is not "key: value"`)
    const key = kv[1]!
    const raw = (kv[2] ?? '').trim()
    if (key in data) throw new Error(`line ${i + 2}: "${key}" appears twice`)
    try {
      data[key] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
    } catch {
      throw new Error(`line ${i + 2}: the quoted value of "${key}" doesn't close`)
    }
  }
  return { data, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 }
}

/** A frontmatter value, quoted when the flat parser (or a YAML reader) would misread it. */
export function frontmatterValue(value: string): string {
  return /^[\s"'#[\]{}&*!|>%@`-]|: | #|:$|\s$|\n/.test(value) || value === '' ? JSON.stringify(value) : value
}

function parseItem(raw: string): ChangeItem {
  const m = /^(?:\*\*(.+?)\*\*\s+)?(.+?)(?:\s+\(#(\d+)\))?$/.exec(raw.trim())!
  return { ...(m[1] ? { lead: m[1] } : {}), text: m[2]!, ...(m[3] ? { pr: Number(m[3]) } : {}) }
}

/** "## Section" headings with "- item" bullets. An item is an optional **lead**, the text and an optional (#NN). */
export function parseSections(body: string, firstLine = 1): Section[] {
  const sections: Section[] = []
  for (const [i, line] of body.split('\n').entries()) {
    if (!line.trim()) continue
    const heading = /^## (.+)$/.exec(line)
    const item = /^- (.+)$/.exec(line)
    if (heading) sections.push({ title: heading[1]!.trim(), items: [] })
    else if (item && sections.length) sections[sections.length - 1]!.items.push(parseItem(item[1]!))
    else throw new Error(`line ${firstLine + i}: expected "## Section" or "- item", got "${line}"`)
  }
  return sections
}

/** Reads a release file. Throws with every problem found. */
export function parseReleaseFile(text: string): Release {
  const { data, body, bodyLine } = parseFrontmatter(text)
  const fm = ReleaseFrontmatter.safeParse(data)
  if (!fm.success) throw new Error(describeIssues(fm.error).join('\n'))
  const { image, imageAlt, ...rest } = fm.data
  if (!image !== !imageAlt) throw new Error('image and imageAlt go together')
  const release = Release.safeParse({
    ...rest,
    ...(image && imageAlt ? { image: { src: image, alt: imageAlt } } : {}),
    sections: parseSections(body, bodyLine)
  })
  if (!release.success) throw new Error(describeIssues(release.error).join('\n'))
  return release.data
}

function formatItem(item: ChangeItem): string {
  return `- ${item.lead ? `**${item.lead}** ` : ''}${item.text}${item.pr ? ` (#${item.pr})` : ''}`
}

/** Writes a release file that `parseReleaseFile` reads back as the same release. */
export function formatReleaseFile(release: Release): string {
  const fm = [`version: ${release.version}`, `date: ${release.date}`, `title: ${frontmatterValue(release.title)}`]
  if (release.image) fm.push(`image: ${frontmatterValue(release.image.src)}`, `imageAlt: ${frontmatterValue(release.image.alt)}`)
  if (release.intro) fm.push(`intro: ${frontmatterValue(release.intro)}`)
  const sections = release.sections.map((s) => `## ${s.title}\n\n${s.items.map(formatItem).join('\n')}\n`)
  return `---\n${fm.join('\n')}\n---\n\n${sections.join('\n')}`
}

/** Compares x.y.z versions: negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [a.split('.').map(Number), b.split('.').map(Number)]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** True for x.y.z with z above 0. A patch shows inside its x.y.0 entry on the changelog. */
export function isPatch(version: string): boolean {
  return Number(version.split('.')[2]) > 0
}
