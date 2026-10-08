import { SectionHead } from '@/components/ui/SectionHead'

const columns = [
  {
    label: 'Plan',
    title: 'Runs on your own plan',
    text: 'Kernel drives your coding agent with the login you already have. No API keys to paste, no extra bill.'
  },
  {
    label: 'Data',
    title: 'Stays on your Mac',
    text: 'Rooms, chats and history live in a local database. The only network calls are your agent, git, GitHub, the update check, and Linear if you connect it.'
  },
  {
    label: 'Code',
    title: 'Public on GitHub',
    text: 'Every line is on GitHub under the Elastic License 2.0. Read it, fork it, or build it yourself.'
  }
]

export function Privacy() {
  return (
    <section id="privacy" aria-labelledby="privacy-title" className="mx-auto max-w-312 px-6 pt-40">
      <SectionHead
        eyebrow="Privacy"
        title="Your Mac. Your plan. Your code."
        titleId="privacy-title"
        lead="No account and no servers of its own. Kernel runs on your machine and the subscription you already have."
      />
      <div className="mt-14 grid grid-auto-fit border-y border-line">
        {columns.map((col) => (
          <div key={col.label} className="p-8 not-first:border-l not-first:border-line first:pl-0 last:pr-0">
            <p className="font-mono text-micro leading-normal font-medium text-faint">{col.label}</p>
            <h3 className="mt-3 text-item">{col.title}</h3>
            <p className="mt-2 text-body leading-relaxed text-muted">{col.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
