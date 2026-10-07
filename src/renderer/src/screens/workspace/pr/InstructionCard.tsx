import type { ChatPart } from '@shared/types'
import './pr.css'

/** A PR instruction file Kernel sent to the agent ("create-pr.md sent", WorkspaceDraftPR.png). Shows the file as sent. */
export function InstructionCard({ part }: { part: Extract<ChatPart, { type: 'file' }> }) {
  const lines = (part.text ?? '').split('\n').filter((l) => l.trim())
  return (
    <section className="pr-sent" aria-label={`${part.name} sent`}>
      <div className="pr-sent-head"><span className="mono">{part.name}</span><span className="muted">sent</span></div>
      <div className="pr-sent-body">{lines.map((l, i) => <span key={i}>{l}</span>)}</div>
    </section>
  )
}
