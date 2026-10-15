import { actions, go, getState } from '../store'
import { Button, ConfirmDialog, useBusy } from '../ui'
import { patchSettings } from '../screens/settings/useSettings'
import { call } from '../api'

/** Asked once per launch at most, and only until the user answers. */
let asked = false

/**
 * The one question about usage data (TelemetryAsk.png, KERNEL-397). Kernel asks once, after the first project, and only in a
 * build that can send. Nothing goes out until the answer is yes. Don’t share is no. Escape closes without an answer, so it asks again next launch.
 */
export function TelemetryAsk() {
  asked = true
  const [busy, run] = useBusy()
  const answer = (telemetry: 'on' | 'off') => run(telemetry, async () => {
    await patchSettings({ privacy: { telemetry } })
    actions.ui.closeModal()
  })
  const see = () => { actions.ui.closeModal(); go({ name: 'settings', page: 'privacy' }) }
  return (
    <ConfirmDialog
      title="Share usage data with Kernel?"
      body="Kernel can send anonymous usage data: errors, and counts of what goes wrong, like a task it couldn’t hand off. It never sends code, prompts, file paths or names. You can change this in Settings, Privacy."
      confirmLabel="Share usage data" cancelLabel="Don’t share" busy={busy === 'on'} busyLabel="Saving" disabled={busy !== null}
      extra={<Button variant="ghost" size="lg" disabled={busy !== null} onClick={see}>See what’s sent</Button>}
      focusConfirm onConfirm={() => void answer('on')} onCancel={() => void answer('off')} onDismiss={() => actions.ui.closeModal()}
    />
  )
}

/** Opens the question when the app is booted with a project, nothing else is open, and this build can send. Not in Settings, which has the switch. */
export async function askAboutTelemetry() {
  const s = getState()
  if (asked || s.settings?.privacy?.telemetry !== 'ask' || !s.projects.length || s.ui.modal || s.ui.route.name === 'onboarding' || s.ui.route.name === 'settings') return
  const info = await call('app.info', undefined).catch(() => null)
  if (!info?.telemetry || getState().ui.modal) return
  asked = true
  actions.ui.openModal({ name: 'telemetryAsk' })
}
