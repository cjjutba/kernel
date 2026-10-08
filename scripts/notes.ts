// Release notes from fragments (KERNEL-66, D-058). Every PR that changes the app adds a one-sentence fragment in
// .changes/unreleased/. A release compiles them into site/content/releases/<version>.md, the one file behind the
// website changelog, the GitHub release body and What's new. Rules for writing them: .changes/README.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  compareVersions,
  describeIssues,
  formatReleaseFile,
  isPatch,
  parseFrontmatter,
  parseReleaseFile,
  PLACEHOLDER_TITLE,
  type ChangeItem,
  type Release
} from '../site/lib/schema.ts'

export const README_URL = 'https://github.com/cjjutba/kernel/blob/main/.changes/README.md'
export const UNRELEASED = '.changes/unreleased'
export const RELEASES = 'site/content/releases'

/** Published in this order, as these sections. `internal` stays in the record and out of the notes. */
export const SECTIONS = [
  { type: 'new', title: 'New' },
  { type: 'improved', title: 'Improved' },
  { type: 'fixed', title: 'Fixed' }
] as const

const Sentence = z
  .string()
  .min(1, { error: 'the note is empty. Write one sentence under the frontmatter', abort: true })
  .refine((s) => !s.includes('\n'), 'the note is one sentence on one line')
  .refine((s) => !/[–—]/.test(s), 'use a comma or a period instead of an em or en dash')
  .refine((s) => !/\(#\d+\)/.test(s), 'leave the PR number out. The release finds it')
  .refine((s) => s.endsWith('.'), 'end the sentence with a period')

export const Fragment = z
  .strictObject({
    type: z.enum(['new', 'improved', 'fixed', 'internal'], { error: 'type is new, improved, fixed or internal' }),
    issue: z.string().regex(/^KERNEL-\d+$/, 'issue looks like KERNEL-41. Leave it out when there is no issue').optional(),
    // Only for a note written after the fact, in a later PR than the change. Otherwise the release finds the PR.
    pr: z.string().regex(/^[1-9]\d*$/, 'pr is the number of the PR that made the change, like 44').transform(Number).optional(),
    text: Sentence
  })
  .refine((f) => f.type !== 'fixed' || f.text.startsWith('Fixed'), { message: 'a fixed note starts with "Fixed"', path: ['text'] })

export type Fragment = z.infer<typeof Fragment>
export interface FragmentFile { file: string; fragment: Fragment }

/** Reads one fragment. Throws with every problem, one per line. */
export function parseFragment(name: string, text: string): Fragment {
  const problems: string[] = []
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) problems.push('name the file in kebab-case, like pr-refresh.md')
  let parsed: ReturnType<typeof Fragment.safeParse> | undefined
  try {
    const { data, body } = parseFrontmatter(text)
    parsed = Fragment.safeParse({ ...data, text: body.trim() })
  } catch (e) {
    problems.push((e as Error).message)
  }
  if (parsed && !parsed.success) problems.push(...describeIssues(parsed.error))
  if (problems.length || !parsed?.success) throw new Error(problems.join('\n'))
  return parsed.data
}

/** Every fragment in .changes/unreleased/, with a "<file>: <problem>" line for each one that doesn't parse. */
export function readFragments(root: string): { fragments: FragmentFile[]; errors: string[] } {
  const dir = join(root, UNRELEASED)
  const fragments: FragmentFile[] = []
  const errors: string[] = []
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : []
  for (const name of names) {
    const file = `${UNRELEASED}/${name}`
    try {
      fragments.push({ file, fragment: parseFragment(name, readFileSync(join(dir, name), 'utf8')) })
    } catch (e) {
      for (const line of (e as Error).message.split('\n')) errors.push(`${file}: ${line}`)
    }
  }
  return { fragments, errors }
}

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

/**
 * The PR that added `file`: main's squash commits end their subject in "(#NN)". Undefined before it merges.
 * A catch-up fragment's `pr:` wins over this (collect).
 */
export function prFor(root: string, file: string): number | undefined {
  const subject = git(root, ['log', '--diff-filter=A', '--format=%s', '-1', '--', file]).trim()
  const m = /\(#(\d+)\)$/.exec(subject)
  return m ? Number(m[1]) : undefined
}

export interface Note { file: string; type: Fragment['type']; text: string; issue?: string; pr?: number }

export interface Collected {
  /** Published notes, grouped by SECTIONS type. */
  byType: Record<'new' | 'improved' | 'fixed', Note[]>
  internal: Note[]
}

/** Reads and validates the unreleased fragments and finds their PRs. Throws on any bad fragment. */
export function collect(root: string): Collected {
  const { fragments, errors } = readFragments(root)
  if (errors.length) throw new Error(`Fix these fragments first:\n${errors.map((e) => `  ${e}`).join('\n')}\nSee ${README_URL}`)
  const notes = fragments.map(({ file, fragment }): Note => ({
    file,
    type: fragment.type,
    text: fragment.text,
    ...(fragment.issue ? { issue: fragment.issue } : {}),
    ...withPr(fragment.pr ?? prFor(root, file))
  }))
  // Merge order, so the notes read roughly in the order the changes landed. Notes without a PR go last.
  notes.sort((a, b) => (a.pr ?? Infinity) - (b.pr ?? Infinity) || a.file.localeCompare(b.file))
  return {
    byType: { new: notes.filter((n) => n.type === 'new'), improved: notes.filter((n) => n.type === 'improved'), fixed: notes.filter((n) => n.type === 'fixed') },
    internal: notes.filter((n) => n.type === 'internal')
  }
}

const withPr = (pr: number | undefined) => (pr ? { pr } : {})

/** Minor when anything is new, otherwise patch. */
export function suggestVersion(current: string, c: Collected): { version: string; bump: 'minor' | 'patch' } {
  const [major, minor, patch] = current.split('.').map(Number) as [number, number, number]
  return c.byType.new.length ? { version: `${major}.${minor + 1}.0`, bump: 'minor' } : { version: `${major}.${minor}.${patch + 1}`, bump: 'patch' }
}

export function packageVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
}

/** The release a compile writes. A minor gets the placeholder title, which the schema refuses until someone edits it. */
export function buildRelease(version: string, date: string, c: Collected): Release {
  return {
    version,
    date,
    title: isPatch(version) ? `Kernel ${version}` : PLACEHOLDER_TITLE,
    sections: SECTIONS.filter((s) => c.byType[s.type].length).map((s) => ({
      title: s.title,
      items: c.byType[s.type].map((n): ChangeItem => ({ text: n.text, ...withPr(n.pr) }))
    }))
  }
}

export interface Compiled { file: string; release: Release; collected: Collected; moved: string }

/**
 * `npm run release:notes -- <version>`: writes site/content/releases/<version>.md and moves the fragments to
 * .changes/released/<version>/. Refuses an existing file, a version that isn't above package.json, and a release
 * with nothing to publish.
 */
export function compile({ root, version, date }: { root: string; version: string; date: string }): Compiled {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not a version like 0.2.0.`)
  const current = packageVersion(root)
  if (compareVersions(version, current) <= 0) throw new Error(`${version} is not higher than ${current} in package.json.`)
  const file = `${RELEASES}/${version}.md`
  if (existsSync(join(root, file))) throw new Error(`${file} already exists. A published version's notes never change.`)
  const collected = collect(root)
  const published = SECTIONS.flatMap((s) => collected.byType[s.type])
  if (!published.length && !collected.internal.length) throw new Error(`There are no fragments in ${UNRELEASED}/, so there is nothing to release.`)
  if (!published.length) throw new Error(`Every fragment in ${UNRELEASED}/ is internal, so the release would have no notes. Add a fragment users can read.`)

  const release = buildRelease(version, date, collected)
  writeFileSync(join(root, file), formatReleaseFile(release))
  const moved = `.changes/released/${version}`
  mkdirSync(join(root, moved), { recursive: true })
  for (const n of [...published, ...collected.internal]) renameSync(join(root, n.file), join(root, moved, n.file.split('/').pop()!))
  return { file, release, collected, moved }
}

/** Reads and validates a release file. */
export function readRelease(root: string, version: string): Release {
  const file = `${RELEASES}/${version}.md`
  if (!existsSync(join(root, file))) throw new Error(`${file} is missing.`)
  try {
    return parseReleaseFile(readFileSync(join(root, file), 'utf8'))
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`)
  }
}

/**
 * The notes electron-builder copies into latest-mac.yml for What's new. Installed 0.1.0 copies parse them with the
 * parser they shipped with, which turns each `###` heading into a note and joins the lines under it, so this format
 * has to read well there too (test/fixtures/parseNotes-v0.1.0.ts). An item with a lead that ends in a period becomes
 * its own note (WhatsNew.png). The rest list under their section's title. No PR numbers or markdown emphasis.
 */
export function renderApp(release: Release): string {
  const out: string[] = []
  for (const section of release.sections) {
    const lines: string[] = []
    for (const item of section.items) {
      if (item.lead?.endsWith('.')) out.push(`### ${item.lead.slice(0, -1)}`, item.text, '')
      else lines.push(`- ${item.lead ? `${item.lead} ` : ''}${item.text}`)
    }
    if (lines.length) out.push(`### ${section.title}`, ...lines, '')
  }
  return out.join('\n')
}

/**
 * The GitHub release body: the intro and the sections, PR numbers included (GitHub links them), then GitHub's
 * generated list of merged PRs under "Full list of changes".
 */
export function renderGithub(release: Release, fullList?: string): string {
  const parts = release.intro ? [release.intro] : []
  for (const s of release.sections) {
    const items = s.items.map((i) => `- ${i.lead ? `**${i.lead}** ` : ''}${i.text}${i.pr ? ` (#${i.pr})` : ''}`)
    parts.push(`## ${s.title}\n\n${items.join('\n')}`)
  }
  const list = fullList?.replace(/^\s*## What's Changed\s*\n/, '').trim()
  if (list) parts.push(`## Full list of changes\n\n${list}`)
  return `${parts.join('\n\n')}\n`
}

// The CI check (.github/workflows/release-note.yml). App files are what ships in Kernel.app or builds it.
const APP_FILES = [/^src\//, /^docs\/starter-agents\//, /^build\//, /^electron-builder\.yml$/, /^scripts\//]
export const SKIP_LABEL = 'skip-release-note'

export const isAppFile = (path: string) => APP_FILES.some((r) => r.test(path))

/** True when the dependencies differ. A script or version change in package.json doesn't count, nor does their order. */
export function dependenciesChanged(before: string, after: string): boolean {
  const deps = (text: string) => {
    const p = JSON.parse(text) as Record<string, Record<string, string> | undefined>
    const sorted = (d: Record<string, string> | undefined) => Object.entries(d ?? {}).sort(([a], [b]) => a.localeCompare(b))
    return JSON.stringify([p.dependencies, p.devDependencies, p.optionalDependencies].map(sorted))
  }
  return deps(before) !== deps(after)
}

export interface PullRequest {
  branch: string
  /** From a fork, where anyone can name a branch release/x. */
  fork?: boolean
  labels: string[]
  /** `git diff --name-status --no-renames` against the base: A, M, D and so on. */
  files: { status: string; path: string }[]
  dependenciesChanged: boolean
}

export type CheckResult =
  | { ok: true; reason: 'release branch' | 'skip label' | 'no app files' | 'has a fragment' }
  | { ok: false; appFiles: string[]; suggestion: string }

/** Whether a PR needs a fragment and has one. Fragment contents are validated separately (readFragments). */
export function checkPullRequest(pr: PullRequest): CheckResult {
  if (pr.branch.startsWith('release/') && !pr.fork) return { ok: true, reason: 'release branch' }
  if (pr.labels.includes(SKIP_LABEL)) return { ok: true, reason: 'skip label' }
  const appFiles = pr.files.map((f) => f.path).filter(isAppFile)
  if (pr.dependenciesChanged) appFiles.push('package.json (dependencies)')
  if (!appFiles.length) return { ok: true, reason: 'no app files' }
  const added = pr.files.some((f) => f.status === 'A' && /^\.changes\/unreleased\/[^/]+\.md$/.test(f.path))
  if (added) return { ok: true, reason: 'has a fragment' }
  const slug = (pr.branch.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return { ok: false, appFiles, suggestion: `${UNRELEASED}/${slug || 'my-change'}.md` }
}

/** What the check prints when a fragment is missing. */
export function missingMessage(r: Extract<CheckResult, { ok: false }>): string {
  return [
    'This PR changes app files but adds no release note.',
    '',
    `Add ${r.suggestion} with what a user will notice, in one sentence:`,
    '',
    '  ---',
    '  type: fixed',
    '  ---',
    '  Fixed a pull request sometimes showing its old status after a quick refresh.',
    '',
    'type is new, improved, fixed or internal. Use internal when users won\'t notice (refactors, tests, CI).',
    'Add "issue: KERNEL-41" under type when there is a Linear issue.',
    `How to write it: ${README_URL}`,
    '',
    'App files in this PR:',
    ...r.appFiles.map((f) => `  ${f}`)
  ].join('\n')
}
