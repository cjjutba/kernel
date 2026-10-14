import './system.css'
import { useEffect, useState, type ReactNode } from 'react'
import type { Integration, JiraAccount } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { Page, Row, Section, SettingsLink } from '../kit'

/** The services' marks, drawn in the ink colour on a 24 pixel grid. */
const MARKS = {
  github: 'M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z',
  linear: 'M2.9 14.6l6.5 6.5A10 10 0 0 1 2.9 14.6zM2.5 11.6l9.9 9.9a10 10 0 0 0 2.4-.4L2.9 9.2a10 10 0 0 0-.4 2.4zM3.7 7.6l12.7 12.7a10 10 0 0 0 1.9-1.2L4.9 5.7a10 10 0 0 0-1.2 1.9zM6.3 4.4A10 10 0 1 1 19.6 17.7z',
  jira: 'M11.53 2 4.5 9.03a1.5 1.5 0 0 0 0 2.12l3.1 3.1 3.93-3.93a2.5 2.5 0 0 0 0-3.54L9.4 4.66 11.53 2Zm.94 8.47 3.93 3.93-3.1 3.1a1.5 1.5 0 0 0 0 2.12L12.47 22l7.03-7.03a1.5 1.5 0 0 0 0-2.12L12.47 5.82a2.5 2.5 0 0 1 0 4.65Z'
} as const

const Mark = ({ name }: { name: keyof typeof MARKS }) => <span className="sys-logo" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d={MARKS[name]} /></svg></span>

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
