import { Button } from '@/components/ui/Button'
import { Dither } from '@/components/ui/Dither'
import { DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL } from '@/lib/links'
import { SpotlightGrid } from './SpotlightGrid'
import { WaitlistReveal } from './WaitlistReveal'

// The last ask on the page: the heading and the download on the left, and a dithered sphere slowly turning in the
// light on the right, cropped by the card's edge like a planet rising. On phones the sphere sits behind the card's top.
// Under the buttons, the waitlist for other platforms, closed until asked for (WaitlistReveal).
// The heading comes first, with no icon above it (tests/e2e/pages.spec.ts).

export function FinalCta() {
  return (
    <section aria-labelledby="final-title" className="mx-auto max-w-312 px-6 pt-40 pb-32 max-nav:pt-24 max-nav:pb-20">
      {/* The panel takes the bento's pointer light. */}
      <SpotlightGrid className="">
        <div className="spot-card relative isolate rounded-frame border border-line bg-surface-1">
          {/* Only the sphere is cropped to the card, so the border's pointer light isn't. */}
          <div aria-hidden="true" className="absolute inset-0 -z-1 overflow-hidden rounded-frame-in">
            <Dither
              shape="sphere"
              scale={0.9}
              speed={0.25}
              frame={2500}
              className="dither-sphere absolute -right-20 -bottom-44 size-160 max-faq:-right-40 max-nav:-top-44 max-nav:-right-28 max-nav:bottom-auto max-nav:size-110"
            />
          </div>
          <div className="relative max-w-140 px-14 py-24 max-nav:px-7 max-nav:pt-56 max-nav:pb-10">
            <h2 id="final-title" className="text-display-sm text-balance">
              Put your agents to work.
            </h2>
            <p className="mt-4 text-lead text-muted">Free, for Macs with Apple silicon.</p>
            {/* On phones the two buttons span the card, one above the other. */}
            <div className="mt-10 flex flex-wrap gap-3 max-nav:mt-8 max-nav:flex-col">
              <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />} className="max-nav:w-full">
                Download for macOS
              </Button>
              <Button href="/docs" variant="secondary" size="lg" className="max-nav:w-full">
                Read the docs
              </Button>
            </div>
            <WaitlistReveal className="mt-7" />
          </div>
        </div>
      </SpotlightGrid>
    </section>
  )
}
