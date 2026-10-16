import { DOWNLOAD_URL } from '@/lib/links'
import { Button } from './Button'
import { DownloadIcon } from './icons'

type Props = {
  /** A second button next to the download. */
  secondary?: { href: string; label: string }
  align?: 'start' | 'center'
  /** On phones the buttons span the card, one above the other. */
  stack?: boolean
  className?: string
}

/** The download button, with an optional second one. Shared by the hero, the final CTA and the pricing card. */
export function CtaBlock({ secondary, align = 'start', stack = false, className = '' }: Props) {
  const full = stack ? 'max-nav:w-full' : ''
  return (
    <div className={`flex flex-wrap gap-3 ${align === 'center' ? 'justify-center' : ''} ${stack ? 'max-nav:flex-col' : ''} ${className}`}>
      <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />} className={full}>
        Download for macOS
      </Button>
      {secondary ? (
        <Button href={secondary.href} variant="secondary" size="lg" className={full}>
          {secondary.label}
        </Button>
      ) : null}
    </div>
  )
}
