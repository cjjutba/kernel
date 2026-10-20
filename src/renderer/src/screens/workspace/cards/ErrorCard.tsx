import { AgentAvatar, Button, Icon, useBusy } from '../../../ui'
import './cards.css'

/** A turn that failed: the message, the output that explains it, and what to do next (WorkspaceError.png). */
export function ErrorCard({ message, output, agentName, onTerminal, onFix, onRetry }: {
  message: string; output?: string; agentName: string; onTerminal: () => Promise<unknown>; onFix: () => Promise<unknown>; onRetry: () => Promise<unknown>
}) {
  const [busy, run] = useBusy<'terminal' | 'retry' | 'fix'>()
  return (
    <section aria-label="Turn failed" className="card tcard" role="alert">
      <div className="tc-head"><AgentAvatar name={agentName} size={18} /><h3><span className="err"><Icon name="close" size={16} /></span>{message}</h3></div>
      {output && <div className="tc-body"><div className="code">{output}</div></div>}
      <div className="tc-foot">
        <Button busy={busy === 'terminal'} busyLabel="Opening" disabled={busy !== null} onClick={() => void run('terminal', onTerminal)}>Open terminal</Button>
        <Button busy={busy === 'retry'} busyPattern="ripple" busyLabel="Retrying" disabled={busy !== null} onClick={() => void run('retry', onRetry)}>Retry</Button>
        <Button variant="primary" busy={busy === 'fix'} busyPattern="ripple" busyLabel="Sending" disabled={busy !== null} onClick={() => void run('fix', onFix)}>Ask {agentName} to fix</Button>
      </div>
    </section>
  )
}
