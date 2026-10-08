import { join } from 'node:path'
import { groupReleases, loadReleases } from '@/lib/releases'
import { Changelog } from '@/lib/schema'
import { upNext } from './upNext'

// Each release is a file in content/releases, compiled from the repo's .changes fragments by
// `npm run release:notes` (see .changes/README.md). Entries are newest first; the first gets the Latest badge.
// Everything is parsed at build time, so a malformed file fails the build.
const releases = loadReleases(join(process.cwd(), 'content', 'releases'))

export const changelog = Changelog.parse({ releases: groupReleases(releases), upNext })

/** The newest version, patches included. It sets the hero pill on the landing page and the sitemap date. */
export const latestRelease = releases[0]!
