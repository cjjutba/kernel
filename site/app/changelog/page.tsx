import { ChangelogHeader } from '@/components/changelog/ChangelogHeader'
import { ReleaseEntry } from '@/components/changelog/ReleaseEntry'
import { UpNext } from '@/components/changelog/UpNext'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { Container } from '@/components/ui/Container'
import type { Metadata } from 'next'
import { publishedChangelog } from '@/content/changelog'
import { pageMetadata } from '@/lib/site'

const title = 'Changelog · Kernel'
const description = 'New features, improvements and fixes in every Kernel release.'

export const metadata: Metadata = pageMetadata({ title, description, path: '/changelog' })

export default async function ChangelogPage() {
  const { releases, upNext } = await publishedChangelog()
  return (
    <>
      <SiteNav current="/changelog" />
      <main id="content">
        <ChangelogHeader />
        <Container size="changelog" className="pb-24">
          {releases.map((release, i) => (
            <ReleaseEntry key={release.version} release={release} latest={i === 0} />
          ))}
          <UpNext data={upNext} />
          {/* The design draws this under the first release only. With more, it would no longer be true. */}
          {releases.length === 1 ? (
            <p className="pt-16 text-center text-ui text-faint">
              This is where it all starts. Older releases will appear here as Kernel grows.
            </p>
          ) : null}
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}
