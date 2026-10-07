import { useEffect, useState } from 'react'
import type { Integration } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { Button } from '../../../ui'
import { Page, Row, Section } from '../kit'

const ACTION: Record<Integration['id'], { off: string; on: string }> = {
  github: { off: 'Manage', on: 'Manage' },
  linear: { off: 'Connect', on: 'Disconnect' },
  vercel: { off: 'Connect', on: 'Disconnect' },
  remote: { off: 'Set up', on: 'Set up' }
}

/** Settings > Integrations (SettingsIntegrations.png). GitHub is the signed-in gh, Linear takes an API token that the new workspace modal's Issues tab uses. */
export function Integrations() {
  const [rows, setRows] = useState<Integration[]>([])
  const [asking, setAsking] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void call('integrations.list', undefined).then(setRows).catch(() => setRows([])) }, [])
  const swap = (row: Integration) => setRows((list) => list.map((r) => (r.id === row.id ? row : r)))
  const fail = (title: string, e: unknown) => actions.ui.toast({ title, sub: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })

  const saveToken = async () => {
    setBusy(true)
    try {
      swap(await call('integrations.connect', { id: 'linear', token }))
      setAsking(false); setToken('')
      actions.ui.toast({ title: 'Linear connected' })
    } catch (e) { fail('Could not connect Linear', e) }
    setBusy(false)
  }
  const press = async (r: Integration) => {
    if (r.id === 'linear') {
      if (!r.connected) { setAsking(true); return }
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
                <Button type="submit" disabled={busy || !token.trim()}>Save token</Button>
                <Button onClick={() => { setAsking(false); setToken('') }}>Cancel</Button>
              </form>
            ) : undefined}>
            <Button onClick={() => void press(r)}>{r.connected ? ACTION[r.id].on : ACTION[r.id].off}</Button>
          </Row>
        ))}
      </Section>
    </Page>
  )
}
