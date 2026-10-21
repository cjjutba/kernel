import './mcp.css'
import { useEffect, useMemo, useState } from 'react'
import type { AccountProfile, McpAccount, McpAccountServer, Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, EmptyList, FailedState, Icon, LoadingRow, SegmentedControl, Spinner, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { McpSignInDialog } from './McpSignInDialog'
import { SignInLine, serverName, useMcpAccounts, useSignInAll } from './mcpAccounts'
import { MCP_GROUPS, groupServers, mcpIsOff } from './mcpGroups'

// Settings, MCP servers (KERNEL-661, KERNEL-680, Redesign 15): every account's servers, one account at a time. A row says what the server is, whether
// agents can use it and, when it needs you, the one thing to press.

const tabId = (a: { provider: Provider; accountId: string }) => `${a.provider}:${a.accountId}`

/** The Codex accounts whose servers read the same show as one tab, led by the first of them. */
function visibleAccounts(accounts: McpAccount[]) {
  return accounts.filter((a, i) => !accounts.slice(0, i).some((b) => b.provider === a.provider && b.sharedWith?.includes(a.accountId)))
}

/** The account's name on its tab: "Work", and "Codex" for the one tab of the Codex accounts that share their servers. */
function tabLabel(a: McpAccount, profile?: AccountProfile, others = 0) {
  if (a.sharedWith?.length || (a.provider === 'codex' && !others)) return 'Codex'
  const name = profile?.label ?? a.label
  return a.provider === 'codex' ? `Codex · ${name}` : name
}

/** The account the page opens on: the one the notice or Accounts named, else the active Claude Code account, else the first. */
function firstTab(accounts: McpAccount[], profiles: AccountProfile[], from?: { provider?: Provider; account?: string }) {
  const named = accounts.find((a) => (a.accountId === from?.account || a.sharedWith?.includes(from?.account ?? '')) && (!from?.provider || a.provider === from.provider))
  const active = accounts.find((a) => a.provider === 'claude' && profiles.some((p) => p.provider === a.provider && p.id === a.accountId && p.active))
  return tabId(named ?? active ?? accounts[0])
}

/** "3 minutes ago" for the last check, the words the bar uses. */
function checkedAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`
  if (s < 60) return 'just now'
  if (s < 3600) return unit(Math.floor(s / 60), 'minute')
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour')
  return unit(Math.floor(s / 86400), 'day')
}

/** A plugin's server is listed as `plugin:figma:figma`: the server is the last part and the plugin the middle. */
function pluginOf(name: string): { server: string; plugin: string } | undefined {
  const [head, plugin, server] = name.split(':')
  return head === 'plugin' && plugin && server ? { server, plugin } : undefined
}

/** What a row says under its name: why the server is in the state it is in, else where it comes from. A server in a file has nothing more to say, since Kernel doesn't read its command. */
function lineUnder(s: McpAccountServer): string | undefined {
  if (s.note) return s.note
  if (s.kind === 'connector') return 'Connector on claude.ai'
  const plugin = pluginOf(s.name)
  return plugin ? `From the ${plugin.plugin} plugin` : undefined
}

type Status = { label: string; icon?: 'alertCircle' | 'close' | 'check' | 'eyeoff' | 'wifioff'; loader?: 'arrow-down' | 'snake'; tone?: 'warn' | 'failed' | 'quiet' }

/** Settings > MCP servers (AgentsPage.dc.html). The account tabs and when it was checked, a filter, then every server in its group. */
export function McpServers() {
  const { accounts: all, busy, refresh, ignore, failed, read } = useMcpAccounts()
  const runs = useSignInAll()
  const profiles = useStore((st) => st.accounts)
  const online = useStore((st) => st.system.online)
  const from = useStore((st) => (st.ui.route.name === 'settings' ? { provider: st.ui.route.tab, account: st.ui.route.account } : undefined))
  const [picked, pick] = useState<string>()
  const [asking, setAsking] = useState<string>()
  const [signing, setSigning] = useState<string>()
  const [query, setQuery] = useState('')
  const [working, run] = useBusy<string>()
  const accounts = useMemo(() => (all ? visibleAccounts(all) : undefined), [all])
  const account = accounts?.find((a) => tabId(a) === picked) ?? (accounts?.length ? accounts.find((a) => tabId(a) === firstTab(accounts, profiles, from)) : undefined)
  const key = account && tabId(account)
  const codexCount = accounts?.filter((a) => a.provider === 'codex').length ?? 0
  useEffect(() => { setAsking(undefined); setSigning(undefined) }, [key])
  const profile = (a: McpAccount) => profiles.find((p) => p.provider === a.provider && p.id === a.accountId)
  // A check that ended in an error keeps the saved servers on screen, and the error is a toast raised once.
  const checkError = account?.error
  useEffect(() => { if (checkError && account) actions.ui.toast({ title: `Could not check ${tabLabel(account, profile(account), codexCount - 1)}`, sub: checkError, glyph: 'error' }) }, [key, checkError])

  if (!accounts) return <Page title="MCP servers" desc="The servers each Claude Code account sees. Kernel checks them when this page opens."><LoadingRow what="MCP servers" /></Page>
  const intro = 'The servers each Claude Code account sees. Kernel checks them when this page opens.'
  if (failed && !accounts.length) return <Page title="MCP servers" desc={intro}><FailedState icon="plug" title="Could not read the MCP servers" onRetry={read}>Kernel reads them from each account's Claude Code or Codex.</FailedState></Page>
  if (!account || !key) return <Page title="MCP servers" desc={intro}><EmptyList icon="plug" title="No accounts to check">Sign in to Claude Code or Codex in Settings, Accounts and its servers show here.</EmptyList></Page>

  const label = tabLabel(account, profile(account), codexCount - 1)
  const idle = working === null && busy === null && runs.active === null
  const recheck = () => refresh({ provider: account.provider, accountId: account.accountId })
  const signIn = (server: string) => run(`signin:${server}`, async () => {
    try { await call('accounts.mcpSignIn', { provider: account.provider, accountId: account.accountId, server }); setSigning(undefined) } catch (e) { actions.ui.toast({ title: `Could not sign in to ${serverName(server)}`, sub: cleanError(e) }) }
    await recheck()
  })
  const openConnect = (s: McpAccountServer) => call('system.openExternal', { url: s.connectUrl! }).catch((e) => actions.ui.toast({ title: 'Could not open claude.ai', sub: cleanError(e) }))
  const setUp = () => actions.ui.openModal({ name: 'mcpSetUp', provider: account.provider, accountId: account.accountId })
  const ignoreKey = (s: McpAccountServer) => `ignore:${account.provider}:${account.accountId}:${s.name}`
  const live = runs.of(account.provider, account.accountId)
  const going = live.run && !live.run.finished ? live.run.current : undefined

  const statusOf = (s: McpAccountServer): Status => {
    if (going === s.name) return { label: 'Setting up', loader: 'snake' }
    if (s.state === 'needs-sign-in') return { label: 'Needs sign-in', icon: 'alertCircle', tone: 'warn' }
    if (s.state === 'failed') return { label: `Failed${s.error ? `, ${s.error}` : ''}`, icon: 'close', tone: 'failed' }
    if (s.state === 'ignored') return { label: 'Ignored', icon: 'eyeoff', tone: 'quiet' }
    if (!online && (s.state === 'ready' || s.state === 'checking')) return { label: 'Offline', icon: 'wifioff' }
    if (s.state === 'checking') return { label: 'Checking', loader: 'arrow-down' }
    if (s.state === 'ready') return { label: 'Ready', icon: 'check' }
    if (s.state === 'off' || mcpIsOff(s)) return { label: 'Off' }
    return { label: 'Not set up' }
  }
  const row = (s: McpAccountServer) => {
    const plugin = pluginOf(s.name)
    const name = plugin ? plugin.server : serverName(s.name)
    const connect = s.state === 'not-set-up' && s.kind === 'connector' && !!s.connectUrl
    const asked = asking === s.name
    const status = statusOf(s)
    const under = asked && account.email ? `Sign in to claude.ai as ${account.email} first`
      : going === s.name ? (s.state === 'needs-sign-in' || s.state === 'failed' ? 'Signing in' : 'Adding the server')
      : !online && (s.state === 'ready' || s.state === 'checking') ? 'Checks run again when you’re back online'
      : live.run?.done.includes(s.name) ? `Signed in${account.email ? ` as ${account.email}` : ''}`
      : s.state === 'checking' && account.checkedAt !== undefined ? 'Signed in on another account. Checking here.'
      : lineUnder(s)
    const needs = s.state === 'needs-sign-in' || s.state === 'failed' || connect
    return (
      <Row
        key={s.name}
        className="mcp-row"
        label={<span className="mcp-name">{name}</span>}
        desc={under}
        hover={needs && s.state !== 'ignored' ? <Button variant="ghost" size="sm" aria-label={`Ignore ${name} on ${label}`} busy={busy === ignoreKey(s)} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, true)}>Ignore</Button> : undefined}
      >
        <span className="mcp-status" data-tone={status.tone} role={status.loader ? 'status' : undefined} title={status.label}>
          {status.loader ? <Spinner label={null} pattern={status.loader} /> : status.icon && <Icon name={status.icon} size={12} />}
          <span>{status.label}</span>
        </span>
        <span className="mcp-acts">
          {s.state === 'needs-sign-in' && <Button aria-label={`Sign in to ${name} on ${label}`} disabled={!idle || !online} onClick={() => setSigning(s.name)}>Sign in</Button>}
          {s.state === 'failed' && <Button icon="refresh" aria-label={`Try ${name} again on ${label}`} busy={busy === key} busyLabel="Checking" disabled={!idle} onClick={() => void recheck()}>Retry</Button>}
          {connect && !asked && <Button icon="ext" aria-label={`Set up ${name} on ${label}`} disabled={!idle} onClick={() => setAsking(s.name)}>Set up</Button>}
          {connect && asked && <Button icon="ext" aria-label={`Open claude.ai to set up ${name}`} onClick={() => void openConnect(s)}>Open claude.ai</Button>}
          {s.state === 'ignored' && <Button aria-label={`Stop ignoring ${name} on ${label}`} busy={busy === ignoreKey(s)} disabled={!idle} onClick={() => void ignore(account.provider, account.accountId, s.name, false)}>Stop ignoring</Button>}
        </span>
      </Row>
    )
  }

  const total = account.servers.length
  const groups = MCP_GROUPS.map((g) => ({ ...g, servers: groupServers(account.servers, g.kind, query) })).filter((g) => g.servers.length)
  const firstCheck = total === 0 && !account.error && (account.checking || account.checkedAt === undefined)
  const checking = !!account.checking
  const action = account.needsYou > 0 ? <Button variant="primary" aria-label={`Set up ${label}`} disabled={!idle} onClick={setUp}>Set up this account</Button> : undefined
  const asked = signing ? account.servers.find((s) => s.name === signing) : undefined
  const progress = runs.of(account.provider, account.accountId)
  const failures = progress.run?.finished ? progress.run.failed.length : 0
  return (
    <Page title="MCP servers" desc={intro} action={action}>
      <Section title="Account" plain>
        <div className="mcp-bar">
          <SegmentedControl label="Account" value={key} onChange={pick} options={accounts.map((a) => ({ value: tabId(a), label: tabLabel(a, profile(a), codexCount - 1) }))} />
          <span className="mcp-bar-gap" />
          <span className="mcp-checked" role="status">
            {account.checkedAt !== undefined && !checking ? `Checked ${checkedAgo(account.checkedAt)}` : null}
          </span>
          <Button icon="refresh" busy={busy === key || checking} busyLabel="Checking" disabled={!idle} onClick={() => void recheck()}>Check again</Button>
        </div>
      </Section>
      {(progress.running || !!progress.run || failures > 0) && <div className="mcp-bar"><SignInLine label={label} needs={0} {...progress} canceling={runs.canceling} disabled onSetUp={setUp} onCancel={() => void runs.cancel(account.provider)} /></div>}
      <div className="mcp-filter">
        <Icon name="search" size={14} />
        <input type="text" aria-label="Filter servers" placeholder="Filter servers" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {firstCheck && <LoadingRow what="MCP servers" />}
      {total === 0 && !account.error && !firstCheck && <p className="mcp-empty">No MCP servers configured.</p>}
      {groups.map((g) => <Section key={g.kind} title={g.title}>{g.servers.map(row)}</Section>)}
      {query.trim() && total > 0 && groups.length === 0 && <p className="mcp-empty">No servers match “{query}”</p>}
      {asked && <McpSignInDialog server={serverName(asked.name)} label={label} busy={working === `signin:${asked.name}`} onClose={() => setSigning(undefined)} onStart={() => void signIn(asked.name)} />}
    </Page>
  )
}
