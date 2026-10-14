import Link from 'next/link'
import { KernelMark } from '@/components/brand/KernelMark'
import { Wordmark } from '@/components/brand/Wordmark'
import { CONTRIBUTING_URL, DOWNLOAD_URL, ISSUES_URL, LICENSE_URL, RELEASES_URL, REPO_URL, SECURITY_URL } from '@/lib/links'

type FooterLink = { href: string; label: string; external?: boolean }

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { href: DOWNLOAD_URL, label: 'Download' },
      { href: '/#features', label: 'Features' },
      { href: '/changelog', label: 'Changelog' },
      { href: '/#faq', label: 'FAQ' }
    ]
  },
  {
    title: 'Project',
    links: [
      { href: REPO_URL, label: 'GitHub', external: true },
      { href: RELEASES_URL, label: 'Releases', external: true },
      { href: CONTRIBUTING_URL, label: 'Contributing', external: true },
      { href: ISSUES_URL, label: 'Issues', external: true }
    ]
  },
  {
    title: 'Legal',
    links: [
      { href: LICENSE_URL, label: 'License', external: true },
      { href: SECURITY_URL, label: 'Security', external: true }
    ]
  }
]

const linkClass = 'block w-fit text-ui text-muted transition-colors hover:text-ink'

// One footer per page, so a fixed id is safe.
const FADE_ID = 'kernel-wordmark-fade'

export function SiteFooter() {
  return (
    <footer className="overflow-hidden border-t border-line-faint pt-20">
      <div className="mx-auto grid max-w-312 grid-footer gap-x-12 gap-y-12 px-6">
        <div>
          <Link href="/" className="inline-flex">
            <Wordmark />
          </Link>
          <p className="mt-4 max-w-70 text-ui leading-relaxed text-muted">Your coding agents, working as a team. Free, with the source on GitHub.</p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <h2 className="text-small font-medium text-ink">{col.title}</h2>
            <ul className="mt-4 flex flex-col gap-3">
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.href.startsWith('/') ? (
                    <Link href={l.href} className={linkClass}>
                      {l.label}
                    </Link>
                  ) : (
                    <a href={l.href} className={linkClass} {...(l.external ? { target: '_blank', rel: 'noopener' } : {})}>
                      {l.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="mx-auto mt-16 flex max-w-312 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 pt-6 text-small text-faint rule-inset">
        <span>© 2026 Christian Jerald Jutba</span>
        <span>Elastic License 2.0 · Made for macOS</span>
      </div>
      <div aria-hidden="true" className="mt-14 flex justify-center text-wordmark select-none wordmark-crop">
        <span className="inline-flex items-baseline">
          <KernelMark className="wordmark-k" fill={`url(#${FADE_ID})`}>
            <defs>
              <linearGradient id={FADE_ID} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="stop-wordmark-top" />
                <stop offset="1" className="stop-wordmark-bottom" />
              </linearGradient>
            </defs>
          </KernelMark>
          <span className="text-wordmark-fade">ernel</span>
        </span>
      </div>
    </footer>
  )
}
