import { Button } from '@/components/ui/Button'
import { DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL } from '@/lib/links'

// The last ask on the page: the heading and the download, centered in one panel.
// The heading comes first, with no icon above it (tests/e2e/pages.spec.ts).

export function FinalCta() {
  return (
    <section aria-labelledby="final-title" className="mx-auto max-w-312 px-6 pt-40 pb-32 max-nav:pt-24 max-nav:pb-20">
      <div className="frame-gradient">
        <div className="relative overflow-hidden rounded-frame-in bg-surface-1">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-dots-final" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-80 left-1/2 h-130 w-full max-w-225 -translate-x-1/2 glow-final" />
          <div className="relative flex flex-col items-center px-14 py-24 text-center max-nav:px-7 max-nav:py-16">
            <h2 id="final-title" className="text-display-sm text-balance">
              Put your agents to work.
            </h2>
            {/* On phones the two buttons span the panel, one above the other. */}
            <div className="mt-10 flex flex-wrap justify-center gap-3 max-nav:mt-8 max-nav:w-full max-nav:flex-col">
              <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />} className="max-nav:w-full">
                Download for macOS
              </Button>
              <Button href="/docs" variant="secondary" size="lg" className="max-nav:w-full">
                Read the docs
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
