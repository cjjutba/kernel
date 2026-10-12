import { useEffect, useMemo, useState } from 'react'
import type { AccountProfile, McpAccount, McpAccountServer, McpServerKind, Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { PROVIDER_NAME } from '../../../accountRows'
import { actions, useStore } from '../../../store'
import { Button, Icon, Pill, Tabs, Toggle, useBusy } from '../../../ui'
import { Section } from '../kit'
import { SignInLine, serverName, useMcpAccounts, useSignInAll } from './mcpAccounts'

// The MCP section of Skills and MCP, one account at a time (KERNEL-647): the account tabs, the summary line, the three groups and
// each row's one status and one action. It is built from the Providers tabs and the settings row, toggle and warning line.

const GROUPS: { kind: McpServerKind; title: string; note?: string }[] = [
  { kind: 'user', title: 'Your servers', note: 'Shared automatically' },
  { kind: 'connector', title: 'claude.ai connectors', note: 'Set up per account' },
  { kind: 'plugin', title: 'Plugins' }
]

const tabId = (a: { provider: Provider; accountId: string }) => `${a.provider}:${a.accountId}`
const needsYou = (s: McpAccountServer) => s.state === 'needs-sign-in' || s.state === 'failed' || (s.state === 'not-set-up' && s.kind === 'connector')

/** "Claude Code · Max", with the nickname after it when the account has one: "Claude Code · Max · Work". */
function tabLabel(a: McpAccount, profile?: AccountProfile) {
  const plan = profile?.plan?.replace(/^(Claude|ChatGPT)\s+/i, '')
  const nickname = profile ? (profile.label !== profile.email ? profile.label : undefined) : a.label
  return [PROVIDER_NAME[a.provider], plan, nickname].filter(Boolean).join(' · ')
}

/** The account the page opens on: the one the notice or Providers named, else the active Claude Code account, else the first. */
function firstTab(accounts: McpAccount[], profiles: AccountProfile[], from?: { provider?: Provider; account?: string }) {
  const named = accounts.find((a) => a.accountId === from?.account && (!from.provider || a.provider === from.provider))
  const active = accounts.find((a) => a.provider === 'claude' && profiles.some((p) => p.provider === a.provider && p.id === a.accountId && p.active))
  return tabId(named ?? active ?? accounts[0])
}

export function McpServers({ isOn, flip }: { isOn: (name: string) => boolean; flip: (name: string, on: boolean) => void }) {
  const { accounts, busy, refreshing, refresh, ignore } = useMcpAccounts()
  const all = useSignInAll()
  const profiles = useStore((st) => st.accounts)
  const from = useStore((st) => (st.ui.route.name === 'settings' ? { provider: st.ui.route.tab, account: st.ui.route.account } : undefined))
  const [picked, pick] = useState<string>()
  const [filter, setFilter] = useState(false)
  const [asking, setAsking] = useState<string>()
  const [open, setOpen] = useState<string[]>([])
  const [working, run] = useBusy<string>()
  const account = accounts?.find((a) => tabId(a) === picked) ?? (accounts?.length ? accounts.find((a) => tabId(a) === firstTab(accounts, profiles, from)) : undefined)
  const key = account && tabId(account)
  useEffect(() => { setAsking(undefined); setOpen([]) }, [key])
  const counts = useMemo(() => {
    const on = account?.servers.filter((s) => s.state !== 'ignored') ?? []
    return { ready: on.filter((s) => s.state === 'ready').length, need: on.filter(needsYou).length, signIns: on.filter((s) => s.state === 'needs-sign-in').length }
  }, [account])

  if (!accounts) return <Section title="MCP servers"><p className="set-empty">Checking MCP servers</p></Section>
  if (!account || !key) return <Section title="MCP servers"><p className="set-empty">No MCP servers configured.</p></Section>

  const { run: signInRun, running } = all.of(account.provider, account.accountId)
  const label = tabLabel(account, profiles.find((p) => p.provider === account.provider && p.id === account.accountId))
  const recheck = () => refresh({ provider: account.provider, accountId: account.accountId })
  const signIn = (server: string) => run(`signin:${server}`, async () => {
    try { await call('accounts.mcpSignIn', { provider: account.provider, accountId: account.accountId, server }) } catch (e) { actions.ui.toast({ title: `Could not sign in to ${serverName(server)}`, sub: cleanError(e) }) }
    await recheck()
  })
  const openConnect = (s: McpAccountServer) => call('system.openExternal', { url: s.connectUrl! }).catch((e) => actions.ui.toast({ title: 'Could not open claude.ai', sub: cleanError(e) }))
  const idle = working === null && busy === null && all.active === null

  const row = (s: McpAccountServer) => {
    const name = serverName(s.name)
    const connect = s.state === 'not-set-up' && s.kind === 'connector' && !!s.connectUrl
    const asked = asking === s.name
    const status = s.state === 'needs-sign-in' ? 'Needs sign-in'
        : s.state === 'failed' ? `Failed${s.error ? `: ${s.error}` : ''}`
          : asked && account.email ? `Sign in to claude.ai as ${account.email} first` : s.note ?? 'Not set up'
    return (
      <div key={s.name} className="set-row set-mcp-row">
        <div className="set-text">
          <span className="set-label">{name}</span>
          {s.state === 'ready' ? (s.note && <span className="set-desc">{s.note}</span>) : <span className="set-warn"><Icon name="warning" size={12} />{status}</span>}
        </div>
        {s.state === 'ready' && <span className="set-desc set-mcp-ready">Ready</span>}
        <div className="set-entry-actions">
          {s.state === 'needs-sign-in' && <Button variant="ghost" aria-label={`Sign in to ${name} on ${label}`} busy={working === `signin:${s.name}`} busyLabel="Signing in" disabled={!idle} onClick={() => void signIn(s.name)}>Sign in</Button>}
          {s.state === 'failed' && <Button variant="ghost" aria-label={`Try ${name} again on ${label}`} busy={busy === key} busyLabel="Checking" disabled={!idle} onClick={() => void recheck()}>Try again</Button>}
          {connect && !asked && <Button variant="ghost" aria-label={`Connect ${name} on ${label}`} disabled={!idle} onClick={() => setAsking(s.name)}>Connect</Button>}
          {connect && asked && (
            <>
              <Button variant="ghost" aria-label={`Open claude.ai to connect ${name}`} onClick={() => void openConnect(s)}>Open claude.ai</Button>
              <Button variant="ghost" aria-label={`Check ${name} again on ${label}`} busy={busy === key} busyLabel="Checking" disabled={!idle} onClick={() => void recheck()}>Check again</Button>
            </>
          )}
          {s.state !== 'ready' && <Button variant="ghost" aria-label={`Ignore ${name} on ${label}`} busy={busy === `ignore:${key}:${s.name}`} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, true)}>Ignore</Button>}
        </div>
        <Toggle label={`${name} in this room`} checked={isOn(s.name)} onChange={(v) => flip(s.name, v)} />
      </div>
    )
  }

  const groups = GROUPS.map((g) => ({ ...g, servers: account.servers.filter((s) => s.kind === g.kind) })).filter((g) => g.servers.length)
  return (
    <Section
      title="MCP servers"
      action={<Button busy={refreshing} busyLabel="Checking" disabled={!idle} onClick={() => void refresh()}>Check again</Button>}
      note="Sign in to all opens your browser for each server that needs it, one after another. The switch turns a server off or on in this room."
    >
      <div className="set-mcp-bar">
        <Tabs label="MCP accounts" value={key} onChange={pick} tabs={accounts.map((a) => ({ id: tabId(a), label: tabLabel(a, profiles.find((p) => p.provider === a.provider && p.id === a.accountId)) }))} />
        <div className="set-mcp-summary">
          <span className="set-desc" role="status">
            {account.error ? `Could not check this account: ${account.error}` : account.checkedAt === undefined ? 'Checking' : `${counts.ready} ready${counts.need ? ` · ${counts.need} need you` : ''}`}
          </span>
          <div className="set-entry-actions">
            {counts.signIns > 0 && !running && <Button variant="ghost" aria-label={`Sign in to all on ${label}`} disabled={!idle} onClick={() => void all.start(account.provider, account.accountId, label)}>Sign in to all</Button>}
            <Pill pressed={filter} aria-label="Show only servers that need action" onClick={() => setFilter(!filter)}>Needs action</Pill>
          </div>
        </div>
        <SignInLine label={label} servers={[]} run={signInRun} running={running} canceling={all.canceling} disabled onStart={() => undefined} onCancel={() => void all.cancel(account.provider)} />
      </div>
      {account.servers.length === 0 && !account.error && <p className="set-empty">No MCP servers configured.</p>}
      {groups.map((g) => {
        const rows = g.servers.filter((s) => s.state !== 'ignored' && (!filter || s.state !== 'ready'))
        const ignored = g.servers.filter((s) => s.state === 'ignored')
        if (!rows.length && !ignored.length) return null
        const unfolded = open.includes(g.kind)
        return (
          <div key={g.kind} className="set-mcp-group" role="group" aria-label={g.title}>
            <div className="set-group set-mcp-head">{g.title}{g.note && <span className="set-desc">{g.note}</span>}</div>
            {rows.map(row)}
            {ignored.length > 0 && (
              <div className="set-mcp-ignored">
                <button type="button" className="set-link" aria-expanded={unfolded} onClick={() => setOpen(unfolded ? open.filter((k) => k !== g.kind) : [...open, g.kind])}>Ignored ({ignored.length})</button>
                {unfolded && ignored.map((s) => (
                  <div key={s.name} className="set-mcp-ignored-row">
                    <span className="set-label">{serverName(s.name)}</span>
                    <Button variant="ghost" aria-label={`Stop ignoring ${serverName(s.name)} on ${label}`} busy={busy === `ignore:${key}:${s.name}`} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, false)}>Undo</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {filter && counts.need === 0 && <p className="set-empty">Nothing needs action on this account.</p>}
    </Section>
  )
}
