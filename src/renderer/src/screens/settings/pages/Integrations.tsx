import './system.css'
import { useEffect, useState, type ReactNode } from 'react'
import type { Integration } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions } from '../../../store'
import { failToast, useRetryKey } from '../../../retry'
import { ServiceMark } from '../../../icons'
import { Button, Icon, LoadingRow, Skeleton, useBusy } from '../../../ui'
import { Page, Row, Section, SettingsLink } from '../kit'
import { forgetLinear, forgetTrackers } from '../../issues/cache'
import { CalmRow } from './CalmRow'

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
  // A read that fails leaves a calm row, and the toast carries the error and its Try again.
  const load = () => call('integrations.list', undefined).then((l) => { setRows(l); setFailed(false) }).catch((e: unknown) => { setFailed(true); failToast("Couldn't read integrations", cleanError(e), 'integrations') })
  useRetryKey('integrations', load)
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
      <Button variant="ghost" disabled={busy === 'linear'} onClick={close}>Cancel</Button>
      <Button type="submit" variant="primary" busy={busy === 'linear'} busyLabel="Connecting" disabled={!token.trim()}>Connect</Button>
    </form>
  ) : undefined
  const state = (r: Integration | undefined) => r?.connected
    ? <span className="set-result" data-state="ok"><Icon name="check" size={12} />Connected</span>
    : r && <span className="set-result" data-state="unchecked">Not connected</span>
  return (
    <Page title="Integrations" desc="The services Kernel reads issues and pull requests from.">
      <Section title="Services" note={<>Kernel uses the GitHub CLI’s sign-in. Linear takes an API token. <SettingsLink variant="quiet" to={{ page: 'mcp' }}>MCP servers</SettingsLink><Icon name="ext" size={12} /></>}>
        {!rows && failed && <CalmRow title="Couldn't read integrations" sub="Kernel keeps what it last knew." onRetry={load} />}
        {!rows && !failed && (
          <>
            {[['38%', '24%'], ['30%', '24%'], ['42%', '24%']].map(([title, sub], i) => (
              <div key={i} className="sys-skel">
                <Skeleton width={36} height={36} />
                <span className="sys-skel-text"><Skeleton width={title} height={10} /><Skeleton width={sub} height={10} /></span>
              </div>
            ))}
            <LoadingRow what="integrations" inline />
          </>
        )}
        {rows && <>
        <Row id="github" lead={<Mark name="github" />} label="GitHub" desc={github?.detail}>
          {state(github)}
          <Button busy={busy === 'github'} busyLabel="Opening" disabled={busy !== null} onClick={() => void manageGithub()}>Manage</Button>
        </Row>
        <Row id="linear" lead={<Mark name="linear" />} label="Linear" desc={asking ? 'Paste a personal API key from Linear, Settings, Security.' : linear?.detail} full={form}>
          {!asking && state(linear)}
          {linear?.connected
            ? <Button busy={busy === 'linear'} busyPattern="ripple" busyLabel="Disconnecting" disabled={busy !== null} onClick={() => void disconnectLinear()}>Disconnect</Button>
            : !asking && <Button disabled={!linear || busy !== null} onClick={() => { close(); setAsking(true) }}>Connect</Button>}
        </Row>
        </>}
      </Section>
    </Page>
  )
}
