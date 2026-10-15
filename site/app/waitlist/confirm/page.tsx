import Link from 'next/link'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { Dither } from '@/components/ui/Dither'
import { CheckIcon } from '@/components/ui/icons'
import { PLATFORM_LABELS, readToken, waitlistConfig } from '@/lib/waitlist'

// Where the confirm email's link lands. Opening it changes nothing: the button posts to /api/waitlist/confirm, which
// adds the signup and comes back here with ?state= set to how it went. One card over a dithered ripple, rings spreading
// out like a sent signal, worded like the email.

export const metadata: Metadata = { title: { absolute: 'Confirm your email · Kernel' }, robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<{ token?: string; state?: string }> }

const MESSAGES: Record<string, { title: string; text: string }> = {
  done: { title: "You're on the list", text: 'We will email you once, when Kernel supports your platform. Nothing else.' },
  expired: { title: 'This link has expired', text: 'Links work for 3 days. Sign up again and we will send a new one.' },
  invalid: { title: "This link doesn't work", text: 'It may be cut short. Open it from the email again, or sign up again.' },
  error: { title: "We couldn't save that", text: 'Try the link from your email again in a minute. It still works.' }
}

function Card({ children }: { children: ReactNode }) {
  return <div className="map-mac mx-auto max-w-110 rounded-frame border border-line-strong bg-surface-1 px-10 py-11 text-center max-nav:px-6 max-nav:py-9">{children}</div>
}

function list(items: string[]) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

export default async function ConfirmPage({ searchParams }: Props) {
  const { token, state } = await searchParams
  const secret = waitlistConfig().secret
  const read = token && secret ? readToken(token, secret) : null
  let body: ReactNode

  if (read?.ok) {
    const platforms = list(read.claim.platforms.map((p) => PLATFORM_LABELS[p]))
    body = (
      <Card>
        <h1 id="confirm-title" className="text-h3 text-balance">
          Confirm your email
        </h1>
        <p className="mt-3 text-body text-balance text-muted">
          Add <span className="text-ink-2">{read.claim.email}</span> to the waitlist for {platforms}. We will email you once, when Kernel supports it.
        </p>
        <form method="post" action="/api/waitlist/confirm" className="mt-8">
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-ink px-5 text-ui font-medium text-canvas transition-colors hover:bg-white max-nav:w-full">
            Confirm email
          </button>
        </form>
      </Card>
    )
  } else {
    const message = MESSAGES[read ? read.reason : (state ?? 'invalid')] ?? MESSAGES.invalid!
    const done = !read && state === 'done'
    body = (
      <Card>
        {done ? (
          <span className="mx-auto mb-6 flex size-10 items-center justify-center rounded-pill border border-edge bg-surface-2 text-ink">
            <CheckIcon size={16} />
          </span>
        ) : null}
        <h1 id="confirm-title" className="text-h3 text-balance">
          {message.title}
        </h1>
        <p className="mt-3 text-body text-balance text-muted">{message.text}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          <Link href={done ? '/' : '/#waitlist'} className="inline-flex h-10 items-center rounded-lg border border-edge bg-white/2 px-4 text-ui font-medium text-ink transition-colors hover:border-edge-hover hover:bg-white/6">
            {done ? 'Back to Kernel' : 'Sign up again'}
          </Link>
          <Link href="/docs" className="inline-flex h-10 items-center rounded-lg px-4 text-ui font-medium text-muted transition-colors hover:text-ink">
            Read the docs
          </Link>
        </div>
      </Card>
    )
  }

  return (
    <>
      <SiteNav />
      <main id="content" aria-labelledby="confirm-title" className="confirm-stage relative isolate flex items-center overflow-hidden px-6 py-24">
        {/* Rings of dots spreading out from behind the card. The fade is a veil painted over the field rather than a mask
            on it, since a mask on a WebGL canvas inside a clipped box can go missing (globals.css, Dither fields). */}
        <Dither shape="ripple" scale={0.8} speed={0.25} frame={1800} tone="edge" className="absolute inset-0 -z-2" />
        <div aria-hidden="true" className="ripple-veil pointer-events-none absolute inset-0 -z-1" />
        <div className="w-full">{body}</div>
      </main>
      <SiteFooter />
    </>
  )
}
