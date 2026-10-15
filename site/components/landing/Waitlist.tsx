import Link from 'next/link'
import { KernelMark } from '@/components/brand/KernelMark'
import { WaitlistForm } from './WaitlistForm'

/** The Windows, Linux and Intel Mac waitlist, on the home page and Pricing. `id="waitlist"` is what links point to. */
export function Waitlist({ className = '' }: { className?: string }) {
  return (
    <section id="waitlist" aria-labelledby="waitlist-title" className={`mx-auto max-w-312 px-6 ${className}`}>
      <div className="waitlist-glow relative overflow-hidden rounded-frame border border-line bg-surface-1 px-12 pt-14 pb-10 text-center max-nav:px-5 max-nav:pt-10 max-nav:pb-7">
        <span className="provider-tile mx-auto flex size-12 items-center justify-center rounded-track border border-line-strong text-ink">
          <KernelMark className="h-5 w-auto" />
        </span>
        <h2 id="waitlist-title" className="mt-6 text-h3 text-balance">
          Not on a Mac with Apple silicon?
        </h2>
        <p className="mx-auto mt-3 max-w-120 text-lead text-balance text-muted">
          Kernel runs on Apple silicon today. Leave your email and we will write once, when it runs on yours.
        </p>
        <div className="mt-8">
          <WaitlistForm />
        </div>
        <p className="text-small text-faint">
          One email to confirm, one when it ships. Nothing else.{' '}
          <Link href="/docs/privacy#waitlist" className="text-muted underline decoration-rule underline-offset-3 hover:text-ink">
            Privacy
          </Link>
        </p>
      </div>
    </section>
  )
}
