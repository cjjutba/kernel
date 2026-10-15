import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Dither } from '@/components/ui/Dither'
import { ArrowIcon, DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL } from '@/lib/links'
import { HeroDemo } from './HeroDemo'

/** `version` is the newest release's label, such as "0.1". */
export function Hero({ version }: { version: string }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative isolate pt-32 text-center max-nav:pt-20">
      <div className="relative px-6">
        <Link
          href="/changelog"
          className="shimmer-pill inline-flex h-8 items-center gap-2 rounded-pill border border-line-strong bg-surface-2/85 pr-3 pl-1 text-small text-ink-2 hover:border-edge-hover hover:text-white"
        >
          <span className="inline-flex h-6 items-center rounded-pill bg-ink px-2 text-tag font-semibold text-canvas">New</span>
          Kernel {version} is here
          <ArrowIcon className="text-muted" />
        </Link>
        {/* Two set lines on wider screens. On phones the break goes and the heading balances instead of leaving "team." alone. */}
        <h1 id="hero-title" className="mt-8 text-display text-balance max-nav:mt-6">
          Your coding agents,{' '}
          <br className="max-nav:hidden" />
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
          For Macs with Apple silicon
          {/* Only the link stands out: brighter, with an arrow, and underlined on hover. */}
          <span className="mt-1.5 block">
            Not on Apple silicon?{' '}
            <a href="#waitlist" className="group inline-flex items-center gap-1 text-ink-2 transition-colors hover:text-ink">
              <span className="decoration-rule underline-offset-3 group-hover:underline">Get notified</span>
              <ArrowIcon className="text-muted transition-transform group-hover:translate-x-0.5" />
            </a>
          </span>
        </p>
      </div>
      <div className="relative mt-16 px-6 max-nav:mt-12">
        {/* A rolling wave of dots that rises behind the demo and thins out along its sides, gone before the frame's
            bottom, so it never reaches the next section (globals.css, Dither fields). */}
        <Dither shape="wave" scale={1.15} speed={0.35} frame={4000} className="dither-hero absolute inset-x-0 -top-64 -z-1 h-200 max-nav:-top-40 max-nav:h-90" />
        <HeroDemo />
      </div>
    </section>
  )
}
