import { SectionHead } from '@/components/ui/SectionHead'

const columns = [
  { title: 'Runs on your own plan', text: 'Uses the agent login you already have. No API keys, no extra bill.' },
  { title: 'Stays on your Mac', text: 'Chats and history live in a local database. No account, no servers of ours.' },
  { title: 'Public on GitHub', text: 'Every line is public under the Elastic License 2.0.' }
]

export function Privacy() {
  return (
    <section id="privacy" aria-labelledby="privacy-title" className="mx-auto max-w-312 px-6 pt-40">
      <SectionHead title="Your Mac. Your plan. Your code." titleId="privacy-title" />
      <div className="mt-14 grid grid-cols-3 border-y border-line max-nav:grid-cols-1">
        {columns.map((col) => (
          <div key={col.title} className="p-8 max-faq:p-6 not-first:border-l not-first:border-line first:pl-0 last:pr-0 max-nav:px-0 max-nav:py-6 max-nav:not-first:border-t max-nav:not-first:border-l-0">
            <h3 className="text-item">{col.title}</h3>
            <p className="mt-2 text-body leading-relaxed text-muted">{col.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
