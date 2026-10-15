import Link from 'next/link'
import { ArrowIcon } from '@/components/ui/icons'
import { changelogPageHref } from '@/content/changelog'

// The changelog's pages: Newer and Older at the ends, the page numbers between. Page 1 is the newest. With many pages,
// the numbers keep the first, the last and the two around the current page, with an ellipsis for the gaps.

function numbers(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))
  const out: (number | 'gap')[] = []
  for (const n of [...keep].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (typeof last === 'number' && n - last > 1) out.push('gap')
    out.push(n)
  }
  return out
}

const end = 'inline-flex h-9 items-center gap-2 rounded-md px-3 text-ui font-medium'

export function Pager({ page, pages }: { page: number; pages: number }) {
  if (pages <= 1) return null
  const newer = page > 1 ? changelogPageHref(page - 1) : null
  const older = page < pages ? changelogPageHref(page + 1) : null
  return (
    <nav aria-label="Changelog pages" className="flex items-center justify-between gap-4 pt-12">
      {newer ? (
        <Link href={newer} rel="prev" className={`${end} border border-line-strong text-ink-2 transition-colors hover:border-edge-hover hover:text-ink`}>
          <ArrowIcon className="rotate-180 text-muted" />
          Newer
        </Link>
      ) : (
        <span aria-disabled="true" className={`${end} border border-line-faint text-faint`}>
          <ArrowIcon className="rotate-180" />
          Newer
        </span>
      )}
      <ol className="flex items-center gap-1 max-nav:hidden">
        {numbers(page, pages).map((n, i) =>
          n === 'gap' ? (
            <li key={`gap-${i}`} aria-hidden="true" className="w-6 text-center text-ui text-faint">
              …
            </li>
          ) : (
            <li key={n}>
              <Link
                href={changelogPageHref(n)}
                aria-label={`Page ${n}`}
                aria-current={n === page ? 'page' : undefined}
                className={`inline-flex size-9 items-center justify-center rounded-md font-mono text-ui tabular-nums transition-colors ${
                  n === page ? 'border border-edge bg-raised text-ink' : 'text-muted hover:bg-white/4 hover:text-ink'
                }`}
              >
                {n}
              </Link>
            </li>
          )
        )}
      </ol>
      <p className="hidden text-ui text-muted max-nav:block">
        Page {page} of {pages}
      </p>
      {older ? (
        <Link href={older} rel="next" className={`${end} border border-line-strong text-ink-2 transition-colors hover:border-edge-hover hover:text-ink`}>
          Older
          <ArrowIcon className="text-muted" />
        </Link>
      ) : (
        <span aria-disabled="true" className={`${end} border border-line-faint text-faint`}>
          Older
          <ArrowIcon />
        </span>
      )}
    </nav>
  )
}
