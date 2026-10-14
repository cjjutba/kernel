import Link from 'next/link'
import type { Metadata } from 'next'
import { Waitlist } from '@/components/landing/Waitlist'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { Button } from '@/components/ui/Button'
import { ArrowIcon, CheckIcon, DownloadIcon } from '@/components/ui/icons'
import { DOWNLOAD_URL, LICENSE_URL } from '@/lib/links'
import { pageMetadata } from '@/lib/site'

const title = 'Pricing · Kernel'
const description = 'Kernel is free for now: no subscription, no paywall and no account. Your agents run on the plan you already have.'

export const metadata: Metadata = pageMetadata({ title, description, path: '/pricing' })

const INCLUDED = [
  'Every feature, from the first launch',
  'As many rooms and workspaces as you like',
  'Claude Code and Codex agents, with several accounts each',
  'Plans, reviews and merges',
  'Issues from Linear, GitHub Issues and Jira',
  'Updates as they ship'
]

const COSTS = [
  { title: 'Your agent plan', text: "Agents run on your Claude or ChatGPT plan. Their usage counts against it, like any other session." },
  { title: 'API keys, if you add them', text: 'An Anthropic or OpenAI key bills per token, by that provider, not by Kernel.' },
  { title: 'Kernel itself', text: 'Nothing. There is no Kernel account, subscription or paywall.' }
]

const QUESTIONS = [
  {
    q: 'Will Kernel stay free?',
    a: 'It is free for now, and there is no paid plan today. If that ever changes, the changelog will say so first.'
  },
  { q: 'Is there a trial or a limit?', a: 'No. Every feature works from the first launch, on as many repos as you like.' },
  { q: 'Do I need an account?', a: 'No Kernel account. You sign in to Claude Code or Codex, as you would without Kernel.' },
  {
    q: 'Can I use it for work?',
    a: "Yes. The Elastic License 2.0 lets you use Kernel for personal and commercial work. It doesn't let you sell Kernel to others as a hosted service."
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
            <p className="mx-auto mt-6 max-w-150 text-hero-lead text-balance text-muted">
              No subscription, no paywall and no account. Your agents run on the Claude or ChatGPT plan you already have.
            </p>
          </div>
        </section>

        <section aria-label="The plan" className="mx-auto mt-16 max-w-250 px-6">
          <div className="frame-gradient">
            <div className="grid grid-cta gap-x-14 gap-y-10 rounded-frame-in bg-surface-1 p-12 max-nav:p-7">
              <div>
                <p className="text-item text-ink">Kernel</p>
                <p className="mt-6 flex items-baseline gap-2">
                  <span className="text-display-sm">$0</span>
                  <span className="text-body text-muted">free for now</span>
                </p>
                <p className="mt-4 text-body text-muted">For Macs with Apple silicon, on macOS 13 or later.</p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />}>
                    Download for macOS
                  </Button>
                  <Button href="/docs/install" variant="secondary" size="lg">
                    Install guide
                  </Button>
                </div>
              </div>
              <div>
                <p className="text-small font-medium text-ink-2">Everything included</p>
                <ul className="mt-4 flex flex-col gap-3">
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
          <div className="mt-8 grid grid-cols-3 border-y border-line max-faq:grid-cols-1">
            {COSTS.map((c) => (
              <div key={c.title} className="p-7 not-first:border-l not-first:border-line first:pl-0 last:pr-0 max-faq:px-0 max-faq:py-6 max-faq:not-first:border-t max-faq:not-first:border-l-0">
                <h3 className="text-item">{c.title}</h3>
                <p className="mt-2 text-body leading-relaxed text-muted">{c.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="pricing-faq-title" className="mx-auto max-w-250 px-6 pt-28">
          <h2 id="pricing-faq-title" className="text-h3">
            Questions
          </h2>
          <dl className="mt-8 grid grid-cols-2 gap-x-14 gap-y-10 max-faq:grid-cols-1">
            {QUESTIONS.map((x) => (
              <div key={x.q}>
                <dt className="text-item text-ink">{x.q}</dt>
                <dd className="mt-2 text-body leading-relaxed text-muted">{x.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-12 flex flex-wrap gap-x-6 gap-y-2 text-ui">
            <Link href="/docs/accounts" className="inline-flex items-center gap-1.5 font-medium text-muted transition-colors hover:text-ink">
              Accounts and usage in the docs
              <ArrowIcon />
            </Link>
            <a href={LICENSE_URL} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 font-medium text-muted transition-colors hover:text-ink">
              Read the license
              <ArrowIcon />
            </a>
          </p>
        </section>

        <Waitlist className="pt-28 pb-32" />
      </main>
      <SiteFooter />
    </>
  )
}
