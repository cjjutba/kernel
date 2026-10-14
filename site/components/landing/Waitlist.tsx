import Link from 'next/link'
import { WaitlistForm } from './WaitlistForm'

/** The Windows, Linux and Intel Mac waitlist, on the home page and Pricing. `id="waitlist"` is what links point to. */
export function Waitlist({ className = '' }: { className?: string }) {
  return (
    <section id="waitlist" aria-labelledby="waitlist-title" className={`mx-auto max-w-312 px-6 ${className}`}>
      <div className="grid grid-cta items-start gap-x-16 gap-y-10 rounded-frame border border-line bg-surface-1 p-12 max-nav:p-6">
        <div>
          <h2 id="waitlist-title" className="text-h3 text-balance">
            Not on a Mac with Apple silicon?
          </h2>
          <p className="mt-4 max-w-110 text-lead text-muted">
            Kernel runs on Apple silicon today. Tell us what you use, and we will email you once if Kernel comes to it.
          </p>
          <p className="mt-6 max-w-110 text-small leading-relaxed text-faint">
            We send one email to confirm your address, and add you only once you confirm. Your email goes to our mailing
            service, Resend, and nowhere else. More in{' '}
            <Link href="/docs/privacy#waitlist" className="text-muted underline decoration-rule underline-offset-3 hover:text-ink">
              Privacy
            </Link>
            .
          </p>
        </div>
        <WaitlistForm />
      </div>
    </section>
  )
}
