import { useEffect, useState } from 'react'
import type { Integration } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'

const ACTION: Record<Integration['id'], { off: string; on: string }> = {
  github: { off: 'Manage', on: 'Manage' },
  linear: { off: 'Connect', on: 'Disconnect' },
  vercel: { off: 'Connect', on: 'Disconnect' },
  remote: { off: 'Set up', on: 'Set up' }
}
/** What a row's button says while it works. Linear's only works when connected, since connecting asks for a token first. */
const BUSY: Record<Integration['id'], string> = { github: 'Opening', linear: 'Disconnecting', vercel: 'Connecting', remote: 'Setting up' }

/** Settings > Integrations (SettingsIntegrations.png). GitHub is the signed-in gh, Linear takes an API token that the new workspace modal's Issues tab uses. */
export function Integrations() {
  const [rows, setRows] = useState<Integration[]>([])
  const [asking, setAsking] = useState(false)
  const [token, setToken] = useState('')
  // 'token' is Save token. A row's own button uses the row's id.
  const [busy, run] = useBusy()
  useEffect(() => { void call('integrations.list', undefined).then(setRows).catch(() => setRows([])) }, [])
  const swap = (row: Integration) => setRows((list) => list.map((r) => (r.id === row.id ? row : r)))
  const fail = (title: string, e: unknown) => actions.ui.toast({ title, sub: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })

  const saveToken = () => run('token', async () => {
    try {
      swap(await call('integrations.connect', { id: 'linear', token }))
      setAsking(false); setToken('')
      actions.ui.toast({ title: 'Linear connected' })
    } catch (e) { fail('Could not connect Linear', e) }
  })
  const press = (r: Integration) => {
    if (r.id === 'linear' && !r.connected) { setAsking(true); return }
    void run(r.id, () => connect(r))
  }
  const connect = async (r: Integration) => {
    if (r.id === 'linear') {
      try { swap(await call('integrations.connect', { id: 'linear', token: '' })); actions.ui.toast({ title: 'Linear disconnected' }) } catch (e) { fail('Could not disconnect Linear', e) }
    } else if (r.id === 'github') {
      try { await call('app.openTerminal', { cwd: (await call('app.info', undefined)).dataDir, command: 'gh auth status' }) } catch (e) { fail('Could not open a terminal', e) }
    } else {
      try { await call('integrations.connect', { id: r.id }) } catch (e) { fail(`Could not set up ${r.name}`, e) }
    }
  }
  return (
    <Page title="Integrations">
      <Section title="Connected">
        {rows.map((r) => (
          <Row key={r.id} label={r.name} desc={r.detail}
            full={r.id === 'linear' && asking ? (
              <form className="set-actions" onSubmit={(e) => { e.preventDefault(); if (token.trim()) void saveToken() }}>
                <input className="set-token" style={{ flex: 1 }} type="password" autoComplete="off" aria-label="Linear API token" placeholder="lin_api_..." value={token} onChange={(e) => setToken(e.target.value)} />
                <Button type="submit" busy={busy === 'token'} busyLabel="Saving" disabled={!token.trim()}>Save token</Button>
                <Button disabled={busy === 'token'} onClick={() => { setAsking(false); setToken('') }}>Cancel</Button>
              </form>
            ) : undefined}>
            <Button busy={busy === r.id} busyLabel={BUSY[r.id]} disabled={r.id === 'vercel' || r.id === 'remote' || busy !== null} title={r.id === 'vercel' || r.id === 'remote' ? 'Not available yet' : undefined} onClick={() => press(r)}>{r.connected ? ACTION[r.id].on : ACTION[r.id].off}</Button>
          </Row>
        ))}
      </Section>
    </Page>
  )
}
