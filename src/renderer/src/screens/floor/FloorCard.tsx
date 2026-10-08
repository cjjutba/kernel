import type { ReactNode } from 'react'
import { Button } from '../../ui'

/** A card's button. `busy` spins it and says `busyLabel` while its call runs (the caller tracks it with `useBusy`), and disables the card's other buttons. */
export interface FloorAction { label: string; primary?: boolean; onClick: () => void; busy?: boolean; busyLabel?: string }

/**
 * A floor card in the shared card pattern: bright border, title, a line of why, optional rows and output, and up to two actions.
 * `quiet` keeps the regular border, for news that needs no answer (FloorReview.png).
 */
export function FloorCard({ title, sub, code, actions, icon, quiet, children }: {
  title: string; sub?: string; code?: string[]; actions: FloorAction[]
  icon?: ReactNode; quiet?: boolean; children?: ReactNode
}) {
  const busy = actions.some((a) => a.busy)
  return (
    <section aria-label={title} className="card tcard fcard" data-quiet={quiet ? 'true' : undefined}>
      <h3>{icon}{title}</h3>
      {sub && <span className="sub">{sub}</span>}
      {children}
      {code && code.length > 0 && <div className="code">{code.join('\n')}</div>}
      {actions.length > 0 && (
        <div className="fcard-acts">
          {actions.map((a) => <Button key={a.label} variant={a.primary ? 'primary' : 'secondary'} busy={a.busy} busyLabel={a.busyLabel} disabled={busy} onClick={a.onClick}>{a.label}</Button>)}
        </div>
      )}
    </section>
  )
}
