import { Container } from '@/components/ui/Container'
import { ExternalLink } from '@/components/ui/ExternalLink'
import { ArrowIcon, GitHubIcon } from '@/components/ui/icons'
import { SectionHead } from '@/components/ui/SectionHead'
import { RELEASES_URL } from '@/lib/links'

export function ChangelogHeader() {
  return (
    <section id="top" aria-labelledby="changelog-title" className="relative border-b border-line-faint pt-32 pb-16">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-dots-changelog bg-dots-hero" />
      <Container size="changelog" className="relative">
        <SectionHead
          variant="page"
          align="start"
          eyebrow="Changelog"
          title="What's new in Kernel"
          titleId="changelog-title"
          lead="New features, improvements and fixes in every release. Full release notes and downloads live on GitHub."
        >
          <ExternalLink href={RELEASES_URL} className="mt-6 inline-flex items-center gap-2 text-link font-medium text-ink hover:text-white">
            <GitHubIcon size={15} />
            View releases on GitHub
            <ArrowIcon className="text-muted" />
          </ExternalLink>
        </SectionHead>
      </Container>
    </section>
  )
}
