import Link from 'next/link'
import { KernelMark } from '@/components/brand/KernelMark'
import { Wordmark } from '@/components/brand/Wordmark'
import { Container } from '@/components/ui/Container'
import { ExternalLink } from '@/components/ui/ExternalLink'
import { CONTRIBUTING_URL, DOWNLOAD_URL, ISSUES_URL, LICENSE_URL, REPO_URL, SECURITY_URL } from '@/lib/links'

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

const linkClass = 'mt-3 block text-ui text-muted transition-colors hover:text-ink'

// One footer per page, so a fixed id is safe.
const FADE_ID = 'kernel-wordmark-fade'

export function SiteFooter() {
  return (
    <footer className="overflow-hidden border-t border-line-faint pt-16">
      <Container className="flex flex-wrap justify-between gap-12">
        <div>
          <Link href="/" className="inline-flex">
            <Wordmark />
          </Link>
          <p className="mt-4 max-w-tagline text-ui leading-relaxed text-muted">Your coding agents, working as a team.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-20">
          {columns.map((col) => (
            <div key={col.title}>
              <h2 className="text-small font-medium text-ink">{col.title}</h2>
              {col.links.map((l) =>
                l.href.startsWith('/') ? (
                  <Link key={l.label} href={l.href} className={linkClass}>
                    {l.label}
                  </Link>
                ) : l.external ? (
                  <ExternalLink key={l.label} href={l.href} className={linkClass}>
                    {l.label}
                  </ExternalLink>
                ) : (
                  <a key={l.label} href={l.href} className={linkClass}>
                    {l.label}
                  </a>
                )
              )}
            </div>
          ))}
        </nav>
      </Container>
      <Container className="mt-16 flex flex-wrap justify-between gap-4 pt-6 text-small text-faint rule-inset">
        <span>© 2026 Christian Jerald Jutba</span>
        <span>Elastic License 2.0</span>
      </Container>
      <div aria-hidden="true" className="mt-12 flex justify-center text-wordmark select-none wordmark-crop">
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
