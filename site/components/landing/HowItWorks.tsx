import { SectionHead } from '@/components/ui/SectionHead'
import { StepFlow, type Step } from './StepFlow'

const steps: Step[] = [
  {
    num: '01',
    title: 'Brief your lead',
    text: "Tell Kernel what to build in a sentence or two, from Kernel's chat or a new workspace."
  },
  {
    num: '02',
    title: 'Approve the plan',
    text: 'The work is split into tasks and assigned. Nothing starts until you say so.'
  },
  {
    num: '03',
    title: 'Review and merge',
    text: 'Each agent works on its own branch and opens a pull request. Checks run, you merge.'
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
      <StepFlow steps={steps} />
    </section>
  )
}
