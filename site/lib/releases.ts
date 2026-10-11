import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, parseReleaseFile, type Release } from '@/lib/schema'

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

/** The releases at or below `published`, GitHub's latest published version, newest first (KERNEL-412). */
export function publishedReleases(releases: Release[], published: string): Release[] {
  const shown = releases.filter((r) => compareVersions(r.version, published) <= 0)
  if (!shown.length) throw new Error(`no release file at or below ${published}, GitHub's latest release`)
  return shown
}
