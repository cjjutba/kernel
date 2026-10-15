import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import type { changelogPage } from '@/content/changelog'
import { ChangelogHeader } from './ChangelogHeader'
import { Pager } from './Pager'
import { ReleaseEntry } from './ReleaseEntry'
import { UpNext } from './UpNext'

/** One page of the changelog. Up next and the Latest badge belong to page 1. */
export function ChangelogView({ data }: { data: NonNullable<Awaited<ReturnType<typeof changelogPage>>> }) {
  const { page, pages, total, releases, upNext } = data
  return (
    <>
      <SiteNav current="/changelog" />
      <main id="content">
        <ChangelogHeader page={page} pages={pages} />
        <div className="mx-auto max-w-262 px-6 pb-24">
          {releases.map((release, i) => (
            <ReleaseEntry key={release.version} release={release} latest={page === 1 && i === 0} />
          ))}
          {page === 1 ? <UpNext data={upNext} /> : null}
          <Pager page={page} pages={pages} />
          {/* The design draws this under the first release only. With more, it would no longer be true. */}
          {total === 1 ? (
            <p className="pt-16 text-center text-ui text-faint">
              This is where it all starts. Older releases will appear here as Kernel grows.
            </p>
          ) : null}
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
