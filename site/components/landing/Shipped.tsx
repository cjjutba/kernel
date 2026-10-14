import Link from 'next/link'
import { ArrowIcon } from '@/components/ui/icons'
import { SectionHead } from '@/components/ui/SectionHead'
import { publishedChangelog } from '@/content/changelog'
import { formatDate } from '@/lib/format'
import type { Release } from '@/lib/schema'

// The three newest published releases, each linking to its entry on the changelog. A patch release has no title of its
// own ("Kernel 0.4.1"), so its card counts the changes and quotes the first one.

const SHOWN = 3

function card(release: Release) {
  const changes = release.sections.flatMap((s) => s.items)
  const named = !/^Kernel \d/.test(release.title)
  return {
    title: named ? release.title : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`,
    text: named && release.intro ? release.intro : changes[0]!.text.replace(/\s*\(#\d+\)$/, '')
  }
}

export async function Shipped() {
  const releases = (await publishedChangelog()).releases.slice(0, SHOWN)
  return (
    <section id="shipped" aria-labelledby="shipped-title" className="mx-auto max-w-312 px-6 pt-40">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHead align="start" title="Recently shipped." titleId="shipped-title" lead="Small releases, often, each with its notes." />
        <Link href="/changelog" className="inline-flex items-center gap-1.5 text-link font-medium text-muted transition-colors hover:text-ink">
          All release notes
          <ArrowIcon />
        </Link>
      </div>
      <ul className="mt-12 grid grid-auto-fit gap-4">
        {releases.map((r) => {
          const { title, text } = card(r)
          return (
            <li key={r.version}>
              <Link
                href={`/changelog#v${r.version.replaceAll('.', '')}`}
                className="flex h-full flex-col rounded-lg border border-line bg-surface-1 p-6 transition-colors hover:border-edge"
              >
                <span className="flex items-center gap-2.5">
                  <span className="inline-flex h-6 items-center rounded-chip border border-edge bg-raised px-2 font-mono text-micro leading-normal font-medium text-ink">
                    {r.version}
                  </span>
                  <time dateTime={r.date} className="text-label text-muted">
                    {formatDate(r.date)}
                  </time>
                </span>
                <span className="mt-5 text-item text-ink">{title}</span>
                <span className="mt-2 line-clamp-3 text-body text-muted">{text}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
