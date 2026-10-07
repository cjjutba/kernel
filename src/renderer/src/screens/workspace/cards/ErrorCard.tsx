import { Icon } from '../../../ui'
import './cards.css'

/** A turn that failed: the message, the output that explains it, and what to do next (WorkspaceError.png). */
export function ErrorCard({ message, output, agentName, onTerminal, onFix, onRetry }: {
  message: string; output?: string; agentName: string; onTerminal: () => void; onFix: () => void; onRetry: () => void
}) {
  return (
    <section aria-label="Turn failed" className="card tcard" role="alert">
      <h3><span className="err"><Icon name="x" size={15} /></span>{message}</h3>
      {output && <div className="code">{output}</div>}
      <div className="acts">
        <button type="button" className="btn" onClick={onTerminal}>Open terminal</button>
        <button type="button" className="btn" onClick={onRetry}>Retry</button>
        <button type="button" className="btn primary" onClick={onFix}>Ask {agentName} to fix</button>
      </div>
    </section>
  )
}
