import { useMemo } from 'react'
import type { McpAccount } from '@shared/types'
import { go } from '../../../store'
import { Toggle } from '../../../ui'
import { Row } from '../kit'
import { serverName, useMcpAccounts } from './mcpAccounts'

// A room's MCP servers (KERNEL-661): one switch per server with a one-word status. Signing in happens in Settings, MCP servers.

type Status = 'Ready' | 'Needs you' | 'Off'

/** The server across every account: Needs you if any account is waiting on it, Off when every account has it off, else Ready. */
function statusOf(accounts: McpAccount[], name: string, on: boolean): Status {
  if (!on) return 'Off'
  const states = accounts.flatMap((a) => a.servers.filter((s) => s.name === name))
  if (states.some((s) => (s.state === 'needs-sign-in' || s.state === 'failed' || s.state === 'not-set-up') && !s.roomOff)) return 'Needs you'
  return states.length && states.every((s) => s.state === 'off') ? 'Off' : 'Ready'
}

export function RoomMcp({ isOn, flip }: { isOn: (name: string) => boolean; flip: (name: string, on: boolean) => void }) {
  const { accounts } = useMcpAccounts()
  const names = useMemo(() => [...new Set((accounts ?? []).flatMap((a) => a.servers.map((s) => s.name)))], [accounts])
  return (
    <section className="set-section">
      <h2>MCP servers</h2>
      <p className="set-note set-mcp-manage">
        Manage sign-ins in <button type="button" className="set-link" onClick={() => go({ name: 'settings', page: 'mcp' })}>Settings › MCP servers</button>
      </p>
      <div className="set-card">
        {!accounts && <p className="set-empty">Checking MCP servers</p>}
        {accounts && names.length === 0 && <p className="set-empty">No MCP servers configured.</p>}
        {names.map((name) => (
          <Row key={name} label={serverName(name)}>
            <span className="set-desc set-mcp-status">{statusOf(accounts ?? [], name, isOn(name))}</span>
            <Toggle label={`${serverName(name)} in this room`} checked={isOn(name)} onChange={(v) => flip(name, v)} />
          </Row>
        ))}
      </div>
    </section>
  )
}
