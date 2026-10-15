import Link from 'next/link'
import { Wordmark } from '@/components/brand/Wordmark'
import { Button } from '@/components/ui/Button'
import { DownloadIcon } from '@/components/ui/icons'
import { StarButton } from '@/components/ui/StarButton'
import { DOWNLOAD_URL } from '@/lib/links'
import { NavFrame } from './NavFrame'

export const NAV_LINKS = [
  { href: '/docs', label: 'Docs' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/changelog', label: 'Changelog' }
] as const

export type NavPath = (typeof NAV_LINKS)[number]['href']

const linkClass = 'inline-flex h-8 items-center rounded-md px-3 text-ui transition-colors hover:bg-white/5 hover:text-ink'

/** `current` marks the section the page belongs to, so a docs page marks Docs. */
export function SiteNav({ current }: { current?: NavPath }) {
  return (
    <NavFrame>
      <div className="mx-auto flex h-16 max-w-312 items-center gap-2 px-6">
        <Link href="/" className="inline-flex items-center">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="ml-8 flex gap-1 max-nav:hidden">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={href === current ? 'page' : undefined}
              className={`${linkClass} ${href === current ? 'bg-white/5 text-ink' : 'text-muted'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <span className="flex-1" />
        <StarButton className="max-nav:hidden" />
        <Button href={DOWNLOAD_URL} icon={<DownloadIcon size={14} />}>
          Download
        </Button>
        {/* On phones the links fold into a menu. A details element opens and closes without any script. */}
        <details className="group relative nav:hidden">
          <summary
            aria-label="Menu"
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-line-strong text-ink-2 transition-colors hover:border-edge-hover hover:text-white"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" className="group-open:hidden" />
              <path d="M4 4l8 8M12 4l-8 8" className="hidden group-open:block" />
            </svg>
          </summary>
          <nav aria-label="Main" className="absolute top-11 right-0 flex w-48 flex-col rounded-lg border border-line-strong bg-surface-2 p-1.5">
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                aria-current={href === current ? 'page' : undefined}
                className={`${linkClass} ${href === current ? 'bg-white/5 text-ink' : 'text-ink-2'}`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </details>
      </div>
    </NavFrame>
  )
}
