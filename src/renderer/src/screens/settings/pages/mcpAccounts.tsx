import { useCallback, useEffect, useState } from 'react'
import type { McpAccount, McpSignInAll, Provider } from '@shared/types'
import { call, cleanError, onPush } from '../../../api'
import { actions, mcpNeedYou, mcpRunKey, useStore } from '../../../store'
import { Icon, Spinner, useBusy } from '../../../ui'

// Every account's MCP servers (KERNEL-627): the pieces the MCP servers page, Set up this account, the Providers row and a room's
// Skills and MCP share (KERNEL-661).

/** "Google Drive" for the connector Claude Code lists as "claude.ai Google Drive". */
export const serverName = (server: string) => server.replace(/^claude\.ai\s+/i, '')

/** "Google Drive and Gmail", "Linear, Google Drive and Gmail". */
export const joinNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** Every signed-in account's servers, read when the page opens, kept live and checked again whenever the window gets focus (KERNEL-661). `refresh` checks again. */
export function useMcpAccounts() {
  const [accounts, setAccounts] = useState<McpAccount[] | null>(null)
  const [busy, run] = useBusy<string>()
  useEffect(() => {
    let stopped = false
    void call('mcp.accounts', undefined).then((a) => { if (!stopped) setAccounts(a) }).catch(() => { if (!stopped) setAccounts([]) })
    const off = onPush((e) => { if (e.type === 'mcp.accounts') setAccounts(e.accounts) })
    const onFocus = () => { void call('mcp.recheck', undefined).then((a) => { if (!stopped) setAccounts(a) }).catch(() => undefined) }
    window.addEventListener('focus', onFocus)
    return () => { stopped = true; off(); window.removeEventListener('focus', onFocus) }
  }, [])
  /** Checks every account again, or only `of`'s. */
  const refresh = useCallback((of?: { provider: Provider; accountId: string }) => run(of ? `${of.provider}:${of.accountId}` : 'refresh', async () => {
    try { setAccounts(await call('mcp.accounts', { refresh: true, ...of })) } catch (e) { actions.ui.toast({ title: 'Could not check the MCP servers', sub: cleanError(e) }) }
  }), [run])
  /** Ignores a server on an account, or stops. */
  const ignore = useCallback((provider: Provider, accountId: string, server: string, ignored: boolean) => run(`ignore:${provider}:${accountId}:${server}`, async () => {
    try { setAccounts(await call('accounts.mcpIgnore', { provider, accountId, server, ignored })) } catch (e) { actions.ui.toast({ title: `Could not ${ignored ? 'ignore' : 'restore'} ${serverName(server)}`, sub: cleanError(e) }) }
  }), [run])
  return { accounts, busy, refresh, ignore }
}

/** Where Set up this account is on each account: the run in the store, from the engine's pushes and the call's own result. */
export function useSignInAll() {
  const runs = useStore((st) => st.mcpRuns)
  const [canceling, setCanceling] = useState(false)
  const cancel = async (provider: Provider) => {
    setCanceling(true)
    try { await call('accounts.cancelAdd', { provider }) } catch { setCanceling(false) }
  }
  const active = Object.entries(runs).find(([, r]) => !r.finished)?.[0] ?? null
  useEffect(() => { if (active === null) setCanceling(false) }, [active])
  /** The run on one account, and whether it is going. `active` is the key of the one that is going, if any. */
  const of = (provider: Provider, accountId: string) => ({ run: runs[mcpRunKey(provider, accountId)], running: active === mcpRunKey(provider, accountId) })
  return { runs, of, cancel, canceling, active }
}

/**
 * An account's MCP line: "3 MCP servers need you · Set up" with Set up opening the checklist, the progress while it runs with Cancel, and
 * what failed once it ends (SettingsProvidersMcp.png, KERNEL-619, KERNEL-661).
 */
export function SignInLine({ label, needs, run, running, canceling, disabled, onSetUp, onCancel }: {
  label: string
  needs: number
  run?: McpSignInAll
  running: boolean
  canceling: boolean
  disabled: boolean
  onSetUp: () => void
  onCancel: () => void
}) {
  const live = running || (!!run && !run.finished)
  const total = run?.servers.length ?? needs
  const at = run ? Math.min(run.done.length + run.failed.length + 1, total) : 1
  const failed = run?.finished ? run.failed : []
  return (
    <>
      {live && (
        <span className="set-warn" role="status">
          <Icon name="warning" size={12} />
          {run?.current ? `Signing in to ${serverName(run.current)}, ${at} of ${total}` : 'Signing in'}
          <button type="button" className="set-link" aria-label={`Cancel setting up ${label}`} aria-busy={canceling || undefined} disabled={canceling} onClick={onCancel}>{canceling ? <><Spinner label={null} pattern="scatter" />Canceling</> : 'Cancel'}</button>
        </span>
      )}
      {!live && needs > 0 && (
        <span className="set-warn">
          <Icon name="warning" size={12} />
          {mcpNeedYou(needs)}
          <span aria-hidden="true">·</span>
          <button type="button" className="set-link" aria-label={`Set up ${label}`} disabled={disabled} onClick={onSetUp}>Set up</button>
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
