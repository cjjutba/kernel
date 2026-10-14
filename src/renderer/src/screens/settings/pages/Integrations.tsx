import './system.css'
import { useEffect, useState, type ReactNode } from 'react'
import type { Integration, JiraAccount } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions } from '../../../store'
import { ServiceMark } from '../../../icons'
import { Button, useBusy } from '../../../ui'
import { Page, Row, Section, SettingsLink } from '../kit'

const Mark = ({ name }: { name: 'github' | 'linear' | 'jira' }) => <span className="sys-logo" aria-hidden="true"><ServiceMark name={name} size={17} /></span>

/**
 * Settings > Integrations (MorePage integrations, KERNEL-680). GitHub is the signed-in gh, Linear takes an API token that the
 * new workspace modal's Issues tab uses, and Jira takes a site, an email and an API token (KERNEL-474).
 */
export function Integrations() {
  const [rows, setRows] = useState<Integration[]>([])
  const [jira, setJira] = useState<JiraAccount | null | undefined>(undefined)
  const [asking, setAsking] = useState<'linear' | 'jira' | null>(null)
  const [token, setToken] = useState('')
  const [site, setSite] = useState('')
  const [email, setEmail] = useState('')
  const [busy, run] = useBusy()
  useEffect(() => { void call('integrations.list', undefined).then(setRows).catch(() => setRows([])) }, [])
  // Jira's check reads the account from Jira itself. A refusal leaves it as not connected and says why under the row.
  const [jiraError, setJiraError] = useState<string | null>(null)
  useEffect(() => { void call('jira.test', undefined).then(setJira, (e) => { setJira(null); setJiraError(cleanError(e)) }) }, [])
  const swap = (row: Integration) => setRows((list) => list.map((r) => (r.id === row.id ? row : r)))
  const fail = (title: string, e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })
  const close = () => { setAsking(null); setToken(''); setSite(''); setEmail('') }
  const github = rows.find((r) => r.id === 'github')
  const linear = rows.find((r) => r.id === 'linear')

  const saveLinear = () => run('linear', async () => {
    try { swap(await call('integrations.connect', { id: 'linear', token })); close() } catch (e) { fail('Could not connect Linear', e) }
  })
  const disconnectLinear = () => run('linear', async () => {
    try { swap(await call('integrations.connect', { id: 'linear', token: '' })) } catch (e) { fail('Could not disconnect Linear', e) }
  })
  const saveJira = () => run('jira', async () => {
    try { setJira(await call('jira.connect', { site, email, token })); setJiraError(null); close() } catch (e) { fail('Could not connect Jira', e) }
  })
  const disconnectJira = () => run('jira', async () => {
    try { await call('jira.connect', { site: '', email: '', token: '' }); setJira(null); setJiraError(null) } catch (e) { fail('Could not disconnect Jira', e) }
  })
  const manageGithub = () => run('github', async () => {
    try { await call('app.openTerminal', { cwd: (await call('app.info', undefined)).dataDir, command: 'gh auth status' }) } catch (e) { fail('Could not open a terminal', e) }
  })
  const form = (kind: 'linear' | 'jira'): ReactNode => asking !== kind ? undefined : (
    <form className="sys-jira" onSubmit={(e) => { e.preventDefault(); if (token.trim() && (kind === 'linear' || (site.trim() && email.trim()))) void (kind === 'linear' ? saveLinear() : saveJira()) }}>
      {kind === 'jira' && <input className="set-token" aria-label="Jira site" placeholder="acme.atlassian.net" autoComplete="off" spellCheck={false} value={site} onChange={(e) => setSite(e.target.value)} />}
      {kind === 'jira' && <input className="set-token" type="email" aria-label="Jira email" placeholder="you@example.com" autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />}
      <input className="set-token" type="password" autoComplete="off" aria-label={kind === 'linear' ? 'Linear API token' : 'Jira API token'} placeholder={kind === 'linear' ? 'lin_api_...' : 'API token'} value={token} onChange={(e) => setToken(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy === kind} busyLabel="Connecting" disabled={!token.trim() || (kind === 'jira' && (!site.trim() || !email.trim()))}>Connect</Button>
      <Button disabled={busy === kind} onClick={close}>Cancel</Button>
    </form>
  )
  return (
    <Page title="Integrations">
      <Section label="Services" footnote={<>claude.ai connectors are on <SettingsLink to={{ page: 'mcp' }}>MCP servers</SettingsLink>.</>}>
        <Row id="github" lead={<Mark name="github" />} label="GitHub" desc={github?.detail}>
          <Button busy={busy === 'github'} busyLabel="Opening" disabled={busy !== null} onClick={() => void manageGithub()}>Manage</Button>
        </Row>
        <Row id="linear" lead={<Mark name="linear" />} label="Linear" desc={linear?.detail} full={form('linear')}>
          {linear?.connected
            ? <Button variant="ghost" busy={busy === 'linear'} busyPattern="scatter" busyLabel="Disconnecting" disabled={busy !== null} onClick={() => void disconnectLinear()}>Disconnect</Button>
            : asking !== 'linear' && <Button disabled={!linear || busy !== null} onClick={() => { close(); setAsking('linear') }}>Connect</Button>}
        </Row>
        <Row id="jira" lead={<Mark name="jira" />} label="Jira" desc={jira ? `Connected to ${jira.site} as ${jira.name}. Issues open as workspaces.` : jiraError ?? 'Not connected. Issues open as workspaces once it is.'} full={form('jira')}>
          {jira
            ? <Button variant="ghost" busy={busy === 'jira'} busyPattern="scatter" busyLabel="Disconnecting" disabled={busy !== null} onClick={() => void disconnectJira()}>Disconnect</Button>
            : asking !== 'jira' && <Button disabled={jira === undefined || busy !== null} onClick={() => { close(); setAsking('jira') }}>Connect</Button>}
        </Row>
      </Section>
    </Page>
  )
}
