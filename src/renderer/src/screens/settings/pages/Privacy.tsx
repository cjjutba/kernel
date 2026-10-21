import './system.css'
import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import type { TelemetryRecord } from '@shared/telemetry'
import { call, cleanError } from '../../../api'
import { failToast, useRetryKey } from '../../../retry'
import { Skeleton, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { CalmRow } from './CalmRow'

/** "14:02", the time of day an event was kept. */
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * Settings > Privacy (MorePage privacy, KERNEL-680): usage data is opt-in (KERNEL-397). The switch, then what's sent and the latest
 * events exactly as Kernel keeps them, each folded. A build that can't send says so.
 */
export function Privacy({ s }: { s: AppSettings }) {
  const [canSend, setCanSend] = useState<boolean | null>(null)
  const [recent, setRecent] = useState<TelemetryRecord[] | null>(null)
  const [failed, setFailed] = useState(false)
  const on = s.privacy.telemetry === 'on'
  useEffect(() => { void call('app.info', undefined).then((i) => setCanSend(i.telemetry)).catch(() => setCanSend(false)) }, [])
  // A read that fails keeps the list Kernel last knew, and the row says so while the toast carries the error.
  const load = () => call('telemetry.recent', undefined).then((r) => { setRecent(r); setFailed(false) }).catch((e: unknown) => { setFailed(true); failToast("Couldn't read the latest events", cleanError(e), 'telemetry') })
  useRetryKey('telemetry', load)
  useEffect(() => { void load() }, [on])
  return (
    <Page title="Privacy" desc="Usage data is off until you turn it on.">
      <Section title="Diagnostics" footnote={canSend === false ? 'This build of Kernel can’t send diagnostics, so nothing leaves this Mac.' : undefined}>
        <Row id="diagnostics" label="Share diagnostics" desc="Errors and counts of what goes wrong. Never your code, prompts or names.">
          <Toggle label="Share diagnostics" checked={on} disabled={canSend === false} onChange={(v) => void patchSettings({ privacy: { telemetry: v ? 'on' : 'off' } })} />
        </Row>
      </Section>
      <Section title="What’s sent">
        <Row label="Sent" desc="Kernel and macOS versions, your Mac’s chip, a random install id, event names and fixed values." />
        <Row label="Never sent" desc="Code, diffs, prompts, chats, plans, file paths, and repo, project, branch or agent names." />
      </Section>
      <Section title="Latest events" note="Kept on this Mac either way.">
        {recent
          ? recent.length
            ? recent.map((r, i) => (
              <div key={i} className="sys-event">
                <span className="sys-event-name">{r.event.name}</span>
                <span className={r.sent ? 'sys-event-state' : 'sys-event-state sys-muted'}>{r.sent ? 'Sent' : 'Kept on this Mac'}</span>
                <span className="sys-event-time">{clock(r.at)}</span>
              </div>
            ))
            : <div className="set-empty">No events yet.</div>
          : failed
            ? <CalmRow title="Couldn't read the latest events" sub="Kernel keeps what it last knew." onRetry={load} />
            : [0, 1, 2].map((i) => <div key={i} className="sys-event"><Skeleton width="30%" height={10} /></div>)}
      </Section>
    </Page>
  )
}
