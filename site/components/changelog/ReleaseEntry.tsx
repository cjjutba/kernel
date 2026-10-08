import type { ReactNode } from 'react'
import { Shot } from '@/components/ui/Shot'
import { formatDate } from '@/lib/format'
import type { Release } from '@/lib/schema'
import { ChangeList } from './ChangeList'

const versionPill = 'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-micro leading-normal font-medium'

/** The two-column entry shared by releases and Up next: meta on the left, the notes on the right. */
export function EntryShell({ titleId, meta, children }: { titleId: string; meta: ReactNode; children: ReactNode }) {
  return (
    <article aria-labelledby={titleId} className="grid grid-entry gap-14 border-b border-line-faint py-16 max-nav:grid-cols-1 max-nav:gap-4">
      <div>{meta}</div>
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
  return (
    <EntryShell
      titleId={titleId}
      meta={
        <>
          <div className="flex items-center gap-2">
            <VersionPill>{release.version}</VersionPill>
            {latest ? (
              <span className="inline-flex h-5 items-center rounded-pill bg-ink px-2 text-badge font-semibold text-canvas">
                Latest
              </span>
            ) : null}
          </div>
          <time dateTime={release.date} className="mt-2 block text-label text-muted">
            {formatDate(release.date)}
          </time>
        </>
      }
    >
      <h2 id={titleId} className="text-entry-title">
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
      <p className="mt-6 text-intro text-ink-2">{release.intro}</p>
      {release.sections.map((section) => (
        <section key={section.title}>
          <h3 className="mt-10 text-body font-semibold">{section.title}</h3>
          <ChangeList items={section.items} />
        </section>
      ))}
    </EntryShell>
  )
}
