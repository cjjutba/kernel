import { useId } from 'react'
import { Button, Icon, Modal } from '../../../ui'

/**
 * Set up one server (Pen 15.11): what Kernel does in three steps, and the button that opens the server's sign-in in the browser. The server
 * is already added to the account, so the first step is done. The third has no work of its own: a server is on in every project until a project turns it off.
 */
export function McpSignInDialog({ server, label, busy, onClose, onStart }: { server: string; label: string; busy: boolean; onClose: () => void; onStart: () => void }) {
  const id = useId()
  const steps: { state: 'done' | 'now' | 'next'; title: string; text: string }[] = [
    { state: 'done', title: 'Add the server', text: `Kernel adds ${server}’s MCP server to your personal settings.` },
    { state: 'now', title: `Sign in to ${server}`, text: busy ? 'Finish signing in in your browser. Kernel checks again when you are done.' : `Your browser opens ${server}’s sign-in. Come back here when it’s done.` },
    { state: 'next', title: 'Pick the projects that use it', text: 'On for every project, unless a project turns it off.' }
  ]
  return (
    <Modal
      title={`Set up ${server}`} onClose={onClose} width={520} describedBy={`${id}b`}
      footer={<><span className="grow" /><Button variant="ghost" size="lg" data-dismiss disabled={busy}>Later</Button><Button variant="primary" size="lg" busy={busy} busyLabel="Signing in" onClick={onStart}>Open {server} sign-in</Button></>}
    >
      <div id={`${id}b`} className="mcp-one">
        <p className="mcp-one-lead">Agents on {label} use {server} once it is signed in. You sign in once, in your browser, for this Mac.</p>
        <ol className="mcp-steps">
          {steps.map((s, i) => (
            <li key={s.title} className="mcp-step" data-state={s.state}>
              <span className="mcp-step-mark" aria-hidden="true">{s.state === 'done' ? <Icon name="check" size={14} /> : i + 1}</span>
              <span className="mcp-step-text"><span className="set-label">{s.title}</span><span className="set-desc">{s.text}</span></span>
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  )
}
