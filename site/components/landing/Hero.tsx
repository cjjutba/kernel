import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { ArrowIcon, DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL } from '@/lib/links'
import { HeroDemo } from './HeroDemo'
import { ProviderTiles } from './ProviderTiles'

/** `version` is the newest release's label, such as "0.1". */
export function Hero({ version }: { version: string }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative pt-32 text-center">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-245 bg-dots-hero" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-150 left-1/2 h-140 w-full max-w-300 -translate-x-1/2 glow-hero"
      />
      <ProviderTiles />
      <div className="relative px-6">
        <Link
          href="/changelog"
          className="shimmer-pill inline-flex h-8 items-center gap-2 rounded-pill border border-line-strong bg-surface-2/85 pr-3 pl-1 text-small text-ink-2 hover:border-edge-hover hover:text-white"
        >
          <span className="inline-flex h-6 items-center rounded-pill bg-ink px-2 text-tag font-semibold text-canvas">New</span>
          Kernel {version} is here
          <ArrowIcon className="text-muted" />
        </Link>
        <h1 id="hero-title" className="mt-8 text-display">
          Your coding agents,
          <br />
          working as a team.
        </h1>
        <p className="mx-auto mt-6 max-w-150 text-hero-lead text-balance text-muted">
          Brief a lead, approve the plan, and merge what the team builds.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />}>
            Download for macOS
          </Button>
        </div>
        <p className="mt-4 text-small text-faint">
          Free · For Macs with Apple silicon
          <span className="mt-1.5 block">
            <a href="#waitlist" className="text-muted underline decoration-rule underline-offset-3 transition-colors hover:text-ink">
              Not on one? Join the waitlist
            </a>
          </span>
        </p>
      </div>
      <div className="relative mt-16 px-6">
        <HeroDemo />
      </div>
    </section>
  )
}
