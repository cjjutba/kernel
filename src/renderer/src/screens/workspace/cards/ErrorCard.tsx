import { Button, Icon, useBusy } from '../../../ui'
import './cards.css'

/** A turn that failed: the message, the output that explains it, and what to do next (WorkspaceError.png). */
export function ErrorCard({ message, output, agentName, onTerminal, onFix, onRetry }: {
  message: string; output?: string; agentName: string; onTerminal: () => Promise<unknown>; onFix: () => Promise<unknown>; onRetry: () => Promise<unknown>
}) {
  const [busy, run] = useBusy<'terminal' | 'retry' | 'fix'>()
  return (
    <section aria-label="Turn failed" className="card tcard" role="alert">
      <h3><span className="err"><Icon name="x" size={15} /></span>{message}</h3>
      {output && <div className="code">{output}</div>}
      <div className="acts">
        <Button busy={busy === 'terminal'} busyLabel="Opening" disabled={busy !== null} onClick={() => void run('terminal', onTerminal)}>Open terminal</Button>
        <Button busy={busy === 'retry'} busyLabel="Retrying" disabled={busy !== null} onClick={() => void run('retry', onRetry)}>Retry</Button>
        <Button variant="primary" busy={busy === 'fix'} busyLabel="Sending" disabled={busy !== null} onClick={() => void run('fix', onFix)}>Ask {agentName} to fix</Button>
      </div>
    </section>
  )
}
