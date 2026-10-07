import type { ReactNode } from 'react'

/**
 * A floor card in the shared card pattern: bright border, title, a line of why, optional rows and output, and up to two actions.
 * `quiet` keeps the regular border, for news that needs no answer (FloorReview.png).
 */
export function FloorCard({ title, sub, code, actions, icon, quiet, children }: {
  title: string; sub?: string; code?: string[]; actions: { label: string; primary?: boolean; onClick: () => void }[]
  icon?: ReactNode; quiet?: boolean; children?: ReactNode
}) {
  return (
    <section aria-label={title} className="card tcard fcard" data-quiet={quiet ? 'true' : undefined}>
      <h3>{icon}{title}</h3>
      {sub && <span className="sub">{sub}</span>}
      {children}
      {code && code.length > 0 && <div className="code">{code.join('\n')}</div>}
      {actions.length > 0 && (
        <div className="fcard-acts">
          {actions.map((a) => <button key={a.label} type="button" className={a.primary ? 'btn primary' : 'btn'} onClick={a.onClick}>{a.label}</button>)}
        </div>
      )}
    </section>
  )
}
