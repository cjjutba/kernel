import { useEffect, useState } from 'react'
import type { McpAccount, McpServer, Skill } from '@shared/types'
import { call } from '../../../api'
import { PROVIDER_NAME } from '../../../accountRows'
import { useStore } from '../../../store'
import { Button, Toggle } from '../../../ui'
import { NoRoom, Row, RoomPage, Section, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { SignInLine, serverLine, serverName, useMcpAccounts, useSignInAll } from './mcpAccounts'

const failedNames = (a: McpAccount) => a.servers.filter((x) => x.state === 'failed').map((x) => serverName(x.name))

/** Settings > a room > Skills and MCP (SettingsSkills.png). What is off is kept per room in its .kernel settings, so the same skill can be on in one room and off in another. */
export function Skills({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const [skills, setSkills] = useState<Skill[]>([])
  const [mcp, setMcp] = useState<McpServer[]>([])
  const off = rs?.disabled
  const focus = useStore((st) => (st.ui.route.name === 'settings' ? st.ui.route.account : undefined))
  const { accounts, refreshing, refresh } = useMcpAccounts()
  const all = useSignInAll()
  const accountsCount = accounts?.length
  useEffect(() => {
    if (!focus || !accountsCount) return
    const el = document.getElementById(`mcp-signin-${focus}`) ?? document.getElementById(`mcp-account-${focus}`)
    el?.scrollIntoView({ block: 'center' })
    if (el instanceof HTMLButtonElement) el.focus()
  }, [focus, accountsCount])
  useEffect(() => {
    if (!roomId) return
    void call('skills.list', { roomId }).then(setSkills).catch(() => setSkills([]))
    void Promise.all([call('mcp.list', { roomId }), call('mcp.list', { roomId, provider: 'codex' }).catch(() => [])]).then(([claude, codex]) => setMcp([...claude, ...codex])).catch(() => setMcp([]))
  }, [roomId, off?.skills.join('\n'), off?.mcp.join('\n')])
  if (!room || !roomId) return <NoRoom />
  const flip = (kind: 'skills' | 'mcp', name: string, on: boolean) => {
    const list = off?.[kind] ?? []
    void patchRoomSettings(roomId, { disabled: { [kind]: on ? list.filter((n) => n !== name) : [...new Set([...list, name])] } })
  }
  const isOn = (kind: 'skills' | 'mcp', name: string) => !(off?.[kind] ?? []).includes(name)
  return (
    <RoomPage room={room} rs={rs} title="Skills and MCP" intro={`Skills and MCP servers agents can use in ${room.name}.`}>
      <Section title="Skills">
        {skills.length === 0 && <p className="set-empty">No skills found in this repo or your user folders.</p>}
        {skills.map((k) => (
          <Row key={k.name} label={<>/{k.name}</>}>
            <Toggle label={`/${k.name}`} checked={isOn('skills', k.name)} onChange={(v) => flip('skills', k.name, v)} />
          </Row>
        ))}
      </Section>
      <Section title="MCP servers">
        {mcp.length === 0 && <p className="set-empty">No MCP servers configured.</p>}
        {mcp.map((m) => (
          <Row key={`${m.provider ?? 'claude'}:${m.name}`} label={m.provider === 'codex' ? `${m.name} (Codex)` : m.name} desc={serverLine(m.name, m.source === 'claudeai', (accounts ?? []).filter((a) => a.provider === (m.provider ?? 'claude')))}>
            <Toggle label={m.name} checked={isOn('mcp', m.name)} onChange={(v) => flip('mcp', m.name, v)} />
          </Row>
        ))}
      </Section>
      {!!accounts?.length && (
        <Section
          title="MCP sign-ins by account"
          action={<Button busy={refreshing} busyLabel="Checking" disabled={refreshing || all.active !== null} onClick={() => void refresh()}>Check again</Button>}
          note="Sign in to all opens your browser for each server that needs it, one after another."
        >
          {accounts.map((a) => {
            const missing = a.servers.filter((x) => x.state === 'needs-sign-in').map((x) => x.name)
            const claude = a.provider === 'claude'
            return (
              <div key={`${a.provider}:${a.accountId}`} id={`mcp-account-${a.accountId}`} className="set-row">
                <div className="set-text">
                  <span className="set-label">{a.label}</span>
                  <span className="set-desc">{PROVIDER_NAME[a.provider]}{a.error ? '' : a.checkedAt === undefined ? ', checking' : missing.length ? '' : ', every server is ready'}</span>
                  {a.error && <span className="set-desc">Could not check this account: {a.error}</span>}
                  {claude && (
                    <SignInLine
                      label={a.label} servers={missing} run={all.runs[a.accountId]} running={all.active === a.accountId} canceling={all.canceling} disabled={refreshing || all.active !== null}
                      linkId={`mcp-signin-${a.accountId}`} onStart={() => void all.start(a.accountId, a.label)} onCancel={() => void all.cancel()}
                    />
                  )}
                  {failedNames(a).length > 0 && <span className="set-desc">Failed: {failedNames(a).join(', ')}</span>}
                  {!claude && missing.length > 0 && <span className="set-desc">Needs sign-in: {missing.join(', ')}</span>}
                </div>
              </div>
            )
          })}
        </Section>
      )}
    </RoomPage>
  )
}
