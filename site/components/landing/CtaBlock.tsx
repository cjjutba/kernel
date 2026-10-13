import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL } from '@/lib/links'

/** The lead, the download button next to `secondary`, and the small print. Shared by the hero and the final CTA. */
export function CtaBlock({ lead, secondary }: { lead: ReactNode; secondary: ReactNode }) {
  return (
    <>
      <p className="mx-auto mt-6 max-w-lead text-hero-lead text-balance text-muted">{lead}</p>
      <div className="mt-10 flex flex-wrap justify-center gap-3">
        <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />}>
          Download for macOS
        </Button>
        {secondary}
      </div>
      <p className="mt-4 text-small text-faint">Free · For Macs with Apple silicon</p>
    </>
  )
}
