import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupReleases, loadReleases } from '@/lib/releases'
import { Changelog } from '@/lib/schema'
import { upNext } from './upNext'

// Each release is a file in content/releases, compiled from the repo's .changes fragments by
// `pnpm release:notes` (see .changes/README.md). Entries are newest first; the first gets the Latest badge.
// Everything is parsed at build time, so a malformed file fails the build.
// CHANGELOG_FIXTURE swaps in another folder with releases/ and upNext.json. The e2e render comparison builds from
// tests/fixtures/render, the content design/site/renders shows, so a new release doesn't fail it (D-134).
const fixture = process.env.CHANGELOG_FIXTURE
const releases = loadReleases(join(fixture ?? join(process.cwd(), 'content'), 'releases'))

export const changelog = Changelog.parse({
  releases: groupReleases(releases),
  upNext: fixture ? JSON.parse(readFileSync(join(fixture, 'upNext.json'), 'utf8')) : upNext
})

/** The newest version, patches included. It sets the hero pill on the landing page and the sitemap date. */
export const latestRelease = releases[0]!
