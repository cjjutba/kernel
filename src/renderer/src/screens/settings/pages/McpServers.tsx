import { useEffect, useMemo, useState } from 'react'
import type { AccountProfile, McpAccount, McpAccountServer, McpServerKind, Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { PROVIDER_NAME } from '../../../accountRows'
import { actions, useStore } from '../../../store'
import { Button, Icon, Tabs, useBusy } from '../../../ui'
import { Page } from '../kit'
import { SignInLine, serverName, useMcpAccounts, useSignInAll } from './mcpAccounts'

// Settings, Agents, MCP servers (KERNEL-661): every account's servers, one account at a time, built from the Providers tabs and the
// settings row. What needs the user shows one status and one action. What is ready folds into one line per group.

const GROUPS: { kind: McpServerKind; title: string; note?: string }[] = [
  { kind: 'user', title: 'Your servers', note: 'Shared automatically' },
  { kind: 'connector', title: 'claude.ai connectors', note: 'Set up on claude.ai, for each account' },
  { kind: 'plugin', title: 'Plugins' }
]

const tabId = (a: { provider: Provider; accountId: string }) => `${a.provider}:${a.accountId}`
const neutral = (s: McpAccountServer) => s.state === 'off' || (!!s.roomOff && s.state !== 'ready' && s.state !== 'ignored')

/** The Codex accounts whose servers read the same show as one tab, led by the first of them. */
function visibleAccounts(accounts: McpAccount[]) {
  return accounts.filter((a, i) => !accounts.slice(0, i).some((b) => b.provider === a.provider && b.sharedWith?.includes(a.accountId)))
}

/** "Claude Code · Max", with the nickname after it when the account has one: "Claude Code · Max · Work". One Codex tab for accounts that share. */
function tabLabel(a: McpAccount, profile?: AccountProfile) {
  if (a.sharedWith?.length) return PROVIDER_NAME[a.provider]
  const plan = profile?.plan?.replace(/^(Claude|ChatGPT)\s+/i, '')
  const nickname = profile ? (profile.label !== profile.email ? profile.label : undefined) : a.label
  return [PROVIDER_NAME[a.provider], plan, nickname].filter(Boolean).join(' · ')
}

/** The account the page opens on: the one the notice or Providers named, else the active Claude Code account, else the first. */
function firstTab(accounts: McpAccount[], profiles: AccountProfile[], from?: { provider?: Provider; account?: string }) {
  const named = accounts.find((a) => (a.accountId === from?.account || a.sharedWith?.includes(from?.account ?? '')) && (!from?.provider || a.provider === from.provider))
  const active = accounts.find((a) => a.provider === 'claude' && profiles.some((p) => p.provider === a.provider && p.id === a.accountId && p.active))
  return tabId(named ?? active ?? accounts[0])
}

export function McpServers() {
  const { accounts: all, busy, refresh, ignore } = useMcpAccounts()
  const runs = useSignInAll()
  const profiles = useStore((st) => st.accounts)
  const from = useStore((st) => (st.ui.route.name === 'settings' ? { provider: st.ui.route.tab, account: st.ui.route.account } : undefined))
  const [picked, pick] = useState<string>()
  const [asking, setAsking] = useState<string>()
  const [open, setOpen] = useState<string[]>([])
  const [working, run] = useBusy<string>()
  const accounts = useMemo(() => (all ? visibleAccounts(all) : undefined), [all])
  const account = accounts?.find((a) => tabId(a) === picked) ?? (accounts?.length ? accounts.find((a) => tabId(a) === firstTab(accounts, profiles, from)) : undefined)
  const key = account && tabId(account)
  useEffect(() => { setAsking(undefined); setOpen([]) }, [key])
  const profile = (a: McpAccount) => profiles.find((p) => p.provider === a.provider && p.id === a.accountId)

  if (!accounts) return <Page title="MCP servers"><p className="set-empty">Checking MCP servers</p></Page>
  if (!account || !key) return <Page title="MCP servers"><p className="set-empty">No MCP servers configured.</p></Page>

  const label = tabLabel(account, profile(account))
  const idle = working === null && busy === null && runs.active === null
  const recheck = () => refresh({ provider: account.provider, accountId: account.accountId })
  const signIn = (server: string) => run(`signin:${server}`, async () => {
    try { await call('accounts.mcpSignIn', { provider: account.provider, accountId: account.accountId, server }) } catch (e) { actions.ui.toast({ title: `Could not sign in to ${serverName(server)}`, sub: cleanError(e) }) }
    await recheck()
  })
  const openConnect = (s: McpAccountServer) => call('system.openExternal', { url: s.connectUrl! }).catch((e) => actions.ui.toast({ title: 'Could not open claude.ai', sub: cleanError(e) }))
  const setUp = () => actions.ui.openModal({ name: 'mcpSetUp', provider: account.provider, accountId: account.accountId })
  const toggle = (id: string) => setOpen(open.includes(id) ? open.filter((k) => k !== id) : [...open, id])

  const row = (s: McpAccountServer) => {
    const name = serverName(s.name)
    if (s.state === 'ready' || neutral(s)) {
      return (
        <div key={s.name} className="set-row set-mcp-row">
          <div className="set-text">
            <span className="set-label">{name}</span>
            {s.state === 'off' && s.note ? <span className="set-desc">{s.note}</span> : s.roomOff && s.state !== 'ready' ? <span className="set-desc">Off in every room</span> : s.note && <span className="set-desc">{s.note}</span>}
          </div>
          <span className="set-desc set-mcp-ready">{s.state === 'ready' ? 'Ready' : 'Off'}</span>
        </div>
      )
    }
    const connect = s.state === 'not-set-up' && s.kind === 'connector' && !!s.connectUrl
    const asked = asking === s.name
    const status = s.state === 'needs-sign-in' ? 'Needs sign-in'
      : s.state === 'failed' ? `Failed${s.error ? `: ${s.error}` : ''}`
        : asked && account.email ? `Sign in to claude.ai as ${account.email} first` : s.kind === 'connector' ? 'Not set up' : s.note ?? 'Not set up'
    return (
      <div key={s.name} className="set-row set-mcp-row">
        <div className="set-text">
          <span className="set-label">{name}</span>
          <span className="set-warn"><Icon name="warning" size={12} />{status}</span>
        </div>
        <div className="set-entry-actions">
          {s.state === 'needs-sign-in' && <Button variant="ghost" aria-label={`Sign in to ${name} on ${label}`} busy={working === `signin:${s.name}`} busyLabel="Signing in" disabled={!idle} onClick={() => void signIn(s.name)}>Sign in</Button>}
          {s.state === 'failed' && <Button variant="ghost" aria-label={`Try ${name} again on ${label}`} busy={busy === key} busyLabel="Checking" disabled={!idle} onClick={() => void recheck()}>Try again</Button>}
          {connect && !asked && <Button variant="ghost" aria-label={`Connect ${name} on ${label}`} disabled={!idle} onClick={() => setAsking(s.name)}>Connect</Button>}
          {connect && asked && <Button variant="ghost" aria-label={`Open claude.ai to connect ${name}`} onClick={() => void openConnect(s)}>Open claude.ai</Button>}
          <Button variant="ghost" aria-label={`Ignore ${name} on ${label}`} busy={busy === `ignore:${account.provider}:${account.accountId}:${s.name}`} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, true)}>Ignore</Button>
        </div>
      </div>
    )
  }

  const groups = GROUPS.map((g) => ({ ...g, servers: account.servers.filter((s) => s.kind === g.kind) })).filter((g) => g.servers.length)
  const summary = account.error ? `Could not check this account: ${account.error}` : account.checkedAt === undefined ? 'Checking' : `${account.ready} ready${account.needsYou ? ` · ${account.needsYou} ${account.needsYou === 1 ? 'needs' : 'need'} you` : ''}`
  return (
    <Page title="MCP servers" intro="Every account's MCP servers in one place. Kernel checks again when you come back to this window.">
      <section className="set-section">
        <div className="set-card">
          <div className="set-mcp-bar">
            <Tabs label="MCP accounts" value={key} onChange={pick} tabs={accounts.map((a) => ({ id: tabId(a), label: tabLabel(a, profile(a)) }))} />
            <div className="set-mcp-summary">
              <span className="set-desc" role="status">{summary}</span>
              {account.needsYou > 0 && <Button aria-label={`Set up ${label}`} disabled={!idle} onClick={setUp}>Set up this account</Button>}
            </div>
            <SignInLine label={label} needs={0} {...runs.of(account.provider, account.accountId)} canceling={runs.canceling} disabled onSetUp={setUp} onCancel={() => void runs.cancel(account.provider)} />
          </div>
          {account.servers.length === 0 && !account.error && <p className="set-empty">No MCP servers configured.</p>}
          {groups.map((g) => {
            const ready = g.servers.filter((s) => s.state === 'ready')
            const rows = g.servers.filter((s) => s.state !== 'ready' && s.state !== 'ignored')
            const ignored = g.servers.filter((s) => s.state === 'ignored')
            const readyOpen = open.includes(`ready:${g.kind}`)
            const ignoredOpen = open.includes(`ignored:${g.kind}`)
            return (
              <div key={g.kind} className="set-mcp-group" role="group" aria-label={g.title}>
                <div className="set-group set-mcp-head">{g.title}{g.note && <span className="set-desc">{g.note}</span>}</div>
                {rows.map(row)}
                {ready.length > 0 && (
                  <div className="set-mcp-ignored">
                    <button type="button" className="set-link" aria-expanded={readyOpen} onClick={() => toggle(`ready:${g.kind}`)}>{ready.length} ready</button>
                  </div>
                )}
                {readyOpen && ready.map(row)}
                {ignored.length > 0 && (
                  <div className="set-mcp-ignored">
                    <button type="button" className="set-link" aria-expanded={ignoredOpen} onClick={() => toggle(`ignored:${g.kind}`)}>Ignored ({ignored.length})</button>
                    {ignoredOpen && ignored.map((s) => (
                      <div key={s.name} className="set-mcp-ignored-row">
                        <span className="set-label">{serverName(s.name)}</span>
                        <Button variant="ghost" aria-label={`Stop ignoring ${serverName(s.name)} on ${label}`} busy={busy === `ignore:${account.provider}:${account.accountId}:${s.name}`} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, false)}>Undo</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </Page>
  )
}
