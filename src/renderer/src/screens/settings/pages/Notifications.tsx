import { useRef } from 'react'
import type { AppSettings } from '@shared/types'
import { call } from '../../../api'
import { IconButton, SegmentedControl, Select, Toggle, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import './personal.css'

type Events = 'permission' | 'plan' | 'merge' | 'checkFailed' | 'finished' | 'idle'
type Sound = AppSettings['notifications']['sound']
const NEEDS: [Events, string][] = [['permission', 'An agent asks for permission'], ['plan', 'A plan is ready for review'], ['merge', 'A pull request is ready to merge'], ['checkFailed', 'A check fails']]
const UPDATES: [Events, string][] = [['finished', 'A workspace is finished'], ['idle', 'An agent is idle for 10 minutes']]

/** "23:00" as "11 PM" and "07:30" as "7:30 AM". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const hour = h % 12 || 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}
const window12 = (from: string, to: string) => `${clock(from)} to ${clock(to)}`
const QUIET = [['23:00', '07:00'], ['22:00', '08:00'], ['18:00', '09:00']]

/** Settings > Notifications (SettingsPage.png, page notifications): Needs you, Updates, Delivery (KERNEL-680). Banners show only while Kernel is in the background. */
export function Notifications({ s }: { s: AppSettings }) {
  const n = s.notifications
  const [busy, run] = useBusy()
  // Off keeps the window last picked (or the usual night) in the dropdown, so turning it on again lands where it was.
  const lastWindow = useRef(`${QUIET[1][0]}-${QUIET[1][1]}`)
  if (n.quietHours) lastWindow.current = `${n.quietHours.from}-${n.quietHours.to}`
  const q = lastWindow.current
  const options = QUIET.map(([f, t]) => ({ value: `${f}-${t}`, label: window12(f, t) }))
  if (!options.some((o) => o.value === q)) options.push({ value: q, label: window12(...(q.split('-') as [string, string])) })
  const setQuiet = (v: string) => { const [from, to] = v.split('-'); void patchSettings({ notifications: { quietHours: { from, to } } }) }
  const toggles = (list: [Events, string][]) => list.map(([key, label]) => <Row key={key} id={`notify-${key}`} label={label}><Toggle label={label} checked={n[key]} onChange={(v) => void patchSettings({ notifications: { [key]: v } })} /></Row>)
  return (
    <Page title="Notifications" desc="What Kernel tells you about while you work elsewhere.">
      <Section title="Needs you">{toggles(NEEDS)}</Section>
      <Section title="Updates">{toggles(UPDATES)}</Section>
      <Section title="Delivery">
        <Row id="sound" label="Sound">
          <span className="pe-sound">
            {n.sound !== 'none' && <IconButton icon="play" size={12} label={`Play the ${n.sound} sound`} busy={busy === 'play'} onClick={() => void run('play', () => call('notifications.playSound', { sound: n.sound }).catch(() => undefined))} />}
            <SegmentedControl label="Sound" value={n.sound} onChange={(v) => void patchSettings({ notifications: { sound: v as Sound } })} options={[{ value: 'none', label: 'None' }, { value: 'subtle', label: 'Subtle' }, { value: 'chime', label: 'Chime' }]} />
          </span>
        </Row>
        <Row id="quiet-hours" label="Quiet hours" desc="Notifications wait in the Inbox.">
          <Select label="Quiet hours window" align="right" disabled={!n.quietHours} value={q} options={options} onChange={setQuiet} />
          <Toggle label="Quiet hours" checked={!!n.quietHours} onChange={(v) => { if (v) setQuiet(q); else void patchSettings({ notifications: { quietHours: null } }) }} />
        </Row>
      </Section>
    </Page>
  )
}
