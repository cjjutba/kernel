import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import type { TelemetryRecord } from '@shared/telemetry'
import { call } from '../../../api'
import { Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** One event as the list shows it: when, its name, its values, and whether it left this Mac. */
function parts(r: TelemetryRecord) {
  const { name, ...props } = r.event
  const time = new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return { time, name, values: Object.entries(props).map(([k, v]) => `${k} ${v}`).join(', '), sent: r.sent ? 'sent' : 'kept' }
}

/**
 * Settings > Privacy (SettingsPrivacy.png): usage data is opt-in (KERNEL-397). The switch, what goes with each event, what
 * never leaves the Mac, and the latest events exactly as Kernel keeps them. A build that can't send says so.
 */
export function Privacy({ s }: { s: AppSettings }) {
  const [canSend, setCanSend] = useState<boolean | null>(null)
  const [recent, setRecent] = useState<TelemetryRecord[]>([])
  const on = s.privacy.telemetry === 'on'
  useEffect(() => { void call('app.info', undefined).then((i) => setCanSend(i.telemetry)).catch(() => setCanSend(false)) }, [])
  useEffect(() => { void call('telemetry.recent', undefined).then(setRecent).catch(() => setRecent([])) }, [on])
  return (
    <Page title="Privacy" intro="Kernel can send anonymous usage data, so problems on other Macs show up without anyone filing a bug. Nothing is sent until you turn it on.">
      <Section title="Usage data" note={canSend === false ? 'This build of Kernel can’t send usage data, so nothing leaves this Mac.' : undefined}>
        <Row label="Share usage data" desc="Errors, and counts of what goes wrong, like a task Kernel couldn’t hand off. Sent once a minute.">
          <Toggle label="Share usage data" checked={on} disabled={canSend === false} onChange={(v) => void patchSettings({ privacy: { telemetry: v ? 'on' : 'off' } })} />
        </Row>
      </Section>
      <Section title="What’s sent">
        <Row label="With every event" desc="Kernel’s version, your Mac’s macOS version and chip, and a random install id tied to no account" />
        <Row label="In each event" desc="Its name and a few fixed values, such as why a hand-off was refused. Never free text." />
      </Section>
      <Section title="Never sent">
        <Row label="Your work" desc="Code, diffs and file contents, prompts, chats and plans, and anything Claude Code prints" />
        <Row label="Names" desc="File paths, repo, room, branch and agent names, issue keys, emails and GitHub usernames" />
      </Section>
      <Section title="Latest events" note="Kept on this Mac whether sharing is on or off. Sent means it left this Mac.">
        <Row label="Newest first" desc={recent.length ? undefined : 'No events yet.'} full={recent.length ? (
          <ol className="set-preview set-events" tabIndex={0} aria-label="Latest events">
            {recent.map((r, i) => { const p = parts(r); return <li key={i}><span>{p.time}</span><span>{p.name}</span><span>{p.values}</span><span>{p.sent}</span></li> })}
          </ol>
        ) : undefined} />
      </Section>
    </Page>
  )
}
