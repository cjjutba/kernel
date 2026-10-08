import { Eyebrow } from '@/components/ui/Eyebrow'
import { ArrowIcon, GitHubIcon } from '@/components/ui/icons'
import { RELEASES_URL } from '@/lib/links'

export function ChangelogHeader() {
  return (
    <section id="top" aria-labelledby="changelog-title" className="relative border-b border-line-faint pt-32 pb-16">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-130 bg-dots-hero" />
      <div className="relative mx-auto max-w-262 px-6">
        <Eyebrow>Changelog</Eyebrow>
        <h1 id="changelog-title" className="mt-4 text-changelog-title">
          What&apos;s new in Kernel
        </h1>
        <p className="mt-4 max-w-140 text-lead text-muted">
          New features, improvements and fixes in every release. Full release notes and downloads live on GitHub.
        </p>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener"
          className="mt-6 inline-flex items-center gap-2 text-link font-medium text-ink hover:text-white"
        >
          <GitHubIcon size={15} />
          View releases on GitHub
          <ArrowIcon className="text-muted" />
        </a>
      </div>
    </section>
  )
}
