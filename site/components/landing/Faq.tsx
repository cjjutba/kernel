'use client'

import { useState } from 'react'

const faqs = [
  {
    q: 'Is Kernel free?',
    a: "Yes. Download it and use it as much as you like. Your agents' usage counts against your own plan, like any other session."
  },
  {
    q: 'Which coding agents does it support?',
    a: 'Claude Code and Codex. Each agent runs on one or the other, and you can sign in to several accounts of each.'
  },
  {
    q: 'What do I need to run it?',
    a: 'A Mac with Apple silicon on macOS 13 or later, Claude Code or Codex signed in to your plan, git, and the GitHub CLI for pull requests. Kernel checks all of this on first launch and tells you how to fix anything missing.'
  },
  {
    q: 'Does my code leave my Mac?',
    a: 'Only the way it already does when you use your agent and push with git. Kernel adds no servers of its own, and the usage data you can turn on never carries code, prompts, paths or names.'
  },
  {
    q: 'Can I change the team?',
    a: "Yes. Agents are plain files in your repo, and a repo that brings its own works as it is. Edit them, add new ones, or retire one you don't need."
  },
  {
    q: 'Does it work on Intel Macs, Windows or Linux?',
    a: 'Not yet. Kernel runs on Macs with Apple silicon today. Leave your email in the waitlist above, and we will write once if that changes.'
  },
  {
    q: 'Can I contribute?',
    a: 'Yes. Issues and pull requests are welcome on GitHub, and the contributing guide explains how to build and test it.'
  }
]

export function Faq() {
  // One answer open at a time. Opening a question closes the one before it, and clicking the open one closes it.
  const [open, setOpen] = useState(0)
  return (
    <section id="faq" aria-labelledby="faq-title" className="mx-auto grid max-w-312 grid-faq items-start gap-16 px-6 pt-40 max-nav:pt-24 max-faq:grid-cols-1 max-faq:gap-10">
      <div>
        <h2 id="faq-title" className="text-h2 text-balance">
          Questions,
          <br />
          answered.
        </h2>
      </div>
      <div>
        {faqs.map((f, i) => (
          <details key={f.q} name="faq" open={open === i} className="group border-t border-line last:border-b">
            <summary
              onClick={(e) => {
                e.preventDefault()
                setOpen(open === i ? -1 : i)
              }}
              className="flex cursor-pointer items-center justify-between gap-6 py-4.5 text-body font-medium text-ink-2 transition-colors group-open:text-ink hover:text-ink"
            >
              {f.q}
              <span aria-hidden="true" className="faq-plus" />
            </summary>
            <p className="-mt-1.5 max-w-155 pr-12 pb-4.5 text-body leading-relaxed text-muted">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
