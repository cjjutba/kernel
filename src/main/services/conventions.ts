import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { addressReviewText, createPrText, fixChecksText, resolveText, type PrContext, type PrTextKind, type RepoConventions } from '@shared/prTexts'

export { addressReviewText, createPrText, fixChecksText, resolveText }
export type { PrContext, PrTextKind, RepoConventions }

// What a repo asks of a pull request, from the files GitHub and commitlint read and the repo's own PR skills, so Create PR
// (KERNEL-468) and the buttons that fix a PR (KERNEL-564) follow it.


/** Where GitHub looks for a PR template and a contributing guide. The first found is the one used. */
const PLACES = ['.github', '', 'docs']
const TEMPLATE = /^pull_request_template(\.(md|txt))?$/i
const CONTRIBUTING = /^contributing(\.(md|markdown|rst|txt|adoc))?$/i
/** commitlint's own config file names, at the repo's top. */
const COMMITLINT = /^(\.commitlintrc(\.(json|ya?ml|[cm]?js|[cm]?ts))?|commitlint\.config\.[cm]?[jt]s)$/
/** A skill or command named for pull requests: `create-pr`, `pr-review`, `open-pull-request`. Not `issue` or `release`. */
const GUIDE = /(^|[-_])(pr|prs|pull[-_]?requests?)([-_]|$)/i

const isFile = (path: string) => stat(path).then((s) => s.isFile(), () => false)

/** The repo's skills (`<name>/SKILL.md`) and commands (`<name>.md`) for pull requests, by repo-relative path. */
async function readGuides(dir: string): Promise<string[]> {
  const names = (place: string) => readdir(join(dir, place)).catch(() => [] as string[])
  const skills = ['.claude/skills', '.agents/skills'].map(async (place) => (await names(place)).filter((n) => GUIDE.test(n)).map((n) => `${place}/${n}/SKILL.md`))
  const commands = names('.claude/commands').then((files) => files.filter((f) => f.endsWith('.md') && GUIDE.test(f.slice(0, -3))).map((f) => `.claude/commands/${f}`))
  const found = (await Promise.all([...skills, commands])).flat().sort()
  const files = await Promise.all(found.map(async (f) => ((await isFile(join(dir, f))) ? f : undefined)))
  return files.filter((f): f is string => f !== undefined).slice(0, 3)
}

/** The conventions of the repo checked out at `dir`. A file that can't be read counts as missing. */
export async function readConventions(dir: string): Promise<RepoConventions> {
  const out: RepoConventions = {}
  const places = await Promise.all(PLACES.map(async (place) => ({ place, entries: await readdir(join(dir, place), { withFileTypes: true }).catch(() => []) })))
  const at = (place: string, name: string) => (place ? `${place}/${name}` : name)
  for (const { place, entries } of places) {
    const file = entries.find((e) => !e.isDirectory() && TEMPLATE.test(e.name))
    if (file) out.template ??= at(place, file.name)
    const guide = entries.find((e) => !e.isDirectory() && CONTRIBUTING.test(e.name))
    if (guide) out.contributing ??= at(place, guide.name)
  }
  // GitHub opens a PR with the single template. A folder of them only counts when there is none.
  for (const { place, entries } of out.template ? [] : places) {
    const folder = entries.find((e) => e.isDirectory() && /^pull_request_template$/i.test(e.name))
    if (!folder || !(await readdir(join(dir, place, folder.name)).catch(() => [])).some((f) => /\.(md|txt)$/i.test(f))) continue
    out.template = `${at(place, folder.name)}/`
    break
  }
  const config = (await readdir(dir).catch(() => [])).find((f) => COMMITLINT.test(f))
  const pkg = config ? undefined : await readFile(join(dir, 'package.json'), 'utf8').then((t) => JSON.parse(t), () => undefined)
  if (config) out.commitlint = config
  else if (pkg && typeof pkg === 'object' && pkg.commitlint !== undefined) out.commitlint = 'package.json'
  const guides = await readGuides(dir)
  if (guides.length) out.guides = guides
  return out
}

const BUILDERS: Record<PrTextKind, (c?: RepoConventions, ctx?: PrContext) => string> = { create: createPrText, resolve: resolveText, fixChecks: fixChecksText, addressReview: addressReviewText }

/**
 * The PR text to send for the checkout at `dir`: Kernel's own text fitted to the repo and the workspace, or the user's or the
 * project's text as written (KERNEL-468). Kernel's texts from before, which older settings files saved, read as unset (`SAVED_BEFORE`).
 */
export async function prTextFor(kind: PrTextKind, text: string, dir: string, ctx?: PrContext): Promise<string> {
  const build = BUILDERS[kind]
  return text.trim() === build() ? build(await readConventions(dir), ctx) : text
}
