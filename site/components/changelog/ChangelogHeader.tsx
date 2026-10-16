import { ArrowIcon, GitHubIcon } from '@/components/ui/icons'
import { RELEASES_URL } from '@/lib/links'
import { Container } from '@/components/ui/Container'
import { ExternalLink } from '@/components/ui/ExternalLink'

function FeedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M3 3.5a9.5 9.5 0 0 1 9.5 9.5M3 7.5A5.5 5.5 0 0 1 8.5 13" />
      <circle cx="3.75" cy="12.25" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

const link = 'inline-flex items-center gap-2 text-link font-medium text-ink-2 transition-colors hover:text-white'

/** `page` and `pages` add a page count under the lead on pages after the first. */
export function ChangelogHeader({ page = 1, pages = 1 }: { page?: number; pages?: number }) {
  return (
    <section id="top" aria-labelledby="changelog-title" className="relative border-b border-line-faint pt-32 pb-14 max-nav:pt-20 max-nav:pb-10">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-dots-page bg-dots-hero" />
      <Container size="changelog" className="relative">
        <h1 id="changelog-title" className="text-changelog-title">
          What&apos;s new in Kernel
        </h1>
        <p className="mt-4 max-w-section-lead text-lead text-muted">New features, improvements and fixes in every release.</p>
        {page > 1 ? (
          <p className="mt-3 text-ui text-faint">
            Page {page} of {pages}
          </p>
        ) : null}
        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 max-nav:mt-6">
          <ExternalLink href={RELEASES_URL} className={link}>
            <GitHubIcon size={15} />
            Releases on GitHub
            <ArrowIcon className="text-muted" />
          </ExternalLink>
          <a href="/changelog/rss.xml" className={link}>
            <FeedIcon />
            RSS feed
          </a>
        </div>
      </Container>
    </section>
  )
}
