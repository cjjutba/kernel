import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, isPatch, parseReleaseFile, type ChangelogEntry, type Release } from '@/lib/schema'

/** Every `<version>.md` in `dir`, parsed and newest first. Throws on a bad file, so a mistake fails the build. */
export function loadReleases(dir: string): Release[] {
  const releases = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      let release: Release
      try {
        release = parseReleaseFile(readFileSync(join(dir, name), 'utf8'))
      } catch (e) {
        throw new Error(`content/releases/${name}: ${(e as Error).message}`)
      }
      if (name !== `${release.version}.md`) throw new Error(`content/releases/${name} says version ${release.version}`)
      return release
    })
  return releases.sort((a, b) => compareVersions(b.version, a.version))
}

/** Folds each patch into its x.y.0 entry, oldest patch first. Entries stay newest first. */
export function groupReleases(releases: Release[]): ChangelogEntry[] {
  const newestFirst = [...releases].sort((a, b) => compareVersions(b.version, a.version))
  const entries = newestFirst.filter((r) => !isPatch(r.version)).map((r) => ({ ...r, patches: [] as Release[] }))
  for (const patch of newestFirst.filter((r) => isPatch(r.version)).reverse()) {
    const minor = patch.version.replace(/\.\d+$/, '.0')
    const entry = entries.find((e) => e.version === minor)
    if (!entry) throw new Error(`${patch.version} has no ${minor} release to show under`)
    entry.patches.push(patch)
  }
  return entries
}
