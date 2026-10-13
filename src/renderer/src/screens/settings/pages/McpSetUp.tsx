import { useEffect, useId, useRef, useState } from 'react'
import type { McpAccountServer, McpConnect, Provider } from '@shared/types'
import { mcpNeedsYou } from '@shared/mcpCounts'
import { call, cleanError, onPush } from '../../../api'
import { actions, getState, mcpRunKey, useStore } from '../../../store'
import { Button, Modal, useBusy } from '../../../ui'
import { joinNames, serverName, useMcpAccounts, useSignInAll } from './mcpAccounts'
import { MCP_GROUPS, mcpStatus } from './mcpGroups'

// Set up this account (KERNEL-661, no PNG): the servers that need the user on one account as a checklist with everything ticked, then
// the progress of `accounts.mcpSetUp`, then what was done and what failed. The unticked ones are ignored by the engine.

export function McpSetUp({ provider, accountId }: { provider: Provider; accountId: string }) {
  const { accounts } = useMcpAccounts()
  const profile = useStore((st) => st.accounts.find((p) => p.provider === provider && p.id === accountId))
  const frozen = useRef<McpAccountServer[] | undefined>(undefined)
  const runs = useSignInAll()
  const run = runs.of(provider, accountId).run
  const [skipped, setSkipped] = useState<string[]>([])
  const [started, setStarted] = useState(false)
  const [pushed, setPushed] = useState<McpConnect>()
  const [busy, go] = useBusy<'start'>()
  const id = useId()
  const account = accounts?.find((a) => a.provider === provider && a.accountId === accountId)
  if (!frozen.current && account) frozen.current = account.servers.filter(mcpNeedsYou)
  const items = frozen.current ?? []
  const live = started || !!run
  const finished = !!run?.finished
  const connect = run?.connect ?? pushed
  const label = profile?.label ?? account?.label ?? 'this account'

  useEffect(() => onPush((e) => { if (e.type === 'account.mcpConnect' && e.connect.provider === provider && e.connect.accountId === accountId) setPushed(e.connect) }), [provider, accountId])

  const close = actions.ui.closeModal
  useEffect(() => () => { if (getState().mcpRuns[mcpRunKey(provider, accountId)]?.finished) actions.accounts.clearMcpRun(provider, accountId) }, [provider, accountId])
  const ticked = items.filter((s) => !skipped.includes(s.name))
  const start = () => go('start', async () => {
    setStarted(true)
    setPushed(undefined)
    actions.accounts.clearMcpRun(provider, accountId)
    try {
      const include = MCP_GROUPS.flatMap((g) => ticked.filter((s) => s.kind === g.kind)).map((s) => s.name)
      actions.accounts.mcpRun(await call('accounts.mcpSetUp', { provider, accountId, include }))
      actions.accounts.set(await call('accounts.list', undefined))
    } catch (e) {
      setStarted(false)
      actions.ui.toast({ title: `Could not set up ${label}`, sub: cleanError(e) })
    }
  })
  const openConnect = () => call('system.openExternal', { url: connect!.url }).catch((e) => actions.ui.toast({ title: 'Could not open claude.ai', sub: cleanError(e) }))

  const total = run?.servers.length ?? ticked.length
  const at = run ? Math.min(run.done.length + run.failed.length + 1, total) : 1
  const progress = run?.current ? `Signing in to ${serverName(run.current)}, ${at} of ${total}` : connect ? 'Waiting for claude.ai' : 'Starting'

  let body
  let footer
  if (!account || (!live && !items.length)) {
    body = <p className="set-empty" role="status">{account ? 'Nothing needs you on this account.' : 'Checking MCP servers'}</p>
    footer = <><span className="grow" /><Button variant="ghost" size="lg" data-dismiss>Close</Button></>
  } else if (!live) {
    body = (
      <>
        <p className="mcp-su-lead">Kernel signs in to what stays ticked, one after another. What you untick is ignored on {label}.</p>
        {MCP_GROUPS.map((g) => {
          const list = items.filter((s) => s.kind === g.kind)
          if (!list.length) return null
          return (
            <fieldset key={g.kind} className="mcp-su-group">
              <legend className="set-group">{g.title}</legend>
              {list.map((s) => (
                <label key={s.name} className="mcp-su-item">
                  <input type="checkbox" checked={!skipped.includes(s.name)} onChange={(e) => setSkipped(e.target.checked ? skipped.filter((n) => n !== s.name) : [...skipped, s.name])} />
                  <span><span className="set-label">{serverName(s.name)}</span><span className="set-desc">{mcpStatus(s)}</span></span>
                </label>
              ))}
            </fieldset>
          )
        })}
      </>
    )
    footer = <><span className="grow" /><Button variant="ghost" size="lg" data-dismiss>Cancel</Button><Button variant="primary" size="lg" busy={busy === 'start'} busyLabel="Starting" onClick={() => void start()}>Start</Button></>
  } else if (!finished) {
    body = (
      <div className="mcp-su-progress">
        <p role="status">{progress}</p>
        {connect && (
          <div className="mcp-su-connect">
            <p>Open claude.ai{connect.email ? ` as ${connect.email}` : ''} and add: {joinNames(connect.servers.map(serverName))}.</p>
            <Button aria-label="Open claude.ai" onClick={() => void openConnect()}>Open claude.ai</Button>
          </div>
        )}
        {run && run.done.length > 0 && <p className="set-desc">Signed in to {joinNames(run.done.map(serverName))}</p>}
      </div>
    )
    footer = <><span className="grow" /><Button variant="ghost" size="lg" aria-label={`Cancel setting up ${label}`} busy={runs.canceling} busyLabel="Canceling" onClick={() => void runs.cancel(provider)}>Cancel</Button></>
  } else {
    body = (
      <div className="mcp-su-progress">
        {run!.canceled && <p className="set-desc">Canceled after {run!.done.length} of {run!.servers.length}</p>}
        <p className="set-label">Done</p>
        {run!.done.length ? <ul className="mcp-su-list">{run!.done.map((n) => <li key={n}>{serverName(n)}</li>)}</ul> : <p className="set-desc">Nothing was signed in.</p>}
        {run!.failed.length > 0 && (
          <>
            <p className="set-label">Failed</p>
            <ul className="mcp-su-list">{run!.failed.map((f) => <li key={f.server}>{serverName(f.server)}<span className="set-desc">{f.error}</span></li>)}</ul>
          </>
        )}
        {connect && <p className="set-desc">Add {joinNames(connect.servers.map(serverName))} on claude.ai{connect.email ? ` as ${connect.email}` : ''}. Kernel checks again when you come back.</p>}
        {!!run!.ignored?.length && <p className="set-desc">Ignored {joinNames(run!.ignored.map(serverName))}</p>}
      </div>
    )
    footer = <><span className="grow" /><Button variant="primary" size="lg" data-dismiss>Close</Button></>
  }
  return (
    <Modal title={`Set up ${label}`} onClose={close} width={520} top={160} describedBy={`${id}b`} footer={footer}>
      <div id={`${id}b`} className="mcp-su">{body}</div>
    </Modal>
  )
}
