import Link from 'next/link'
import { Wordmark } from '@/components/brand/Wordmark'
import { ArrowIcon, GitHubIcon } from '@/components/ui/icons'
import { latestRelease } from '@/content/changelog'
import { CONTRIBUTING_URL, DOWNLOAD_URL, ISSUES_URL, LICENSE_URL, RELEASES_URL, REPO_URL, SECURITY_URL } from '@/lib/links'

type FooterLink = { href: string; label: string; external?: boolean }

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { href: DOWNLOAD_URL, label: 'Download' },
      { href: '/docs', label: 'Docs' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/changelog', label: 'Changelog' },
      { href: '/#waitlist', label: 'Waitlist' }
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
      { href: '/docs/privacy', label: 'Privacy' },
      { href: LICENSE_URL, label: 'License', external: true },
      { href: SECURITY_URL, label: 'Security', external: true }
    ]
  }
]

const linkClass = 'block w-fit text-ui text-muted transition-colors hover:text-ink'

/** The site's footer: the brand with the newest release, three columns of links, and the copyright row. */
export async function SiteFooter() {
  const latest = await latestRelease()
  return (
    <footer className="border-t border-line-faint pt-20 pb-10">
      <div className="mx-auto grid max-w-312 grid-footer gap-x-12 gap-y-12 px-6">
        <div>
          <Link href="/" className="inline-flex">
            <Wordmark />
          </Link>
          <p className="mt-4 max-w-70 text-ui leading-relaxed text-muted">Your coding agents, working as a team.</p>
          <Link
            href="/changelog"
            className="mt-6 inline-flex h-7 items-center gap-2 rounded-pill border border-line-strong pr-2.5 pl-1 text-small text-muted transition-colors hover:border-edge-hover hover:text-ink"
          >
            <span className="inline-flex h-5 items-center rounded-pill bg-surface-3 px-2 font-mono text-tag text-ink-2">{latest.version}</span>
            What&apos;s new
            <ArrowIcon className="text-faint" />
          </Link>
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
      <div className="mx-auto mt-16 flex max-w-312 items-center justify-between gap-6 px-6 pt-6 text-small text-faint rule-inset">
        {/* The line wraps on its own, so the GitHub link stays at its right on phones. */}
        <span className="min-w-0">
          © 2026 Christian Jerald Jutba · <span className="whitespace-nowrap">Elastic License 2.0</span>
        </span>
        <a href={REPO_URL} target="_blank" rel="noopener" aria-label="Kernel on GitHub" className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/4 hover:text-ink">
          <GitHubIcon size={16} />
        </a>
      </div>
    </footer>
  )
}
