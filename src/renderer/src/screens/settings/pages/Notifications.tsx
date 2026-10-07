import type { AppSettings } from '@shared/types'
import { actions } from '../../../store'
import { Button, Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

type Events = 'permission' | 'plan' | 'merge' | 'checkFailed' | 'finished' | 'idle'
const EVENTS: [Events, string][] = [
  ['permission', 'An agent asks for permission'], ['plan', 'A plan is ready for review'], ['merge', 'A PR is ready to merge'],
  ['checkFailed', 'A check fails'], ['finished', 'A workspace is finished'], ['idle', 'An agent is idle for 10 minutes']
]
const QUIET = [{ value: 'off', label: 'Off' }, { value: '23:00-07:00', label: '23:00 to 07:00' }, { value: '22:00-08:00', label: '22:00 to 08:00' }, { value: '18:00-09:00', label: '18:00 to 09:00' }]

/** Settings > Notifications (SettingsNotifications.png). Notifications only show while Kernel is in the background. */
export function Notifications({ s }: { s: AppSettings }) {
  const n = s.notifications
  const q = n.quietHours ? `${n.quietHours.from}-${n.quietHours.to}` : 'off'
  const options = QUIET.some((o) => o.value === q) ? QUIET : [...QUIET, { value: q, label: q.replace('-', ' to ') }]
  return (
    <Page title="Notifications">
      <Section title="Notify me when">
        {EVENTS.map(([key, label]) => <Row key={key} label={label}><Toggle label={label} checked={n[key]} onChange={(v) => void patchSettings({ notifications: { [key]: v } })} /></Row>)}
      </Section>
      <Section title="Delivery">
        <Row label="Sound">
          <Select label="Sound" value={n.sound} onChange={(e) => void patchSettings({ notifications: { sound: e.target.value as AppSettings['notifications']['sound'] } })} options={[{ value: 'subtle', label: 'Subtle' }, { value: 'chime', label: 'Chime' }, { value: 'none', label: 'None' }]} />
        </Row>
        <Row label="Quiet hours">
          <Select label="Quiet hours" value={q} options={options} onChange={(e) => {
            const [from, to] = e.target.value.split('-')
            void patchSettings({ notifications: { quietHours: e.target.value === 'off' ? null : { from, to } } })
          }} />
        </Row>
        <Row label="Phone" desc="Approve requests from your iPhone with Remote Control">
          <Button onClick={() => actions.ui.toast({ title: 'Remote Control setup is not available yet' })}>Set up</Button>
        </Row>
      </Section>
    </Page>
  )
}
