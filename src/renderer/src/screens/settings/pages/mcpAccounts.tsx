import { useCallback, useEffect, useState } from 'react'
import type { McpAccount, McpSignInAll, Provider } from '@shared/types'
import { call, cleanError, onPush } from '../../../api'
import { actions, mcpRunKey, useStore } from '../../../store'
import { Icon, useBusy } from '../../../ui'

// Every account's MCP servers (KERNEL-627): the state line under a server, Sign in to all with its progress, and the pieces the
// Providers row and Skills and MCP share.

/** "Google Drive" for the connector Claude Code lists as "claude.ai Google Drive". */
export const serverName = (server: string) => server.replace(/^claude\.ai\s+/i, '')

/** "Google Drive and Gmail", "Linear, Google Drive and Gmail". */
export const joinNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** Every signed-in account's servers, read when the page opens and kept live. `refresh` checks again. */
export function useMcpAccounts() {
  const [accounts, setAccounts] = useState<McpAccount[] | null>(null)
  const [busy, run] = useBusy<string>()
  useEffect(() => {
    let stopped = false
    void call('mcp.accounts', undefined).then((a) => { if (!stopped) setAccounts(a) }).catch(() => { if (!stopped) setAccounts([]) })
    const off = onPush((e) => { if (e.type === 'mcp.accounts') setAccounts(e.accounts) })
    return () => { stopped = true; off() }
  }, [])
  /** Checks every account again, or only `of`'s. */
  const refresh = useCallback((of?: { provider: Provider; accountId: string }) => run(of ? `${of.provider}:${of.accountId}` : 'refresh', async () => {
    try { setAccounts(await call('mcp.accounts', { refresh: true, ...of })) } catch (e) { actions.ui.toast({ title: 'Could not check the MCP servers', sub: cleanError(e) }) }
  }), [run])
  /** Ignores a server on an account, or stops. */
  const ignore = useCallback((provider: Provider, accountId: string, server: string, ignored: boolean) => run(`ignore:${provider}:${accountId}:${server}`, async () => {
    try { setAccounts(await call('accounts.mcpIgnore', { provider, accountId, server, ignored })) } catch (e) { actions.ui.toast({ title: `Could not ${ignored ? 'ignore' : 'restore'} ${serverName(server)}`, sub: cleanError(e) }) }
  }), [run])
  return { accounts, busy, refreshing: busy === 'refresh', refresh, ignore }
}

/** Sign in to all on Claude accounts: the run each account is on, kept in the store from the engine's pushes and the call's own result. */
export function useSignInAll() {
  const runs = useStore((st) => st.mcpRuns)
  const [busy, run] = useBusy<string>()
  const [canceling, setCanceling] = useState(false)
  const start = (provider: Provider, accountId: string, label: string) => run(mcpRunKey(provider, accountId), async () => {
    actions.accounts.clearMcpRun(provider, accountId)
    try {
      actions.accounts.mcpRun(await call('accounts.mcpSignInAll', { provider, accountId }))
      actions.accounts.set(await call('accounts.list', undefined))
    } catch (e) { actions.ui.toast({ title: `Could not sign in on ${label}`, sub: cleanError(e) }) }
    finally { setCanceling(false) }
  })
  const cancel = async (provider: Provider) => {
    setCanceling(true)
    try { await call('accounts.cancelAdd', { provider }) } catch { setCanceling(false) }
  }
  const active = Object.entries(runs).find(([, r]) => !r.finished)?.[0] ?? busy
  /** The run on one account, and whether Sign in to all is going on there. `active` is the key of the one that is going, if any. */
  const of = (provider: Provider, accountId: string) => ({ run: runs[mcpRunKey(provider, accountId)], running: active === mcpRunKey(provider, accountId) })
  return { runs, of, start, cancel, canceling, active }
}

/**
 * An account's "Needs sign-in" line with Sign in to all, the progress while it runs with Cancel, and what failed once it ends
 * (SettingsProvidersMcp.png, KERNEL-619). `servers` are the ones still missing a sign-in. With `onOpen` the action opens Skills and MCP on the
 * account instead of signing in (KERNEL-647).
 */
export function SignInLine({ label, servers, run, running, canceling, disabled, linkId, onStart, onOpen, onCancel }: {
  label: string
  servers: string[]
  run?: McpSignInAll
  running: boolean
  canceling: boolean
  disabled: boolean
  linkId?: string
  onStart: () => void
  onOpen?: () => void
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
          <button id={linkId} type="button" className="set-link" aria-label={onOpen ? `Open Skills and MCP on ${label}` : `Sign in to ${joinNames(names)} on ${label}`} disabled={disabled} onClick={onOpen ?? onStart}>{onOpen ? 'Review' : names.length > 1 ? 'Sign in to all' : 'Sign in'}</button>
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
