import { Button } from '@/components/ui/Button'
import { DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL } from '@/lib/links'

export function FinalCta() {
  return (
    <section aria-labelledby="final-title" className="relative mt-40 overflow-hidden border-t border-line-faint py-32 text-center">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-dots-final" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-65 left-1/2 h-130 w-full max-w-225 -translate-x-1/2 glow-final"
      />
      <div className="relative z-1 px-6">
        <h2 id="final-title" className="text-display-sm">
          Put your agents to work.
        </h2>
        <p className="mx-auto mt-6 max-w-150 text-hero-lead text-balance text-muted">
          Install it, open a repo, and brief your lead. The team takes it from there.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />}>
            Download for macOS
          </Button>
          <Button href="/changelog" variant="secondary" size="lg">
            Release notes
          </Button>
        </div>
        <p className="mt-4 text-small text-faint">Free · For Macs with Apple silicon</p>
      </div>
    </section>
  )
}
