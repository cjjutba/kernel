import { useEffect, useRef, useState } from 'react'
import { type AccountProfile, type AppSettings, type CodexPersonality, type Provider, type ProviderStatus } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, getState, go, useStore } from '../../../store'
import { PROVIDER_NAME as NAME, accountDetail, useFreshUsage } from '../../../accountRows'
import { Button, Icon, SegmentedControl, Tabs, Toggle, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { AddAccount } from './AddAccount'

// Settings, Providers (SettingsProviders.png, SettingsProvidersCodex.png, KERNEL-406, and the API key accounts of
// KERNEL-524). Kernel already calls teammates agents, so the page is Providers. Status is words only, never a dot (DESIGN.md).

const SYSTEM: Record<Provider, string> = { claude: 'Use system Claude', codex: 'Use system Codex' }
const PERSONALITIES: { value: CodexPersonality; label: string }[] = [{ value: 'pragmatic', label: 'Pragmatic' }, { value: 'friendly', label: 'Friendly' }, { value: 'none', label: 'None' }]

/** "Google Drive" for the connector Claude Code lists as "claude.ai Google Drive". */
const serverName = (server: string) => server.replace(/^claude\.ai\s+/i, '')

/** "Google Drive and Gmail", "Linear, Google Drive and Gmail". */
const joinNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** The labels of the provider's other accounts in the same claude.ai organization (`AccountProfile.sameOrg` holds their ids). */
const sameOrg = (a: AccountProfile, accounts: AccountProfile[]) => accounts.filter((x) => a.sameOrg?.includes(x.id)).map((x) => x.label)

/** A path under the home folder as Terminal shows it: `~/.codex/config.toml`. */
export const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** The page. The route's `tab` picks Claude Code or Codex. */
export function Providers({ s }: { s: AppSettings }) {
  const provider: Provider = useStore((st) => (st.ui.route.name === 'settings' ? st.ui.route.tab : undefined)) ?? 'claude'
  const setTab = (p: string) => go({ name: 'settings', page: 'providers', tab: p as Provider })
  return (
    <Page title="Providers">
      <div className="set-tabs">
        <Tabs label="Providers" value={provider} onChange={setTab} tabs={[{ id: 'claude', label: NAME.claude }, { id: 'codex', label: NAME.codex }]} />
      </div>
      <ProviderTab key={provider} provider={provider} s={s} />
    </Page>
  )
}

function ProviderTab({ provider, s }: { provider: Provider; s: AppSettings }) {
  const accounts = useStore((st) => st.accounts).filter((a) => a.provider === provider)
  const usage = useStore((st) => st.usage)
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [adding, setAdding] = useState(false)
  // An added account signs in again through the same sheet, which shows the code field if asked.
  const [renewing, setRenewing] = useState<AccountProfile | null>(null)
  // A key account takes a new key through the same sheet, with its field only (KERNEL-524).
  const [replacing, setReplacing] = useState<AccountProfile | null>(null)
  // The row whose name is a field (KERNEL-561), and the row to give focus back to once its field is gone.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const renamed = useRef<string | null>(null)
  const activeAdded = accounts.find((a) => a.active && !a.cli && a.auth !== 'apiKey')
  const activeKey = accounts.find((a) => a.active && a.auth === 'apiKey')
  const sheetOpen = adding || !!renewing || !!replacing
  const [busy, run] = useBusy<string>()
  useFreshUsage(true)
  // Claude Code lists each login's MCP servers that need a sign-in when the tab opens, once per login. Main keeps the answer on the account's row.
  useEffect(() => {
    if (provider !== 'claude') return
    let stopped = false
    void (async () => {
      for (const a of getState().accounts.filter((x) => x.provider === 'claude' && x.signedIn && x.auth !== 'apiKey' && !x.legacyToken && x.mcpSignIns === undefined)) {
        if (stopped) return
        try { actions.accounts.set(await call('accounts.checkMcp', { provider: 'claude', accountId: a.id })) } catch { /* the row stays as it was */ }
      }
    })()
    return () => { stopped = true }
  }, [provider])
  const read = () => call('providers.status', { provider }).then(setStatus)
  useEffect(() => { void read().catch(() => undefined) }, [provider])
  useEffect(() => {
    if (renaming || busy !== null || !renamed.current) return
    document.getElementById(`acct-rename-${renamed.current}`)?.focus()
    renamed.current = null
  }, [renaming, busy])
  const act = (key: string, title: string, fn: () => Promise<unknown>) => run(key, async () => {
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
  })
  const accountsCall = (key: string, title: string, fn: () => Promise<AccountProfile[]>) => act(key, title, async () => { actions.accounts.set(await fn()); await read() })
  const signIn = (a?: AccountProfile) => {
    const target = a ?? activeAdded
    if (target && !target.cli) return setRenewing(target)
    return act(a ? `signin:${a.id}` : 'signin', 'Could not sign in', async () => { setStatus(await call('providers.signIn', { provider, ...(a ? { accountId: a.id } : {}) })); actions.accounts.set(await call('accounts.list', undefined)) })
  }
  // One Sign in for the account's servers, one after another. Each opens the browser and finishes when Claude Code does. A claude.ai connector is finished on claude.ai, so the check afterwards can still list it.
  const signInMcp = (a: AccountProfile) => act(`mcp:${a.id}`, `Could not sign in on ${a.label}`, async () => {
    for (const m of a.mcpSignIns ?? []) actions.accounts.set(await call('accounts.mcpSignIn', { provider: 'claude', accountId: a.id, server: m.server }))
    actions.accounts.set(await call('accounts.checkMcp', { provider: 'claude', accountId: a.id }))
  })
  const stopRenaming = () => { if (renaming) renamed.current = renaming.id; setRenaming(null) }
  const saveName = (a: AccountProfile, value: string) => {
    if (value.trim() === a.label) return stopRenaming()
    void accountsCall(`rename:${a.id}`, 'Could not rename the account', async () => {
      const next = await call('accounts.rename', { provider, accountId: a.id, label: value })
      stopRenaming()
      return next
    })
  }
  const binary = s.providers[provider]
  const setPath = (key: string, o: { path?: string; useSystem?: boolean }) => act(key, 'Could not change the executable', async () => {
    setStatus(await call('providers.setPath', { provider, ...o }))
    actions.settings.set(await call('settings.get', undefined))
  })
  const choose = () => act('choose', 'Could not change the executable', async () => {
    const folder = await call('system.pickFolder', undefined)
    if (!folder) return
    setStatus(await call('providers.setPath', { provider, path: `${folder.replace(/\/$/, '')}/${provider}` }))
    actions.settings.set(await call('settings.get', undefined))
  })
  const where = binary.path ? binary.path : binary.useSystem ? 'The one on your PATH' : 'Bundled with Kernel'
  return (
    <>
      <Section
        title="Accounts"
        action={<Button disabled={busy !== null || sheetOpen} onClick={() => setAdding(true)}>Add account</Button>}
        note={accounts.some((a) => a.signedIn) ? 'Accounts share your MCP servers, plugins, skills and chat history. A switch applies from the next turn.' : provider === 'codex' ? 'Sign in with your ChatGPT plan to run agents on Codex.' : 'Sign in with your Claude plan to run agents on Claude Code.'}
      >
        {accounts.map((a) => {
          const editing = renaming?.id === a.id
          const saving = busy === `rename:${a.id}`
          return (
            <div key={a.id} className="set-row">
              <div className="set-text">
                {editing
                  ? (
                    <input
                      className="input set-rename" aria-label={`Name for ${a.label}`} autoComplete="off" spellCheck={false} autoFocus placeholder={a.email} disabled={saving} value={renaming.value}
                      onFocus={(e) => e.currentTarget.select()} onChange={(e) => setRenaming({ id: a.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return
                        if (e.key === 'Enter') { e.preventDefault(); saveName(a, renaming.value) }
                        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopRenaming() }
                      }}
                    />
                  )
                  : <span className="set-label">{a.label}</span>}
                {accountDetail(a, usage).map((line, i) => <span key={i} className="set-desc">{line}</span>)}
                {a.signedIn && !a.keychainWait && !!a.mcpSignIns?.length && (
                  <span className="set-warn">
                    <Icon name="warning" size={12} />
                    Needs sign-in: {a.mcpSignIns.map((m) => serverName(m.server)).join(', ')}
                    <button
                      type="button" className="set-link" aria-label={`Sign in to ${joinNames(a.mcpSignIns.map((m) => serverName(m.server)))} on ${a.label}`}
                      aria-busy={busy === `mcp:${a.id}` || undefined} disabled={busy !== null || sheetOpen} onClick={() => void signInMcp(a)}
                    >{busy === `mcp:${a.id}` ? <><span className="spin" aria-hidden="true" />Signing in</> : 'Sign in'}</button>
                  </span>
                )}
                {a.keychainWait && (
                  <>
                    <span className="set-warn"><Icon name="warning" size={12} />Waiting for Keychain access</span>
                    <span className="set-warn-note">Allow Kernel in the macOS prompt to use this account.</span>
                  </>
                )}
                {!a.active && !!sameOrg(a, accounts).length && <span className="set-avail"><Icon name="info" size={13} stroke={1.4} />Same organization as {joinNames(sameOrg(a, accounts))}</span>}
              </div>
              {editing
                ? (
                  <div className="set-entry-actions set-rename-actions">
                    <Button variant="ghost" aria-label={`Cancel renaming ${a.label}`} disabled={saving} onClick={stopRenaming}>Cancel</Button>
                    <Button aria-label={`Save the name for ${a.label}`} busy={saving} busyLabel="Saving" onClick={() => saveName(a, renaming.value)}>Save</Button>
                  </div>
                )
                : (
                  <>
                    {a.active && a.signedIn && <span className="set-tag">Active</span>}
                    <div className="set-entry-actions">
                      {!a.active && a.signedIn && !a.keychainWait && <Button variant="ghost" aria-label={`Switch to ${a.label}`} busy={busy === `use:${a.id}`} busyLabel="Switching" disabled={busy !== null} onClick={() => void accountsCall(`use:${a.id}`, 'Could not switch accounts', () => call('accounts.switch', { provider, accountId: a.id }))}>Switch to</Button>}
                      {!a.signedIn && a.auth !== 'apiKey' && <Button variant="ghost" aria-label={`Sign in to ${a.label}`} busy={busy === `signin:${a.id}`} busyLabel="Signing in" disabled={busy !== null || sheetOpen} onClick={() => void signIn(a)}>Sign in</Button>}
                      {!a.signedIn && a.auth === 'apiKey' && <Button variant="ghost" aria-label={`Replace the key for ${a.label}`} disabled={busy !== null || sheetOpen} onClick={() => setReplacing(a)}>Replace key</Button>}
                      <Button id={`acct-rename-${a.id}`} variant="ghost" aria-label={`Rename ${a.label}`} disabled={busy !== null} onClick={() => setRenaming({ id: a.id, value: a.label })}>Rename</Button>
                      {a.signedIn && a.auth !== 'apiKey' && !a.legacyToken && !a.keychainWait && <Button variant="ghost" aria-label={`Sign out of ${a.label}`} busy={busy === `out:${a.id}`} busyLabel="Signing out" disabled={busy !== null} onClick={() => void accountsCall(`out:${a.id}`, 'Could not sign out', () => call('accounts.signOut', { provider, accountId: a.id }))}>Sign out</Button>}
                      {a.signedIn && a.legacyToken && <Button variant="ghost" aria-label={`Sign in again to ${a.label}`} disabled={busy !== null || sheetOpen} onClick={() => setRenewing(a)}>Sign in again</Button>}
                      {!a.cli && <Button variant="ghost" aria-label={`Remove ${a.label}`} busy={busy === `remove:${a.id}`} busyLabel="Removing" disabled={busy !== null} onClick={() => void accountsCall(`remove:${a.id}`, 'Could not remove the account', () => call('accounts.remove', { provider, accountId: a.id }))}>Remove</Button>}
                    </div>
                  </>
                )}
            </div>
          )
        })}
        <Row label="At a limit, switch to another account" desc={`Kernel moves agents to the ${NAME[provider]} account with the most room and says so in the chat. It never moves to an API key.`}>
          <Toggle label="At a limit, switch to another account" checked={s.accounts.switchAtLimit[provider]} onChange={(v) => void patchSettings({ accounts: { switchAtLimit: { [provider]: v } } })} />
        </Row>
      </Section>
      <Section title="Status" action={<Button busy={busy === 'refresh'} busyLabel="Refreshing" disabled={busy !== null} onClick={() => void act('refresh', 'Could not read the status', read)}>Refresh</Button>}>
        <Row label="Version"><span className="set-value">{status?.version ?? (status ? 'Not found' : '')}</span></Row>
        <Row label="Login method"><span className="set-value">{status ? status.loginMethod ?? 'Not signed in' : ''}</span></Row>
        {status?.signedIn && status.plan && <Row label="Plan"><span className="set-value">{status.plan}</span></Row>}
        {status?.signedIn && status.email && <Row label="Email"><span className="set-value">{status.email}</span></Row>}
        {status?.error && <Row label="Problem" desc={status.error} />}
        {activeKey
          ? (
            <Row label="Replace key" desc="Opens Add account, where you paste a new key for the active account">
              <Button disabled={busy !== null || sheetOpen} onClick={() => setReplacing(activeKey)}>Replace key</Button>
            </Row>
          )
          : (
            <Row label={status?.signedIn ? 'Sign in again' : 'Sign in'} desc={`Opens ${provider === 'codex' ? 'ChatGPT' : 'Claude'}’s sign-in in your browser${status?.signedIn ? ', for the active account' : ''}`}>
              <Button busy={busy === 'signin'} busyLabel="Signing in" disabled={busy !== null} onClick={() => void signIn()}>Run login</Button>
            </Row>
          )}
      </Section>
      {provider === 'codex' && (
        <Section title="New chats">
          <Row label="Codex personality for new chats" desc="How Codex talks to you. It doesn't change what it can do.">
            <SegmentedControl label="Codex personality for new chats" value={s.providers.codex.personality} options={PERSONALITIES} onChange={(v) => void patchSettings({ providers: { codex: { personality: v as CodexPersonality } } })} />
          </Row>
        </Section>
      )}
      <Section title="Executable">
        <Row label={NAME[provider]} desc={`Agents run on this copy of ${NAME[provider]}`} full={<span className="set-value">{tilde(status?.path && binary.useSystem && !binary.path ? status.path : where)}</span>}>
          <div className="set-entry-actions">
            <Button variant="ghost" aria-label={`Choose the folder ${NAME[provider]} is in`} busy={busy === 'choose'} busyLabel="Choosing" disabled={busy !== null} onClick={() => void choose()}>Choose</Button>
            {binary.path || binary.useSystem
              ? <Button variant="ghost" busy={busy === 'bundled'} busyLabel="Switching" disabled={busy !== null} onClick={() => void setPath('bundled', { path: '', useSystem: false })}>Use bundled</Button>
              : <Button variant="ghost" busy={busy === 'system'} busyLabel="Switching" disabled={busy !== null} onClick={() => void setPath('system', { path: '', useSystem: true })}>{SYSTEM[provider]}</Button>}
          </div>
        </Row>
        <Row label="CLI config file" full={<span className="set-value">{tilde(status?.configFile ?? '')}</span>}>
          <Button busy={busy === 'config'} busyLabel="Opening" disabled={busy !== null} onClick={() => void act('config', 'Could not open the file', () => call('providers.openConfig', { provider }))}>Open</Button>
        </Row>
      </Section>
      {adding && <AddAccount provider={provider} onClose={() => { setAdding(false); void read().catch(() => undefined) }} />}
      {renewing && <AddAccount provider={provider} signIn={{ label: renewing.label, accountId: renewing.id }} onClose={() => { setRenewing(null); void read().catch(() => undefined) }} />}
      {replacing && <AddAccount provider={provider} replaceKey={{ accountId: replacing.id, label: replacing.label }} onClose={() => { setReplacing(null); void read().catch(() => undefined) }} />}
    </>
  )
}
