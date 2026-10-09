import { SectionHead } from '@/components/ui/SectionHead'

const items = [
  {
    title: 'Statuses from real events',
    text: 'See who is working, planning or waiting on you, right in the sidebar. Nothing changes on a timer.'
  },
  {
    title: 'Pull requests, end to end',
    text: 'Create, fix and merge without leaving Kernel. Conflicts and failing checks go straight back to the agent.'
  },
  {
    title: "Your agent's own terminal",
    text: 'Prefer the command line? Open Claude Code in a tab, in the same worktree as your chats.'
  },
  {
    title: 'A team made of plain files',
    text: 'Agents live as files in your repo. Edit them, or ask your lead to hire someone new.'
  },
  {
    title: 'Pause the room',
    text: 'Freeze every agent after its current step with one click, and pick up again when you are ready.'
  },
  {
    title: 'Notifications that matter',
    text: 'A quiet nudge when an agent needs you or a pull request is ready. Nothing else.'
  }
]

export function Details() {
  return (
    <section aria-labelledby="details-title" className="mx-auto max-w-312 px-6 pt-40">
      <SectionHead
        eyebrow="Details"
        title="The small things, done right."
        titleId="details-title"
        align="start"
        className="max-w-160"
      />
      <div className="mt-14 grid grid-auto-fit gap-12">
        {items.map((item) => (
          <div key={item.title} className="border-t border-line-strong pt-6">
            <h3 className="text-item">{item.title}</h3>
            <p className="mt-2 text-body leading-relaxed text-muted">{item.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
