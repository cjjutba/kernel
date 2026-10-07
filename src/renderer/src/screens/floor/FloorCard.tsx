/** A floor card in the shared card pattern: bright border, title, a line of why, optional output, and up to two actions. */
export function FloorCard({ title, sub, code, actions }: {
  title: string; sub: string; code?: string[]; actions: { label: string; primary?: boolean; onClick: () => void }[]
}) {
  return (
    <section aria-label={title} className="card tcard fcard">
      <h3>{title}</h3>
      <span className="sub">{sub}</span>
      {code && code.length > 0 && <div className="code">{code.join('\n')}</div>}
      {actions.length > 0 && (
        <div className="fcard-acts">
          {actions.map((a) => <button key={a.label} type="button" className={a.primary ? 'btn primary' : 'btn'} onClick={a.onClick}>{a.label}</button>)}
        </div>
      )}
    </section>
  )
}
