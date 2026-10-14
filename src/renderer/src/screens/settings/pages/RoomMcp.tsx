import { useMemo } from 'react'
import type { McpAccount } from '@shared/types'
import { Toggle } from '../../../ui'
import { Row, Section, SettingsLink } from '../kit'
import { serverName, useMcpAccounts } from './mcpAccounts'

// A room's MCP servers (KERNEL-661): one switch per server. A status shows only when the server needs you (KERNEL-680). Signing in happens in Settings, MCP servers.

/** The server across every account: does any account that has it on wait on a sign-in, or fail to start? */
function problemOf(accounts: McpAccount[], name: string, on: boolean): string | undefined {
  if (!on) return undefined
  const states = accounts.flatMap((a) => a.servers.filter((s) => s.name === name && !s.roomOff))
  if (states.some((s) => s.state === 'failed')) return 'Failed to start'
  if (states.some((s) => s.state === 'needs-sign-in' || s.state === 'not-set-up')) return 'Needs sign-in'
  return undefined
}

export function RoomMcp({ isOn, flip }: { isOn: (name: string) => boolean; flip: (name: string, on: boolean) => void }) {
  const { accounts } = useMcpAccounts()
  const names = useMemo(() => [...new Set((accounts ?? []).flatMap((a) => a.servers.map((s) => s.name)))], [accounts])
  return (
    <Section title="MCP servers" count={names.length || undefined} scope="mac" note={<>Sign-ins are on <SettingsLink to={{ page: 'mcp' }}>Settings, MCP servers</SettingsLink>.</>}>
      {!accounts && <p className="set-empty">Checking MCP servers</p>}
      {accounts && names.length === 0 && <p className="set-empty">No MCP servers yet. Add one in <SettingsLink to={{ page: 'mcp' }}>Settings, MCP servers</SettingsLink>.</p>}
      {names.map((name) => {
        const problem = problemOf(accounts ?? [], name, isOn(name))
        return (
          <Row key={name} label={<span className="mono">{serverName(name)}</span>} desc={problem}>
            <Toggle label={`${serverName(name)} in this room`} checked={isOn(name)} onChange={(v) => flip(name, v)} />
          </Row>
        )
      })}
    </Section>
  )
}
