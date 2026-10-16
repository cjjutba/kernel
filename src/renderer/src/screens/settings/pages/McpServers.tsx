import './agents.css'
import { useEffect, useMemo, useState } from 'react'
import type { AccountProfile, McpAccount, McpAccountServer, Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { PROVIDER_NAME } from '../../../accountRows'
import { actions, useStore } from '../../../store'
import { Button, Icon, Select, useBusy } from '../../../ui'
import { ago } from '../../projects/projectInfo'
import { Page, Section } from '../kit'
import { SignInLine, serverName, useMcpAccounts, useSignInAll } from './mcpAccounts'
import { MCP_GROUPS, groupServers, mcpIsOff, mcpIssue } from './mcpGroups'

// Settings, MCP servers (KERNEL-661, KERNEL-680): every account's servers, one account at a time. What needs the user comes first in its group
// with one status and one action; what is ready stays quiet.

const tabId = (a: { provider: Provider; accountId: string }) => `${a.provider}:${a.accountId}`

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

/** Settings > MCP servers (AgentsPage.dc.html). The account select, a summary and a filter, then every server in its group. */
export function McpServers() {
  const { accounts: all, busy, refresh, ignore } = useMcpAccounts()
  const runs = useSignInAll()
  const profiles = useStore((st) => st.accounts)
  const from = useStore((st) => (st.ui.route.name === 'settings' ? { provider: st.ui.route.tab, account: st.ui.route.account } : undefined))
  const [picked, pick] = useState<string>()
  const [asking, setAsking] = useState<string>()
  const [query, setQuery] = useState('')
  const [working, run] = useBusy<string>()
  const accounts = useMemo(() => (all ? visibleAccounts(all) : undefined), [all])
  const account = accounts?.find((a) => tabId(a) === picked) ?? (accounts?.length ? accounts.find((a) => tabId(a) === firstTab(accounts, profiles, from)) : undefined)
  const key = account && tabId(account)
  useEffect(() => { setAsking(undefined) }, [key])
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
  const ignoreKey = (s: McpAccountServer) => `ignore:${account.provider}:${account.accountId}:${s.name}`
  const row = (s: McpAccountServer) => {
    const name = serverName(s.name)
    const issue = mcpIssue(s)
    const connect = s.state === 'not-set-up' && s.kind === 'connector' && !!s.connectUrl
    const asked = asking === s.name
    const detail = asked && account.email ? `Sign in to claude.ai as ${account.email} first`
      : s.state === 'failed' ? s.error : s.state === 'off' || mcpIsOff(s) ? s.note ?? 'Off in every project' : s.state === 'not-set-up' && s.kind !== 'connector' ? s.note : s.note
    return (
      <div key={s.name} className="set-row ag-server">
        <span className="ag-server-name">
          <span className={['set-label', s.kind !== 'connector' && 'mono'].filter(Boolean).join(' ')}>{name}</span>
          {detail && <span className="ag-meta" title={detail}>{detail}</span>}
        </span>
        {issue && <span className="ag-issue" data-kind={issue.tone}><Icon name="warning" size={12} />{issue.label}</span>}
        {issue && (
          <span className="set-entry-actions">
            {s.state === 'needs-sign-in' && <Button aria-label={`Sign in to ${name} on ${label}`} busy={working === `signin:${s.name}`} busyLabel="Signing in" disabled={!idle} onClick={() => void signIn(s.name)}>Sign in</Button>}
            {s.state === 'failed' && <Button aria-label={`Try ${name} again on ${label}`} busy={busy === key} busyLabel="Checking" disabled={!idle} onClick={() => void recheck()}>Try again</Button>}
            {connect && !asked && <Button aria-label={`Connect ${name} on ${label}`} disabled={!idle} onClick={() => setAsking(s.name)}>Connect</Button>}
            {connect && asked && <Button aria-label={`Open claude.ai to connect ${name}`} onClick={() => void openConnect(s)}>Open claude.ai</Button>}
            <Button variant="ghost" aria-label={`Ignore ${name} on ${label}`} busy={busy === ignoreKey(s)} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, true)}>Ignore</Button>
          </span>
        )}
        {!issue && s.state === 'ignored' && (
          <>
            <span className="ag-quiet">Ignored</span>
            <Button variant="ghost" aria-label={`Stop ignoring ${name} on ${label}`} busy={busy === ignoreKey(s)} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, false)}>Undo</Button>
          </>
        )}
        {!issue && s.state !== 'ignored' && <span className="ag-quiet">{s.state === 'ready' ? 'Ready' : s.state === 'checking' ? 'Checking' : 'Off'}</span>}
      </div>
    )
  }

  const total = account.servers.length
  const groups = MCP_GROUPS.map((g) => ({ ...g, all: account.servers.filter((s) => s.kind === g.kind).length, servers: groupServers(account.servers, g.kind, query) })).filter((g) => g.servers.length)
  const lastChecked = account.checkedAt === undefined ? undefined : ago(account.checkedAt)
  const counts = `${total} ${total === 1 ? 'server' : 'servers'} · ${account.needsYou ? `${account.needsYou} ${account.needsYou === 1 ? 'needs' : 'need'} you` : 'all ready'}`
  const summary = account.error ? 'Could not check this account' : account.checking ? (lastChecked ? `Checking · last checked ${lastChecked}` : 'Checking') : account.checkedAt === undefined ? 'Checking' : counts
  const stale = account.error ? `${account.error}${total > 0 && lastChecked ? `. Showing the servers from the last check, ${lastChecked}` : ''}` : undefined
  const firstCheck = total === 0 && !account.error && (account.checking || account.checkedAt === undefined)
  const action = account.needsYou > 0 ? <Button variant="primary" icon="check" aria-label={`Set up all on ${label}`} disabled={!idle} onClick={setUp}>Set up all</Button> : undefined
  return (
    <Page title="MCP servers" action={action}>
      <div className="ag-bar">
        <Select label="Account" value={key} onChange={pick} options={accounts.map((a) => ({ value: tabId(a), label: tabLabel(a, profile(a)) }))} />
        <span className="ag-summary" role="status">{summary}</span>
        <span className="ag-bar-gap" />
        <div className="ag-filter">
          <Icon name="search" size={14} />
          <input type="text" aria-label="Filter servers" placeholder="Filter servers" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="ag-bar"><SignInLine label={label} needs={0} {...runs.of(account.provider, account.accountId)} canceling={runs.canceling} disabled onSetUp={setUp} onCancel={() => void runs.cancel(account.provider)} /></div>
      {stale && <div className="ag-bar"><span className="set-desc">{stale}</span></div>}
      {firstCheck && <p className="ag-empty">Checking MCP servers</p>}
      {total === 0 && !account.error && !firstCheck && <p className="ag-empty">No MCP servers configured.</p>}
      {groups.map((g) => <Section key={g.kind} title={g.title} count={g.all} note={g.note}>{g.servers.map(row)}</Section>)}
      {query.trim() && total > 0 && groups.length === 0 && <p className="ag-empty">No servers match “{query}”</p>}
    </Page>
  )
}
