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

/** Releases on each page of the changelog. Page 1 is /changelog, the rest /changelog/page/2 and on. */
export const RELEASES_PER_PAGE = 4

export const changelogPageHref = (page: number) => (page <= 1 ? '/changelog' : `/changelog/page/${page}`)

/** One page of the published changelog, or null past the last page. */
export async function changelogPage(page: number) {
  const { releases, upNext } = await publishedChangelog()
  const pages = Math.max(1, Math.ceil(releases.length / RELEASES_PER_PAGE))
  if (!Number.isInteger(page) || page < 1 || page > pages) return null
  const start = (page - 1) * RELEASES_PER_PAGE
  return { page, pages, total: releases.length, releases: releases.slice(start, start + RELEASES_PER_PAGE), upNext }
}

/** Every page number a release file could fill, published or not, for static generation. */
export const changelogPageCount = () => Math.max(1, Math.ceil(changelog.releases.length / RELEASES_PER_PAGE))

/** A release's own page, which the changelog's titles link to. */
export const releaseHref = (version: string) => `/changelog/${version}`

/** A published release by version, or null when there is no such file or GitHub hasn't published it yet. */
export async function publishedRelease(version: string): Promise<Release | null> {
  return (await publishedChangelog()).releases.find((r) => r.version === version) ?? null
}
