import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { Waitlist } from '@/components/landing/Waitlist'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { Button } from '@/components/ui/Button'
import { CheckIcon, DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL, LICENSE_URL } from '@/lib/links'
import { pageMetadata } from '@/lib/site'

const title = 'Pricing · Kernel'
const description = 'Kernel is free for now: no subscription, no paywall and no account. Your agents run on the plan you already have.'

export const metadata: Metadata = pageMetadata({ title, description, path: '/pricing' })

const INCLUDED = [
  'Every feature from the first launch',
  'Unlimited rooms and workspaces',
  'Claude Code and Codex, several accounts each',
  'Plans, reviews and merges',
  'Issues from Linear, GitHub and Jira',
  'Every update as it ships'
]

/** What a team pays, and to whom. Kernel's own line is the one that says $0. */
const COSTS = [
  { item: 'Kernel', note: 'No account, subscription or paywall.', cost: '$0' },
  { item: 'Your Claude or ChatGPT plan', note: "Agents' usage counts against it, like any other session.", cost: 'What you pay today' },
  { item: 'API keys, if you add them', note: 'Billed by Anthropic or OpenAI, not by Kernel.', cost: 'Per token' }
]

const link = 'text-ink underline decoration-rule underline-offset-3 hover:text-white'

const QUESTIONS: { q: string; a: ReactNode }[] = [
  { q: 'Will Kernel stay free?', a: 'It is free for now, and there is no paid plan today. If that ever changes, the changelog will say so first.' },
  { q: 'Is there a trial or a limit?', a: 'No. Every feature works from the first launch, on as many repos as you like.' },
  {
    q: 'Do I need an account?',
    a: (
      <>
        No Kernel account. You sign in to Claude Code or Codex, as you would without Kernel. More in{' '}
        <Link href="/docs/accounts" className={link}>
          Accounts
        </Link>
        .
      </>
    )
  },
  {
    q: 'Can I use it for work?',
    a: (
      <>
        Yes. The{' '}
        <a href={LICENSE_URL} target="_blank" rel="noopener" className={link}>
          Elastic License 2.0
        </a>{' '}
        lets you use Kernel for personal and commercial work. It doesn&apos;t let you sell Kernel to others as a hosted
        service.
      </>
    )
  }
]

export default function PricingPage() {
  return (
    <>
      <SiteNav current="/pricing" />
      <main id="content">
        <section aria-labelledby="pricing-title" className="relative pt-32 text-center">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-130 bg-dots-hero" />
          <div className="relative px-6">
            <h1 id="pricing-title" className="text-display-sm text-balance">
              Free for now.
            </h1>
            <p className="mx-auto mt-5 max-w-150 text-hero-lead text-balance text-muted">No subscription, no paywall, no account.</p>
          </div>
        </section>

        <section aria-label="The plan" className="mx-auto mt-14 max-w-250 px-6">
          <div className="frame-gradient">
            <div className="rounded-frame-in bg-surface-1">
              <div className="flex items-end justify-between gap-x-10 gap-y-8 p-10 max-nav:flex-col max-nav:items-start max-nav:p-7">
                <div>
                  <p className="text-item text-ink">Kernel</p>
                  <p className="mt-5 flex items-baseline gap-2.5">
                    <span className="text-display-sm">$0</span>
                    <span className="text-body text-muted">free for now</span>
                  </p>
                  <p className="mt-3 text-small text-faint">For Macs with Apple silicon, on macOS 13 or later.</p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />}>
                    Download for macOS
                  </Button>
                  <Button href="/docs/install" variant="secondary" size="lg">
                    Install guide
                  </Button>
                </div>
              </div>
              <div className="border-t border-line p-10 max-nav:p-7">
                <p className="text-small font-medium text-ink-2">Everything included</p>
                <ul className="mt-5 grid grid-cols-2 gap-x-10 gap-y-3.5 max-nav:grid-cols-1">
                  {INCLUDED.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-body text-ink-2">
                      <CheckIcon size={14} className="mt-1 shrink-0 text-muted" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="costs-title" className="mx-auto max-w-250 px-6 pt-28">
          <h2 id="costs-title" className="text-h3">
            What you pay for
          </h2>
          <dl className="mt-8 border-t border-line">
            {COSTS.map((c) => (
              <div key={c.item} className="flex items-baseline justify-between gap-8 border-b border-line py-5 max-nav:flex-col max-nav:gap-1.5">
                <div>
                  <dt className="text-item text-ink">{c.item}</dt>
                  <dd className="mt-1 text-body text-muted">{c.note}</dd>
                </div>
                <dd className="shrink-0 text-body font-medium text-ink-2">{c.cost}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="pricing-faq-title" className="mx-auto grid max-w-250 grid-faq items-start gap-16 px-6 pt-28 max-faq:grid-cols-1 max-faq:gap-8">
          <h2 id="pricing-faq-title" className="text-h3">
            Questions
          </h2>
          {/* One answer open at a time, with no script: details that share a name close each other. */}
          <div>
            {QUESTIONS.map((x, i) => (
              <details key={x.q} name="pricing-faq" open={i === 0} className="group border-t border-line last:border-b">
                <summary className="flex cursor-pointer items-center justify-between gap-6 py-4.5 text-body font-medium text-ink-2 transition-colors group-open:text-ink hover:text-ink">
                  {x.q}
                  <span aria-hidden="true" className="faq-plus" />
                </summary>
                <p className="-mt-1.5 max-w-155 pr-12 pb-4.5 text-body leading-relaxed text-muted">{x.a}</p>
              </details>
            ))}
          </div>
        </section>

        <Waitlist className="pt-32 pb-32" />
      </main>
      <SiteFooter />
    </>
  )
}
