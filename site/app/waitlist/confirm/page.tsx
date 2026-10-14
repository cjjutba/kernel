import Link from 'next/link'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { CheckIcon } from '@/components/ui/icons'
import { PLATFORM_LABELS, readToken, waitlistConfig } from '@/lib/waitlist'

// Where the confirm email's link lands. Opening it changes nothing: the button posts to /api/waitlist/confirm, which
// adds the signup and comes back here with ?state= set to how it went.

export const metadata: Metadata = { title: { absolute: 'Confirm your email · Kernel' }, robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<{ token?: string; state?: string }> }

const MESSAGES: Record<string, { title: string; text: string }> = {
  done: { title: "You're on the list.", text: 'We will email you once, when Kernel runs on the platform you picked. Nothing else.' },
  expired: { title: 'That link has expired.', text: 'Confirm links last three days. Sign up again and we will send a fresh one.' },
  invalid: { title: "That link doesn't work.", text: 'It may be cut short or changed. Open it from the email again, or sign up again.' },
  error: { title: "We couldn't save that just now.", text: 'Open the link from your email again in a minute. It still works.' }
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-120 rounded-frame border border-line bg-surface-1 p-10 text-center max-nav:p-7">{children}</div>
  )
}

export default async function ConfirmPage({ searchParams }: Props) {
  const { token, state } = await searchParams
  const secret = waitlistConfig().secret
  const read = token && secret ? readToken(token, secret) : null
  let body: ReactNode

  if (read?.ok) {
    const platforms = read.claim.platforms.map((p) => PLATFORM_LABELS[p]).join(', ')
    body = (
      <Card>
        <h1 id="confirm-title" className="text-h3 text-balance">
          Confirm your spot
        </h1>
        <p className="mt-4 text-body text-muted">
          Add <span className="text-ink">{read.claim.email}</span> to the waitlist for {platforms}. We will email you once, when Kernel runs there.
        </p>
        <form method="post" action="/api/waitlist/confirm" className="mt-8">
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-ink px-5 text-body font-medium text-canvas transition-colors hover:bg-white">
            <CheckIcon size={14} />
            Confirm my email
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
          <span className="mx-auto mb-6 inline-flex size-11 items-center justify-center rounded-full border border-edge text-ink">
            <CheckIcon size={18} />
          </span>
        ) : null}
        <h1 id="confirm-title" className="text-h3 text-balance">
          {message.title}
        </h1>
        <p className="mt-4 text-body text-muted">{message.text}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href={done ? '/' : '/#waitlist'} className="inline-flex h-10 items-center rounded-lg border border-edge px-4 text-ui font-medium text-ink transition-colors hover:border-edge-hover hover:bg-white/5">
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
      <main id="content" aria-labelledby="confirm-title" className="relative px-6 pt-32 pb-40">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-130 bg-dots-hero" />
        <div className="relative">{body}</div>
      </main>
      <SiteFooter />
    </>
  )
}
