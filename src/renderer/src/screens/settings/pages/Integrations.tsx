import './system.css'
import { useEffect, useState, type ReactNode } from 'react'
import type { Integration } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions } from '../../../store'
import { ServiceMark } from '../../../icons'
import { Button, Skeleton, useBusy } from '../../../ui'
import { Page, Row, Section, SettingsLink } from '../kit'
import { forgetLinear, forgetTrackers } from '../../issues/cache'

const Mark = ({ name }: { name: 'github' | 'linear' }) => <span className="sys-logo" aria-hidden="true"><ServiceMark name={name} size={17} /></span>

/**
 * Settings > Integrations (MorePage integrations, KERNEL-680). GitHub is the signed-in gh, and Linear takes an API token that
 * the new workspace modal's Issues tab uses.
 */
export function Integrations() {
  const [rows, setRows] = useState<Integration[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [asking, setAsking] = useState(false)
  const [token, setToken] = useState('')
  const [busy, run] = useBusy<string>()
  const load = () => call('integrations.list', undefined).then((l) => { setRows(l); setFailed(false) }).catch(() => setFailed(true))
  useEffect(() => { void load() }, [])
  const swap = (row: Integration) => setRows((list) => (list ?? []).map((r) => (r.id === row.id ? row : r)))
  const fail = (title: string, e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })
  const close = () => { setAsking(false); setToken('') }
  const github = rows?.find((r) => r.id === 'github')
  const linear = rows?.find((r) => r.id === 'linear')

  const saveLinear = () => run('linear', async () => {
    try { swap(await call('integrations.connect', { id: 'linear', token })); forgetLinear(); forgetTrackers(); close() } catch (e) { fail('Could not connect Linear', e) }
  })
  const disconnectLinear = () => run('linear', async () => {
    try { swap(await call('integrations.connect', { id: 'linear', token: '' })); forgetLinear(); forgetTrackers() } catch (e) { fail('Could not disconnect Linear', e) }
  })
  const manageGithub = () => run('github', async () => {
    try { await call('app.openTerminal', { cwd: (await call('app.info', undefined)).dataDir, command: 'gh auth status' }) } catch (e) { fail('Could not open a terminal', e) }
  })
  const form: ReactNode = asking ? (
    <form className="sys-connect" onSubmit={(e) => { e.preventDefault(); if (token.trim()) void saveLinear() }}>
      <input className="set-token" type="password" autoComplete="off" aria-label="Linear API token" placeholder="lin_api_..." value={token} onChange={(e) => setToken(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy === 'linear'} busyLabel="Connecting" disabled={!token.trim()}>Connect</Button>
      <Button disabled={busy === 'linear'} onClick={close}>Cancel</Button>
    </form>
  ) : undefined
  return (
    <Page title="Integrations">
      <Section label="Services" footnote={<>claude.ai connectors are on <SettingsLink to={{ page: 'mcp' }}>MCP servers</SettingsLink>.</>}>
        {!rows && failed && (
          <Row label="Could not read integrations" desc="Try again in a moment.">
            <Button busy={busy === 'retry'} busyLabel="Trying again" onClick={() => void run('retry', load)}>Try again</Button>
          </Row>
        )}
        {!rows && !failed && (
          <>
            <Row id="github" lead={<Mark name="github" />} label="GitHub" desc={<Skeleton width={160} height={10} />}><Skeleton width={72} height={28} /></Row>
            <Row id="linear" lead={<Mark name="linear" />} label="Linear" desc={<Skeleton width={120} height={10} />}><Skeleton width={72} height={28} /></Row>
          </>
        )}
        {rows && <>
        <Row id="github" lead={<Mark name="github" />} label="GitHub" desc={github?.detail}>
          <Button busy={busy === 'github'} busyLabel="Opening" disabled={busy !== null} onClick={() => void manageGithub()}>Manage</Button>
        </Row>
        <Row id="linear" lead={<Mark name="linear" />} label="Linear" desc={linear?.detail} full={form}>
          {linear?.connected
            ? <Button variant="ghost" busy={busy === 'linear'} busyPattern="scatter" busyLabel="Disconnecting" disabled={busy !== null} onClick={() => void disconnectLinear()}>Disconnect</Button>
            : !asking && <Button disabled={!linear || busy !== null} onClick={() => { close(); setAsking(true) }}>Connect</Button>}
        </Row>
        </>}
      </Section>
    </Page>
  )
}
