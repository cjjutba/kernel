import { ChangelogHeader } from '@/components/changelog/ChangelogHeader'
import { ReleaseEntry } from '@/components/changelog/ReleaseEntry'
import { UpNext } from '@/components/changelog/UpNext'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import type { Metadata } from 'next'
import { changelog } from '@/content/changelog'
import { pageMetadata } from '@/lib/site'

const title = 'Changelog · Kernel'
const description = 'New features, improvements and fixes in every Kernel release.'

export const metadata: Metadata = pageMetadata({ title, description, path: '/changelog' })

export default function ChangelogPage() {
  return (
    <>
      <SiteNav current="/changelog" />
      <main id="content">
        <ChangelogHeader />
        <div className="mx-auto max-w-262 px-6">
          {changelog.releases.map((release, i) => (
            <ReleaseEntry key={release.version} release={release} latest={i === 0} />
          ))}
          <UpNext data={changelog.upNext} />
          <p className="pt-16 pb-24 text-center text-ui text-faint">
            This is where it all starts. Older releases will appear here as Kernel grows.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
