import { BranchIcon, CheckIcon, SendIcon } from '@/components/ui/icons'

// Small mockups of the app for the three steps. Decorative: the step text says the same thing.

const mini = 'w-full rounded-lg border border-edge bg-surface-3 px-4 py-3 text-left'
const mono = 'font-mono leading-normal text-faint'
const miniButton = 'inline-flex h-7 flex-1 items-center justify-center rounded-mini border text-micro font-medium'

export function BriefMini() {
  return (
    <div className={mini}>
      <div className="text-ui leading-snug">Add PDF export to invoices. Spec first.</div>
      <div className="mt-6 flex items-center">
        <span className="inline-flex h-6 items-center rounded-chip border border-line-strong bg-chip px-2 text-micro text-ink-2">
          To Rowan · Lead
        </span>
        <span className="flex-1" />
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-ink text-canvas">
          <SendIcon />
        </span>
      </div>
    </div>
  )
}

const tasks = [
  ['T-15a', 'PDF renderer', 'Noor'],
  ['T-15b', 'Download button', 'Kai'],
  ['T-15c', 'Snapshot tests', 'Ivy']
]

export function PlanMini() {
  return (
    <div className={mini}>
      <div className="text-small font-semibold">Rowan&apos;s plan is ready</div>
      <div className="text-micro text-muted">T-15 · Export invoices as PDF</div>
      <div className="mt-3 grid grid-plan-rows gap-y-1 text-micro text-ink-2">
        {tasks.map(([id, title, who]) => (
          <span key={id} className="contents">
            {/* Muted, not faint: faint on this card is 4.3:1, under AA. */}
            <span className="font-mono leading-normal text-muted">{id}</span>
            <span>{title}</span>
            <span className="text-muted">{who}</span>
          </span>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <span className={`${miniButton} border-edge text-ink-2`}>Request changes</span>
        <span className={`${miniButton} border-ink bg-ink text-canvas`}>Approve plan</span>
      </div>
    </div>
  )
}

export function MergeMini() {
  return (
    <div className="flex w-full flex-col gap-3">
      <div className={mini}>
        <div className="flex items-center gap-2 text-small">
          <BranchIcon size={14} className="text-muted" />
          <b className="font-medium">invoice-pdf</b>
          <span className="text-muted">Kai</span>
          <span className="flex-1" />
          <span className={`${mono} text-micro`}>
            <span className="text-add">+212</span> <span className="text-del">-20</span>
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-micro text-muted">
          <CheckIcon className="text-add" />4 checks passed
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 items-center rounded-mini border border-merged-edge px-2 font-mono text-micro leading-normal font-medium text-merged">
          #41
        </span>
        <span className="text-small font-medium text-merged">Merged</span>
        <span className="flex-1" />
        <span className="inline-flex h-7 items-center rounded-mini bg-merged-fill px-3 text-micro font-medium text-white">
          Archive
        </span>
      </div>
    </div>
  )
}
