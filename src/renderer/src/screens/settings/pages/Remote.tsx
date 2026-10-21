import './system.css'
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, RemoteDevice, RemotePairing, RemoteStatus } from '@shared/types'
import { call, cleanError } from '../../../api'
import { failToast, useRetryKey } from '../../../retry'
import { actions } from '../../../store'
import { Button, SegmentedControl, Toggle, useBusy } from '../../../ui'
import { CopyButton } from '../../../ui/CopyButton'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { CalmRow } from './CalmRow'
import { seenAgo } from './Hooks'

/** How often the device list is read while a pairing code is on screen, so a device that pairs shows up. */
const WATCH_MS = 3000

const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })

/**
 * Settings > Remote access (remote-access-server): the switch, who can reach the server, the address it listens on, and the devices
 * paired with it. A pairing code shows as a link and a QR code, good once for 5 minutes. A paired device can't change any of
 * this: the server refuses it every `remote.*` channel and the `remote` setting.
 */
export function Remote({ s }: { s: AppSettings }) {
  const r = s.remote
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null)
  const [pairing, setPairing] = useState<RemotePairing | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, run] = useBusy<'pair' | `revoke-${string}`>()

  const loadDevices = useCallback(() => call('remote.devices', undefined).then((d) => { setDevices(d); setFailed(false) }).catch((e: unknown) => { setFailed(true); failToast("Couldn't read the paired devices", cleanError(e), 'remote') }), [])
  useRetryKey('remote', loadDevices)
  // The server follows the setting a moment after it changes, so the status is read again for each value of it.
  useEffect(() => {
    let live = true
    void call('remote.status', undefined).then((x) => { if (live) setStatus(x) }).catch(() => undefined)
    if (!r.enabled) setPairing(null)
    return () => { live = false }
  }, [r.enabled, r.host, r.port])
  useEffect(() => { void loadDevices() }, [loadDevices, r.enabled])
  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => void loadDevices(), WATCH_MS)
    return () => clearInterval(t)
  }, [pairing, loadDevices])

  const running = !!status?.running
  const pair = () => run('pair', async () => {
    try { setPairing(await call('remote.pair', undefined)) } catch (e) { actions.ui.toast({ title: 'Could not make a pairing code', sub: cleanError(e) }) }
  })
  const revoke = (d: RemoteDevice) => run(`revoke-${d.id}`, async () => {
    try { await call('remote.revoke', { id: d.id }); await loadDevices() } catch (e) { actions.ui.toast({ title: 'Could not revoke the device', sub: cleanError(e) }) }
  })
  const movedTo = status?.running && status.port !== undefined && status.port !== r.port ? status.port : undefined
  const where = !r.enabled ? 'Off' : status?.error ? status.error : status?.url ?? 'Starting'

  return (
    <Page title="Remote access" desc="Drive Kernel from a phone or another computer. It is off until you turn it on.">
      <Section title="Server">
        <Row id="remote-enabled" label="Let other devices connect" desc="Kernel runs a small server on this Mac. Only a device you pair can use it.">
          <Toggle label="Let other devices connect" checked={r.enabled} onChange={(v) => void patchSettings({ remote: { enabled: v } })} />
        </Row>
        <Row id="remote-host" label="Who can reach it" desc={r.host === 'network' ? 'Anyone on your network can open the page, and only a paired device gets in. Other devices connect over plain HTTP, so use it on networks you trust, or through Tailscale.' : 'Only this Mac can open it.'}>
          <SegmentedControl label="Who can reach it" value={r.host} onChange={(v) => void patchSettings({ remote: { host: v as AppSettings['remote']['host'] } })} options={[{ value: 'local', label: 'This Mac only' }, { value: 'network', label: 'Other devices on my network' }]} />
        </Row>
        <Row id="remote-url" label="Address" desc={movedTo ? `Port ${r.port} is in use, so Kernel uses ${movedTo}.` : status?.error ? 'Kernel could not start the server.' : undefined}>
          <span className="rem-url">
            <span className={status?.error ? 'rem-address sys-muted' : 'rem-address'}>{status?.error ? 'Not running' : where}</span>
            {running && status.url && <CopyButton text={status.url} label="Copy address" />}
          </span>
        </Row>
      </Section>
      <Section title="Paired devices" count={devices?.length ? devices.length : undefined} action={<Button disabled={!running || busy !== null} busy={busy === 'pair'} busyLabel="Making a code" onClick={() => void pair()}>Pair a device</Button>}>
        {pairing && running && (
          <div className="rem-pair" role="group" aria-label="Pair a device">
            <img className="rem-qr" alt="QR code for the pairing link" src={`data:image/svg+xml;base64,${btoa(pairing.qr)}`} width={148} height={148} />
            <div className="rem-pair-text">
              <span className="set-label">Scan the code, or open the link on the device</span>
              <span className="rem-link"><code className="rem-code">{pairing.url}</code><CopyButton text={pairing.url} label="Copy pairing link" /></span>
              <span className="set-desc">Works once, for 5 minutes. Anyone with the link can pair until then.</span>
              <span><Button onClick={() => setPairing(null)}>Done</Button></span>
            </div>
          </div>
        )}
        {devices
          ? devices.length
            ? devices.map((d) => (
              <Row key={d.id} label={d.name} desc={`${d.connected ? 'Connected now' : `Last seen ${seenAgo(d.lastSeenAt).toLowerCase()}`}. Paired ${day(d.createdAt)}.`}>
                <Button busy={busy === `revoke-${d.id}`} busyLabel="Revoking" disabled={busy !== null} onClick={() => void revoke(d)}>Revoke</Button>
              </Row>
            ))
            : !pairing && <div className="set-empty">No devices paired yet.</div>
          : failed ? <CalmRow title="Couldn't read the paired devices" sub="Kernel keeps what it last knew." onRetry={loadDevices} /> : <div className="set-empty">Loading</div>}
      </Section>
    </Page>
  )
}
