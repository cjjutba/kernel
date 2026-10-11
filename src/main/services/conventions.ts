import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// What a repo asks of a pull request, from the files GitHub and commitlint read, so Create PR follows it (KERNEL-468).

/** The repo's conventions, by repo-relative path. */
export interface RepoConventions {
  /** The PR template: a file, or a folder of templates ending in `/` when the repo has no single one. */
  template?: string
  /** The contributing guide. */
  contributing?: string
  /** Where commitlint is configured: its config file, or `package.json`. */
  commitlint?: string
}

/** Where GitHub looks for a PR template and a contributing guide. The first found is the one used. */
const PLACES = ['.github', '', 'docs']
const TEMPLATE = /^pull_request_template(\.(md|txt))?$/i
const CONTRIBUTING = /^contributing(\.(md|markdown|rst|txt|adoc))?$/i
/** commitlint's own config file names, at the repo's top. */
const COMMITLINT = /^(\.commitlintrc(\.(json|ya?ml|[cm]?js|[cm]?ts))?|commitlint\.config\.[cm]?[jt]s)$/

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
  return out
}

/**
 * Kernel's create-PR text for a repo with these conventions. It asks for Conventional Commits only when commitlint checks
 * them, and otherwise for titles like the repo's own. With no conventions it is the default in Settings, Pull requests.
 */
export function createPrText(c: RepoConventions = {}): string {
  const body = !c.template ? 'Fill in summary, scope and risk.'
    : c.template.endsWith('/') ? `Write the body from the template in \`${c.template}\` that fits the change, filling in each of its sections.`
    : `Write the body from the repo's PR template, \`${c.template}\`, filling in each of its sections.`
  const steps = [
    ...(c.contributing ? [`Read \`${c.contributing}\` and follow what it says about pull requests.`] : []),
    'Rebase on the base branch and run the test suite.',
    c.commitlint ? `Title it and write its commits as Conventional Commits. The repo checks them with commitlint (\`${c.commitlint}\`).` : "Title it in the style of the repo's recent commits.",
    body,
    'Open it with `gh pr create` and print the URL.'
  ]
  return ['# Create a pull request', ...steps.map((s, i) => `${i + 1}. ${s}`)].join('\n')
}

/**
 * The create-PR text to send for the checkout at `dir`: Kernel's own text fitted to the repo, or the user's or the room's
 * text as written. Kernel's text from before KERNEL-468, which older settings files saved, reads as unset (`SAVED_BEFORE`).
 */
export async function createTextFor(text: string, dir: string): Promise<string> {
  return text.trim() === createPrText() ? createPrText(await readConventions(dir)) : text
}
