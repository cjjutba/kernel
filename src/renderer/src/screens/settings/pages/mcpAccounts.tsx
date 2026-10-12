import { useCallback, useEffect, useState } from 'react'
import type { McpAccount, McpSignInAll } from '@shared/types'
import { call, cleanError, onPush } from '../../../api'
import { actions, useStore } from '../../../store'
import { Icon, useBusy } from '../../../ui'

// Every account's MCP servers (KERNEL-627): the state line under a server, Sign in to all with its progress, and the pieces the
// Providers row and Skills and MCP share.

/** "Google Drive" for the connector Claude Code lists as "claude.ai Google Drive". */
export const serverName = (server: string) => server.replace(/^claude\.ai\s+/i, '')

/** "Google Drive and Gmail", "Linear, Google Drive and Gmail". */
export const joinNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** One server's state on each of its provider's accounts: "Ready on Work · Needs sign-in on Personal", or one plain line when it is ready on all of them. */
export function serverLine(server: string, connector: boolean, accounts: McpAccount[]): string | null {
  const on = accounts.map((a) => ({ a, s: a.servers.find((x) => x.name === server) })).filter((x) => x.s)
  if (!on.length) return null
  const parts = on.every((x) => x.s?.state === 'ready' && x.a.error === undefined) && on.length > 1 && on.length === accounts.length
    ? [`Ready on ${on.length === 2 ? 'both' : 'all'} accounts`]
    : on.map(({ a, s }) => {
      switch (s?.state) {
        case 'ready': return `Ready on ${a.label}`
        case 'needs-sign-in': return `Needs sign-in on ${a.label}`
        case 'failed': return `Failed on ${a.label}${s.error ? `: ${s.error}` : ''}`
        default: return `Not installed on ${a.label}`
      }
    })
  if (connector) parts.push('Set up per account')
  return parts.join(' · ')
}

/** Every signed-in account's servers, read when the page opens and kept live. `refresh` checks again. */
export function useMcpAccounts() {
  const [accounts, setAccounts] = useState<McpAccount[] | null>(null)
  const [busy, run] = useBusy<'refresh'>()
  useEffect(() => {
    let stopped = false
    void call('mcp.accounts', undefined).then((a) => { if (!stopped) setAccounts(a) }).catch(() => { if (!stopped) setAccounts([]) })
    const off = onPush((e) => { if (e.type === 'mcp.accounts') setAccounts(e.accounts) })
    return () => { stopped = true; off() }
  }, [])
  const refresh = useCallback(() => run('refresh', async () => {
    try { setAccounts(await call('mcp.accounts', { refresh: true })) } catch (e) { actions.ui.toast({ title: 'Could not check the MCP servers', sub: cleanError(e) }) }
  }), [run])
  return { accounts, refreshing: busy === 'refresh', refresh }
}

/** Sign in to all on Claude accounts: the run each account is on, kept in the store from the engine's pushes and the call's own result. */
export function useSignInAll() {
  const runs = useStore((st) => st.mcpRuns)
  const [busy, run] = useBusy<string>()
  const [canceling, setCanceling] = useState(false)
  const start = (accountId: string, label: string) => run(accountId, async () => {
    actions.accounts.clearMcpRun(accountId)
    try {
      actions.accounts.mcpRun(await call('accounts.mcpSignInAll', { provider: 'claude', accountId }))
      actions.accounts.set(await call('accounts.list', undefined))
    } catch (e) { actions.ui.toast({ title: `Could not sign in on ${label}`, sub: cleanError(e) }) }
    finally { setCanceling(false) }
  })
  const cancel = async () => {
    setCanceling(true)
    try { await call('accounts.cancelAdd', { provider: 'claude' }) } catch { setCanceling(false) }
  }
  const active = Object.values(runs).find((r) => !r.finished)?.accountId ?? busy
  return { runs, start, cancel, canceling, active }
}

/**
 * An account's "Needs sign-in" line with Sign in to all, the progress while it runs with Cancel, and what failed once it ends
 * (SettingsProvidersMcp.png, KERNEL-619). `servers` are the ones still missing a sign-in.
 */
export function SignInLine({ label, servers, run, running, canceling, disabled, linkId, onStart, onCancel }: {
  label: string
  servers: string[]
  run?: McpSignInAll
  running: boolean
  canceling: boolean
  disabled: boolean
  linkId?: string
  onStart: () => void
  onCancel: () => void
}) {
  const live = running || (!!run && !run.finished)
  const total = run?.servers.length ?? servers.length
  const at = run ? Math.min(run.done.length + run.failed.length + 1, total) : 1
  const names = servers.map(serverName)
  const failed = run?.finished ? run.failed : []
  return (
    <>
      {live && (
        <span className="set-warn" role="status">
          <Icon name="warning" size={12} />
          {run?.current ? `Signing in to ${serverName(run.current)}, ${at} of ${total}` : 'Signing in'}
          <button type="button" className="set-link" aria-label={`Cancel signing in on ${label}`} aria-busy={canceling || undefined} disabled={canceling} onClick={onCancel}>{canceling ? <><span className="spin" aria-hidden="true" />Canceling</> : 'Cancel'}</button>
        </span>
      )}
      {!live && names.length > 0 && (
        <span className="set-warn">
          <Icon name="warning" size={12} />
          Needs sign-in: {names.join(', ')}
          <button id={linkId} type="button" className="set-link" aria-label={`Sign in to ${joinNames(names)} on ${label}`} disabled={disabled} onClick={onStart}>{names.length > 1 ? 'Sign in to all' : 'Sign in'}</button>
        </span>
      )}
      {failed.map((f) => (
        <span key={f.server} className="set-warn">
          <Icon name="warning" size={12} />
          Could not sign in to {serverName(f.server)}: {f.error}
        </span>
      ))}
      {run?.finished && run.canceled && <span className="set-desc">Canceled after {run.done.length} of {run.servers.length}</span>}
    </>
  )
}
