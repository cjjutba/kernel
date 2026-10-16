import { Dither } from '@/components/ui/Dither'
import { SpotlightGrid } from './SpotlightGrid'
import { WaitlistReveal } from './WaitlistReveal'
import { CtaBlock } from '@/components/ui/CtaBlock'
import { Section } from '@/components/ui/Container'

// The last ask on the page: the heading and the download on the left, and a dithered sphere slowly turning in the
// light on the right, cropped by the card's edge like a planet rising. On phones the sphere sits behind the card's top.
// Under the buttons, the waitlist for other platforms, closed until asked for (WaitlistReveal).
// The heading comes first, with no icon above it (tests/e2e/pages.spec.ts).

export function FinalCta() {
  return (
    <Section aria-labelledby="final-title" className="pb-32 max-nav:pb-20">
      {/* The panel takes the bento's pointer light. */}
      <SpotlightGrid className="">
        <div className="spot-card relative isolate rounded-frame border border-line bg-surface-1">
          {/* Only the sphere is cropped to the card, so the border's pointer light isn't. */}
          <div aria-hidden="true" className="absolute inset-0 -z-raise overflow-hidden rounded-frame-in">
            <Dither
              shape="sphere"
              scale={0.9}
              speed={0.25}
              frame={2500}
              className="dither-sphere absolute -right-20 -bottom-sphere-drop size-sphere max-faq:-right-40 max-nav:-top-sphere-drop max-nav:-right-sphere-bleed max-nav:bottom-auto max-nav:size-sphere-phone"
            />
          </div>
          <div className="relative max-w-section-lead px-14 py-24 max-nav:px-7 max-nav:pt-sphere-clear max-nav:pb-10">
            <h2 id="final-title" className="text-display-sm text-balance">
              Put your agents to work.
            </h2>
            <p className="mt-4 text-lead text-muted">Free, for Macs with Apple silicon.</p>
            {/* On phones the two buttons span the card, one above the other. */}
            <CtaBlock stack secondary={{ href: '/docs', label: 'Read the docs' }} className="mt-10 max-nav:mt-8" />
            <WaitlistReveal className="mt-7" />
          </div>
        </div>
      </SpotlightGrid>
    </Section>
  )
}
