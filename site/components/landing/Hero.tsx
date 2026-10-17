import Link from 'next/link'
import { Dither } from '@/components/ui/Dither'
import { ArrowIcon } from '@/components/ui/icons'
import { HeroDemo } from './HeroDemo'
import { Badge } from '@/components/ui/Badge'
import { CtaBlock } from '@/components/ui/CtaBlock'

/** `version` is the newest release's label, such as "0.1". */
export function Hero({ version }: { version: string }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative isolate pt-32 text-center max-nav:pt-20">
      <div className="relative px-6">
        <Link
          href="/changelog"
          className="shimmer-pill inline-flex h-8 items-center gap-2 rounded-pill border border-line-strong bg-surface-2-glass pr-3 pl-1 text-small text-ink-2 hover:border-edge-hover hover:text-white"
        >
          <Badge>New</Badge>
          Kernel {version} is here
          <ArrowIcon className="text-muted" />
        </Link>
        {/* Two set lines on wider screens. On phones the break goes and the heading balances instead of leaving "organized" alone. */}
        <h1 id="hero-title" className="mt-8 text-display text-balance max-nav:mt-6">
          Your AI coding agents,{' '}
          <br className="max-nav:hidden" />
          finally organized
        </h1>
        <p className="mx-auto mt-6 max-w-lead text-hero-lead text-balance text-muted">
          Say what you need, and Kernel plans it, hands it out and brings it back for your approval
        </p>
        <CtaBlock align="center" className="mt-10" />
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
        <Dither shape="wave" scale={1.15} speed={0.35} frame={4000} className="dither-hero absolute inset-x-0 -top-dither-hero-rise -z-raise h-dither-hero max-nav:-top-40 max-nav:h-dither-hero-phone" />
        <HeroDemo />
      </div>
    </section>
  )
}
