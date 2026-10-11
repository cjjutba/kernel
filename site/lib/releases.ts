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
