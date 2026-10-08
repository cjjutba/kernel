import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { excludeFromGit } from './settings'

/**
 * Plan-mode plans as files (D-092). Each plan is written to `.kernel/plans/<name>.md` in its workspace folder, so any chat
 * there can build from it (`@.kernel/plans/<name>.md`) after the card is gone: a closed tab, /clear, a restart. The folder
 * goes in `info/exclude` like `.kernel/settings.local.toml`, so a plan never shows in Changes or lands in a PR.
 */
export const PLANS_DIR = '.kernel/plans'

const exists = (path: string) => access(path).then(() => true, () => false)

/** A file name from the plan's opening heading, or from `fallback` when it has none. */
export function planName(text: string, fallback: string): string {
  const first = text.split('\n').find((l) => l.trim())
  const title = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(first ?? '')?.[1] ?? fallback
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '')
  return slug || 'plan'
}

/**
 * Writes the plan and returns its path relative to `root`. `reuse` is the file an earlier version of the same plan went
 * to (a revision after "Request changes"), which is overwritten. A new plan never overwrites another one: it takes the
 * next free name.
 */
export async function savePlan(root: string, text: string, o: { fallback: string; reuse?: string }): Promise<string> {
  await excludeFromGit(root, `${PLANS_DIR}/`)
  await mkdir(join(root, PLANS_DIR), { recursive: true })
  let file = o.reuse && /^\.kernel\/plans\/[^/]+\.md$/.test(o.reuse) ? o.reuse : undefined
  if (!file) {
    const base = planName(text, o.fallback)
    for (let n = 1; ; n++) {
      file = `${PLANS_DIR}/${n === 1 ? base : `${base}-${n}`}.md`
      if (!(await exists(join(root, file)))) break
    }
  }
  await writeFile(join(root, file), text.endsWith('\n') ? text : `${text}\n`)
  return file
}

export const planExists = (root: string, file: string) => exists(join(root, file))
