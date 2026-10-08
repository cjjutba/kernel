import { Eyebrow } from '@/components/ui/Eyebrow'
import { ISSUES_URL } from '@/lib/links'

const faqs = [
  {
    q: 'Is Kernel free?',
    a: "Yes. Download it and use it as much as you like. Your agents' usage counts against your own plan, like any other session."
  },
  { q: 'Which coding agents does it support?', a: 'Claude Code today. Support for more agents is on the roadmap.' },
  {
    q: 'What do I need to run it?',
    a: 'A Mac with Apple silicon, Claude Code signed in to a Claude plan, git, and the GitHub CLI for pull requests. Kernel checks all of this on first launch and tells you how to fix anything missing.'
  },
  {
    q: 'Does my code leave my Mac?',
    a: 'Only the way it already does when you use your agent and push with git. Kernel adds no servers of its own.'
  },
  {
    q: 'Can I change the team?',
    a: "Yes. Agents are plain files in your repo. Edit them, add new ones, or retire one you don't need."
  },
  { q: 'Does it work on Intel Macs or Windows?', a: 'Not right now. Kernel is built for Macs with Apple silicon.' },
  {
    q: 'Can I contribute?',
    a: 'Yes. Issues and pull requests are welcome on GitHub, and the contributing guide explains how to build and test it.'
  }
]

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="mx-auto grid max-w-312 grid-faq gap-20 px-6 pt-40 max-faq:grid-cols-1 max-faq:gap-10">
      <div>
        <Eyebrow>FAQ</Eyebrow>
        <h2 id="faq-title" className="mt-4 text-h2 text-balance">
          Questions,
          <br />
          answered.
        </h2>
        <p className="mt-4 text-lead text-muted">
          Something missing?{' '}
          <a
            href={ISSUES_URL}
            target="_blank"
            rel="noopener"
            className="text-ink underline decoration-rule underline-offset-3 hover:text-white"
          >
            Ask on GitHub
          </a>
          .
        </p>
      </div>
      <div>
        {faqs.map((f, i) => (
          <details key={f.q} open={i === 0} className="border-t border-line last:border-b">
            <summary className="flex cursor-pointer items-center justify-between gap-6 py-6 text-callout font-medium text-ink">
              {f.q}
              <span aria-hidden="true" className="faq-plus" />
            </summary>
            <p className="-mt-2 pr-12 pb-6 text-body text-muted">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
