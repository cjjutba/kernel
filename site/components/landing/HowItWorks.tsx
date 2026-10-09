import type { ReactNode } from 'react'
import { SectionHead } from '@/components/ui/SectionHead'
import { BriefMini, MergeMini, PlanMini } from './StepMinis'

const steps: { num: string; title: string; text: string; visual: ReactNode }[] = [
  {
    num: '01',
    title: 'Brief your lead',
    text: "Tell Rowan what to build in a sentence or two, from Rowan's chat or a new workspace.",
    visual: <BriefMini />
  },
  {
    num: '02',
    title: 'Approve the plan',
    text: 'The work is split into tasks and assigned. Nothing starts until you say so.',
    visual: <PlanMini />
  },
  {
    num: '03',
    title: 'Review and merge',
    text: 'Each agent works on its own branch and opens a pull request. Checks run, you merge.',
    visual: <MergeMini />
  }
]

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="mx-auto max-w-312 px-6 pt-40">
      <SectionHead
        eyebrow="How it works"
        title="From a brief to a merged pull request."
        titleId="how-title"
        lead="You stay the decision maker. Your lead plans, and the team builds in parallel."
      />
      <div className="mt-14 grid grid-auto-fit gap-4">
        {steps.map((s) => (
          <article
            key={s.num}
            className="overflow-hidden rounded-frame border border-line bg-linear-to-b from-surface-2 to-surface-1"
          >
            <div aria-hidden="true" className="flex h-60 items-center border-b border-line-soft p-6 bg-dots-card">
              {s.visual}
            </div>
            <div className="p-6">
              <span className="font-mono text-micro leading-normal font-medium text-faint">{s.num}</span>
              <h3 className="mt-2 text-step-title">{s.title}</h3>
              <p className="mt-2 text-body text-muted">{s.text}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
