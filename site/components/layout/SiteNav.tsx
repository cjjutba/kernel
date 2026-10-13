import Link from 'next/link'
import { Wordmark } from '@/components/brand/Wordmark'
import { Button } from '@/components/ui/Button'
import { Container } from '@/components/ui/Container'
import { DownloadIcon } from '@/components/ui/icons'
import { StarButton } from '@/components/ui/StarButton'
import { DOWNLOAD_URL } from '@/lib/links'

const links = [
  { href: '/#features', label: 'Features' },
  { href: '/#how', label: 'How it works' },
  { href: '/#privacy', label: 'Privacy' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/changelog', label: 'Changelog' }
]

export function SiteNav({ current }: { current?: '/changelog' }) {
  return (
    <header className="sticky top-0 z-nav border-b border-tint-strong bg-canvas-glass backdrop-blur-nav">
      <Container className="flex h-16 items-center gap-2">
        <Link href="/" className="inline-flex items-center">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="ml-8 flex gap-1 max-nav:hidden">
          {links.map(({ href, label }) => {
            const active = href === current
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex h-8 items-center rounded-md px-3 text-ui transition-colors hover:bg-tint hover:text-ink ${active ? 'bg-tint text-ink' : 'text-muted'}`}
              >
                {label}
              </Link>
            )
          })}
        </nav>
        <span className="flex-1" />
        <StarButton className="max-nav:hidden" />
        <Button href={DOWNLOAD_URL} icon={<DownloadIcon size={14} />}>
          Download
        </Button>
      </Container>
    </header>
  )
}
