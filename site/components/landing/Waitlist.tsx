import Link from 'next/link'
import { WaitlistForm } from './WaitlistForm'

/** The Windows, Linux and Intel Mac waitlist, on the home page and Pricing. `id="waitlist"` is what links point to. */
export function Waitlist({ className = '' }: { className?: string }) {
  return (
    <section id="waitlist" aria-labelledby="waitlist-title" className={`mx-auto max-w-312 px-6 text-center ${className}`}>
      <h2 id="waitlist-title" className="text-h3 text-balance">
        Not on a Mac with Apple silicon?
      </h2>
      <div className="mt-8">
        <WaitlistForm />
      </div>
      <p className="text-small text-faint">
        One email when Kernel runs on yours.{' '}
        <Link href="/docs/privacy#waitlist" className="text-muted underline decoration-rule underline-offset-3 hover:text-ink">
          Privacy
        </Link>
      </p>
    </section>
  )
}
