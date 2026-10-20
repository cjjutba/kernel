import { Button, CopyButton, FailedState } from '../../ui'
import { ServiceMark } from '../../icons'

/**
 * The GitHub CLI is signed out: what Kernel reads with it, the command that fixes it and Check again (Pen 11.15). Nothing failed that a toast could say, so it raises none.
 * `what` is "issues" or "pull requests".
 */
export function GhSignIn({ what, busy, onCheck }: { what: string; busy?: boolean; onCheck: () => unknown }) {
  return (
    <FailedState
      icon={<ServiceMark name="github" size={18} />} title="Sign in to GitHub"
      action={
        <div className="gh-signin">
          <div className="gh-cmd"><span className="muted">$</span><code>gh auth login</code><span className="grow" /><CopyButton text="gh auth login" label="Copy" box="sm" /></div>
          <Button busy={busy} busyPattern="ripple" busyLabel="Checking" onClick={() => void onCheck()}>Check again</Button>
        </div>
      }
    >
      Kernel reads {what} with the GitHub CLI.
    </FailedState>
  )
}
