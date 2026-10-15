import type { ReactNode } from 'react'
import { Shot } from '@/components/ui/Shot'
import { formatDate } from '@/lib/format'
import type { Release } from '@/lib/schema'
import { ChangeList } from './ChangeList'

const versionPill = 'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-micro leading-normal font-medium'

/**
 * The two-column entry shared by releases and Up next: meta on the left, the notes on the right. On wide screens the
 * meta stays in view beside a long entry, under the sticky nav.
 */
export function EntryShell({ titleId, meta, children }: { titleId: string; meta: ReactNode; children: ReactNode }) {
  return (
    <article aria-labelledby={titleId} className="grid grid-entry gap-14 border-b border-line-faint py-16 max-nav:grid-cols-1 max-nav:gap-3 max-nav:py-10">
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

export function ReleaseEntry({ release, latest }: { release: Release; latest: boolean }) {
  const titleId = `v${release.version.replaceAll('.', '')}`
  const changes = release.sections.reduce((n, s) => n + s.items.length, 0)
  return (
    <EntryShell
      titleId={titleId}
      meta={
        <>
          <div className="flex items-center gap-2">
            {/* The version links to its own entry, so a release can be shared. */}
            <a href={`#${titleId}`} aria-label={`Link to Kernel ${release.version}`} className="rounded-chip transition-opacity hover:opacity-80">
              <VersionPill>{release.version}</VersionPill>
            </a>
            {latest ? (
              <span className="inline-flex h-5 items-center rounded-pill bg-ink px-2 text-badge font-semibold text-canvas">
                Latest
              </span>
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
      <h2 id={titleId} className="scroll-mt-8 text-entry-title">
        {release.title}
      </h2>
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
