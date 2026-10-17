import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowIcon } from '@/components/ui/icons'
import { Shot } from '@/components/ui/Shot'
import { releaseHref } from '@/content/changelog'
import { formatDate } from '@/lib/format'
import type { Release } from '@/lib/schema'
import { ChangeList } from './ChangeList'
import { Badge } from '@/components/ui/Badge'

const versionPill = 'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-micro leading-normal font-medium'

/**
 * The two-column entry shared by releases and Up next: meta on the left, the notes on the right. On wide screens the
 * meta stays in view beside a long entry, under the sticky nav. `above` sits over the notes, so the meta lines up
 * with the title instead of with it.
 */
export function EntryShell({ titleId, meta, above, children }: { titleId: string; meta: ReactNode; above?: ReactNode; children: ReactNode }) {
  return (
    <article
      aria-labelledby={titleId}
      className={`grid grid-entry gap-x-14 max-nav:grid-cols-1 max-nav:gap-3 ${above ? 'gap-y-8' : 'border-b border-line-faint py-16 max-nav:py-10'}`}
    >
      {above ? (
        <>
          <div aria-hidden="true" className="max-nav:hidden" />
          <div>{above}</div>
        </>
      ) : null}
      <div className="nav:sticky nav:top-24 nav:self-start">{meta}</div>
      <div>{children}</div>
    </article>
  )
}

export function VersionPill({ next, children }: { next?: boolean; children: ReactNode }) {
  return (
    <span className={`${versionPill} ${next ? 'border-dashed border-edge text-ink-2' : 'border-edge bg-raised text-ink'}`}>
      {children}
    </span>
  )
}

/**
 * A release in the changelog, where its title and version link to the release's own page. `standalone` is that page:
 * the title is the page's heading, with a link back to the changelog above it.
 */
export function ReleaseEntry({ release, latest, standalone }: { release: Release; latest: boolean; standalone?: boolean }) {
  const titleId = `v${release.version.replaceAll('.', '')}`
  const changes = release.sections.reduce((n, s) => n + s.items.length, 0)
  const href = releaseHref(release.version)
  const Title = standalone ? 'h1' : 'h2'
  return (
    <EntryShell
      titleId={titleId}
      above={
        standalone ? (
          <Link href="/changelog" className="inline-flex items-center gap-2 text-ui font-medium text-ink-2 transition-colors hover:text-ink">
            <ArrowIcon className="rotate-180 text-muted" />
            Back to changelog
          </Link>
        ) : undefined
      }
      meta={
        <>
          <div className="flex items-center gap-2">
            {standalone ? (
              <VersionPill>{release.version}</VersionPill>
            ) : (
              <Link href={href} aria-label={`Kernel ${release.version}`} className="rounded-chip transition-opacity hover:opacity-80">
                <VersionPill>{release.version}</VersionPill>
              </Link>
            )}
            {latest ? (
              <Badge size="sm">Latest</Badge>
            ) : null}
          </div>
          {/* Stacked beside the entry on wide screens; one line above it on phones. */}
          <p className="mt-2 text-label text-muted">
            <time dateTime={release.date} className="nav:block">
              {formatDate(release.date)}
            </time>
            <span aria-hidden="true" className="text-faint nav:hidden">
              {' · '}
            </span>
            <span className="text-faint nav:mt-1 nav:block">
              {changes} {changes === 1 ? 'change' : 'changes'}
            </span>
          </p>
        </>
      }
    >
      <Title id={titleId} className="scroll-mt-8 text-entry-title">
        {standalone ? (
          release.title
        ) : (
          <Link href={href} className="transition-colors hover:text-ink-2">
            {release.title}
          </Link>
        )}
      </Title>
      {release.image ? (
        <Shot
          src={release.image.src}
          alt={release.image.alt}
          sizes="(max-width: 760px) calc(100vw - 48px), 744px"
          className="mt-8"
        />
      ) : null}
      {release.intro ? <p className="mt-6 text-intro text-ink-2 max-nav:mt-4">{release.intro}</p> : null}
      {release.sections.map((section) => (
        <section key={section.title}>
          <h3 className="mt-10 flex items-baseline gap-2 text-body font-semibold max-nav:mt-8">
            {section.title}
            <span className="font-mono text-tag font-medium text-faint">{section.items.length}</span>
          </h3>
          <ChangeList items={section.items} />
        </section>
      ))}
    </EntryShell>
  )
}
