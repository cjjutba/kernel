'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { ArrowIcon } from '@/components/ui/icons'
import { WaitlistForm } from './WaitlistForm'

// The Windows, Linux and Intel Mac waitlist, tucked under a download button: one quiet line, "Not on Apple silicon? Get
// notified", that opens the form in place. Links to #waitlist (the hero's, the footer's, the confirm page's) land here
// and open it, so it never has to be a section of its own. The form still posts to /api/waitlist (WaitlistForm).

export function WaitlistReveal({ className = '' }: { className?: string }) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const show = () => {
      setOpen(true)
      // Focus the email once the form has opened, without scrolling past the place the link already brought us to.
      setTimeout(() => box.current?.querySelector<HTMLInputElement>('input[type=email]')?.focus({ preventScroll: true }), 320)
    }
    if (location.hash === '#waitlist') show()
    const onHash = () => location.hash === '#waitlist' && show()
    // A link to #waitlist while the hash is already #waitlist fires no hashchange, so clicks are watched too.
    const onClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest('a')
      if (link && new URL(link.href, location.href).hash === '#waitlist' && link.pathname === location.pathname) show()
    }
    window.addEventListener('hashchange', onHash)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('hashchange', onHash)
      document.removeEventListener('click', onClick)
    }
  }, [])

  return (
    <div id="waitlist" ref={box} className={`scroll-mt-40 ${className}`}>
      <p className="text-small text-faint">
        Not on Apple silicon?{' '}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-form`}
          onClick={() => setOpen((o) => !o)}
          className="group inline-flex items-center gap-1 text-ink-2 transition-colors hover:text-ink"
        >
          <span className="decoration-rule underline-offset-3 group-hover:underline">Get notified</span>
          <ArrowIcon className={`text-muted transition-transform ${open ? 'rotate-90' : 'group-hover:translate-x-0.5'}`} />
        </button>
      </p>
      {/* Opens by growing its row from nothing, so the panel's height eases open with it. */}
      <div id={`${id}-form`} data-open={open || undefined} className="reveal" inert={!open}>
        <div className="min-h-0 overflow-hidden">
          <div className="pt-4 pb-1">
            <WaitlistForm className="max-w-section-lead" />
            <p className="mt-2 text-small text-faint">
              We email you once, when Kernel supports your platform.{' '}
              <Link href="/docs/privacy#waitlist" className="text-muted underline decoration-rule underline-offset-3 hover:text-ink">
                Privacy
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
