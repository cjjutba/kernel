import './system.css'
import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import type { TelemetryRecord } from '@shared/telemetry'
import { call } from '../../../api'
import { Skeleton, Toggle } from '../../../ui'
import { DataTable, Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { seenAgo } from './Hooks'

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
  useEffect(() => { void call('telemetry.recent', undefined).then((r) => { setRecent(r); setFailed(false) }).catch(() => setFailed(true)) }, [on])
  return (
    <Page title="Privacy" desc="Usage data is off until you turn it on.">
      <Section label="Diagnostics" footnote={canSend === false ? 'This build of Kernel can’t send diagnostics, so nothing leaves this Mac.' : undefined}>
        <Row id="diagnostics" label="Share diagnostics" desc="Errors and counts of what goes wrong. Never your code, prompts or names.">
          <Toggle label="Share diagnostics" checked={on} disabled={canSend === false} onChange={(v) => void patchSettings({ privacy: { telemetry: v ? 'on' : 'off' } })} />
        </Row>
      </Section>
      <Section title="What’s sent" collapsible defaultOpen>
        <Row label="Sent" desc="Kernel and macOS versions, your Mac’s chip, a random install id, event names and fixed values." />
        <Row label="Never sent" desc="Code, diffs, prompts, chats, plans, file paths, and repo, project, branch or agent names." />
      </Section>
      <Section title="Latest events" count={recent?.length} note="Kept on this Mac either way." collapsible defaultOpen plain>
        <DataTable
          label="Latest events" columns={['Event', 'When', 'Status']} grid="minmax(0, 1fr) 140px 100px" empty={recent ? 'No events yet.' : failed ? 'Couldn’t read recent events' : undefined}
          rows={recent
            ? recent.map((r, i) => ({ key: String(i), cells: [<span key="n" className="mono">{r.event.name}</span>, seenAgo(r.at), <span key="s" className={r.sent ? undefined : 'sys-muted'}>{r.sent ? 'Sent' : 'Not sent'}</span>] }))
            : failed ? [] : [0, 1, 2].map((i) => ({ key: `s${i}`, cells: [<Skeleton key="n" width="40%" height={10} />, <Skeleton key="w" width={70} height={10} />, <Skeleton key="s" width={50} height={10} />] }))}
        />
      </Section>
    </Page>
  )
}
