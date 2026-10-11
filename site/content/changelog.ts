import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPublishedVersion } from '@/lib/github'
import { loadReleases, publishedReleases } from '@/lib/releases'
import { Changelog, type Release } from '@/lib/schema'
import { upNext } from './upNext'

// Each release is a file in content/releases, compiled from the repo's .changes fragments by
// `pnpm release:notes` (see .changes/README.md). Entries are newest first; the first gets the Latest badge.
// Everything is parsed at build time, so a malformed file fails the build. A file shows only once GitHub has
// published its release (KERNEL-412).
// CHANGELOG_FIXTURE swaps in another folder with releases/ and upNext.json. The e2e render comparison builds from
// tests/fixtures/render, the content design/site/renders shows, so a new release doesn't fail it (D-135).
const fixture = process.env.CHANGELOG_FIXTURE
const releases = loadReleases(join(fixture ?? join(process.cwd(), 'content'), 'releases'))

/** Every release file, published or not, checked against the schema. */
export const changelog = Changelog.parse({
  releases,
  upNext: fixture ? JSON.parse(readFileSync(join(fixture, 'upNext.json'), 'utf8')) : upNext
})

/** The changelog with only the releases GitHub has published, newest first. The first sets the Latest badge. */
export async function publishedChangelog() {
  return { ...changelog, releases: publishedReleases(changelog.releases, await getPublishedVersion()) }
}

/** The newest published release. It sets the hero pill on the landing page and the sitemap date. */
export async function latestRelease(): Promise<Release> {
  return (await publishedChangelog()).releases[0]!
}
