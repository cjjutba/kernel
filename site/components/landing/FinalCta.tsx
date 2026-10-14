import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { ArrowIcon, DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL } from '@/lib/links'

// The last ask on the page: one panel with the download beside the three steps from install to the first brief.
// The heading comes first, with no icon above it (tests/e2e/pages.spec.ts).

const STEPS = [
  { title: 'Download Kernel', text: 'Free, for Macs with Apple silicon.', href: '/docs/install' },
  { title: 'Sign in to your agent', text: 'Kernel uses the Claude Code or Codex login you already have.', href: '/docs/accounts' },
  { title: 'Open a repo and brief Kernel', text: 'Approve the plan, and the team builds it.', href: '/docs/first-brief' }
]

/** `version` is the newest release's label, such as "0.4.1". */
export function FinalCta({ version }: { version: string }) {
  return (
    <section aria-labelledby="final-title" className="mx-auto max-w-312 px-6 pt-40 pb-32">
      <div className="frame-gradient">
        <div className="relative overflow-hidden rounded-frame-in bg-surface-1">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-dots-final" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-80 left-1/2 h-130 w-full max-w-225 -translate-x-1/2 glow-final" />
          <div className="relative grid grid-cta items-center gap-x-16 gap-y-12 p-14 max-nav:p-7">
            <div>
              <h2 id="final-title" className="text-display-sm text-balance">
                Put your agents to work.
              </h2>
              <p className="mt-5 max-w-120 text-hero-lead text-muted">
                Install it, open a repo, and brief your lead. The team takes it from there.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />}>
                  Download for macOS
                </Button>
                <Button href="/docs" variant="secondary" size="lg">
                  Read the docs
                </Button>
              </div>
              <Link href="/changelog" className="mt-6 inline-flex items-center gap-1.5 text-small text-faint transition-colors hover:text-ink-2">
                Kernel {version} · Release notes
                <ArrowIcon />
              </Link>
            </div>
            <ol aria-label="Getting started" className="rounded-lg border border-line bg-canvas/60">
              {STEPS.map((s, i) => (
                <li key={s.title} className="border-b border-line-soft last:border-b-0">
                  <Link href={s.href} className="group flex gap-4 p-5 transition-colors hover:bg-white/3">
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-edge font-mono text-badge text-ink-2">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-item text-ink">{s.title}</span>
                      <span className="mt-1 block text-body text-muted">{s.text}</span>
                    </span>
                    <ArrowIcon className="mt-1.5 shrink-0 text-faint transition-colors group-hover:text-ink" />
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}
