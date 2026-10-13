import { useEffect, useRef, useState } from 'react'
import { type AccountProfile, type AppSettings, type CodexPersonality, type Provider, type ProviderStatus } from '@shared/types'
import { switchChoices } from '@shared/usage'
import { call, cleanError } from '../../../api'
import { actions, getState, go, useStore } from '../../../store'
import { PROVIDER_NAME as NAME, accountRow, limitHit, ownLogin, useFreshUsage } from '../../../accountRows'
import { Button, ConfirmDialog, Icon, MENU_SEPARATOR, SegmentedControl, Select, Tabs, Toggle, useBusy, type MenuEntry } from '../../../ui'
import { noteCodexStatus } from '../../workspace/composer/providerModels'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { AddAccount } from './AddAccount'
import { SignInLine, joinNames, useMcpAccounts, useSignInAll } from './mcpAccounts'
import { AccountRow, LimitBanner, type RowAction } from './providerRows'

// Settings, Providers (SettingsProviders.png, KERNEL-406, the API key accounts of KERNEL-524, and the redesign in
// feat-providers-redesign, drawn in design/providers/). Kernel already calls teammates agents, so the page is Providers.
// Subscriptions and API keys are two sections: a key has no usage windows and Kernel never switches to one on its own.

const PERSONALITIES: { value: CodexPersonality; label: string }[] = [{ value: 'pragmatic', label: 'Pragmatic' }, { value: 'friendly', label: 'Friendly' }, { value: 'none', label: 'None' }]
const EXECUTABLES = [{ value: 'bundled', label: 'Bundled with Kernel' }, { value: 'system', label: 'System, from your PATH' }, { value: 'custom', label: 'Custom folder…' }]

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
      <div className="prov-tabs">
        <Tabs variant="underline" label="Providers" value={provider} onChange={setTab} tabs={[{ id: 'claude', label: NAME.claude }, { id: 'codex', label: NAME.codex }]} />
      </div>
      <ProviderTab key={provider} provider={provider} s={s} />
    </Page>
  )
}

function ProviderTab({ provider, s }: { provider: Provider; s: AppSettings }) {
  const all = useStore((st) => st.accounts)
  const accounts = all.filter((a) => a.provider === provider)
  const subscriptions = accounts.filter((a) => a.auth !== 'apiKey')
  const keys = accounts.filter((a) => a.auth === 'apiKey')
  const usage = useStore((st) => st.usage)
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  // Add account opens the sheet on Subscription, Add key on API key.
  const [adding, setAdding] = useState<'subscription' | 'apiKey' | null>(null)
  // An added account signs in again through the same sheet, which shows the code field if asked.
  const [renewing, setRenewing] = useState<AccountProfile | null>(null)
  // A key account takes a new key through the same sheet, with its field only (KERNEL-524).
  const [replacing, setReplacing] = useState<AccountProfile | null>(null)
  // The row whose name is a field (KERNEL-561), and the row to give focus back to once its field is gone.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const renamed = useRef<string | null>(null)
  // The row whose menu is open, and the account Remove asks about.
  const [menu, setMenu] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AccountProfile | null>(null)
  const sheetOpen = !!adding || !!renewing || !!replacing
  const [busy, run] = useBusy<string>()
  const signInAll = useSignInAll()
  const mcp = useMcpAccounts()
  const needs = (a: AccountProfile) => mcp.accounts?.find((m) => m.provider === a.provider && m.accountId === a.id)?.needsYou ?? 0
  const now = Date.now()
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
  useEffect(() => { if (status?.provider === 'codex') noteCodexStatus(status.signedIn) }, [status])
  const read = () => call('providers.status', { provider }).then(setStatus)
  useEffect(() => { void read().catch(() => undefined) }, [provider])
  useEffect(() => {
    if (renaming || busy !== null || !renamed.current) return
    document.querySelector<HTMLElement>(`[aria-label="More for ${CSS.escape(renamed.current)}"]`)?.focus()
    renamed.current = null
  }, [renaming, busy])
  const act = (key: string, title: string, fn: () => Promise<unknown>) => run(key, async () => {
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
  })
  const accountsCall = (key: string, title: string, fn: () => Promise<AccountProfile[]>, done?: () => void) => act(key, title, async () => { actions.accounts.set(await fn()); await read(); done?.() })
  const signIn = (a: AccountProfile) => {
    if (!a.cli) return setRenewing(a)
    return act(`signin:${a.id}`, 'Could not sign in', async () => { setStatus(await call('providers.signIn', { provider, accountId: a.id })); actions.accounts.set(await call('accounts.list', undefined)) })
  }
  const switchTo = (a: AccountProfile) => accountsCall(`use:${a.id}`, 'Could not switch accounts', () => call('accounts.switch', { provider, accountId: a.id }), () => actions.ui.toast({ title: `Switched to ${a.label}`, sub: 'Agents use it from their next turn.' }))
  const signOut = (a: AccountProfile) => accountsCall(`out:${a.id}`, 'Could not sign out', () => call('accounts.signOut', { provider, accountId: a.id }))
  const remove = (a: AccountProfile) => accountsCall(`remove:${a.id}`, 'Could not remove the account', () => call('accounts.remove', { provider, accountId: a.id }), () => actions.ui.toast({ title: `Removed ${a.label}` })).finally(() => setRemoving(null))
  const stopRenaming = () => { if (renaming) renamed.current = accounts.find((a) => a.id === renaming.id)?.label ?? null; setRenaming(null) }
  const saveName = (a: AccountProfile, value: string) => {
    if (value.trim() === a.label) return stopRenaming()
    void accountsCall(`rename:${a.id}`, 'Could not rename the account', async () => {
      const next = await call('accounts.rename', { provider, accountId: a.id, label: value })
      renamed.current = value.trim()
      setRenaming(null)
      return next
    })
  }
  const locked = busy !== null || sheetOpen

  // The row's own action and its menu: one visible action, the rest one click away (feat-providers-redesign).
  const actionFor = (a: AccountProfile): RowAction | undefined => {
    if (a.keychainWait) return undefined
    if (!a.signedIn && a.auth === 'apiKey') return { label: 'Replace key', onClick: () => setReplacing(a) }
    if (!a.signedIn) return { label: 'Sign in', busy: busy === `signin:${a.id}`, busyLabel: 'Signing in', onClick: () => void signIn(a) }
    if (a.legacyToken) return { label: 'Sign in again', onClick: () => setRenewing(a) }
    if (a.active) return undefined
    return { label: 'Switch to', busy: busy === `use:${a.id}`, busyLabel: 'Switching', onClick: () => void switchTo(a) }
  }
  const menuFor = (a: AccountProfile): (MenuEntry | typeof MENU_SEPARATOR)[] => [
    { id: 'rename', label: 'Rename', onSelect: () => setRenaming({ id: a.id, value: a.label }) },
    ...(a.auth === 'apiKey'
      ? [{ id: 'key', label: 'Replace key', onSelect: () => setReplacing(a) }]
      : a.signedIn && !a.legacyToken && !a.keychainWait
        ? [{ id: 'signin', label: 'Sign in again', onSelect: () => void signIn(a) }, { id: 'out', label: 'Sign out', onSelect: () => void signOut(a) }]
        : []),
    ...(a.cli ? [] : [MENU_SEPARATOR, { id: 'remove', label: 'Remove', danger: true, onSelect: () => setRemoving(a) }])
  ]
  const row = (a: AccountProfile) => {
    const view = accountRow(a, usage, now)
    const others = sameOrg(a, accounts)
    const editing = renaming?.id === a.id
    return (
      <AccountRow
        key={a.id} account={a} view={a.keychainWait ? { ...view, windows: [], empty: undefined, resetNote: undefined } : view}
        active={a.active && a.signedIn} action={actionFor(a)} pending={busy === `out:${a.id}` ? 'Signing out' : undefined} locked={locked}
        menu={menuFor(a)} menuHeading={ownLogin(a)} menuOpen={menu === a.id} onMenu={(open) => setMenu(open ? a.id : null)}
        rename={editing ? { value: renaming.value, saving: busy === `rename:${a.id}`, onChange: (value) => setRenaming({ id: a.id, value }), onSave: () => saveName(a, renaming.value), onCancel: stopRenaming } : undefined}
      >
        {a.signedIn && !a.keychainWait && (!!needs(a) || !!signInAll.of(a.provider, a.id).run) && (
          <SignInLine
            label={a.label} needs={needs(a)} {...signInAll.of(a.provider, a.id)} canceling={signInAll.canceling}
            disabled={locked || signInAll.active !== null} onSetUp={() => actions.ui.openModal({ name: 'mcpSetUp', provider: a.provider, accountId: a.id })} onCancel={() => void signInAll.cancel(a.provider)}
          />
        )}
        {a.keychainWait && (
          <>
            <span className="set-warn"><Icon name="warning" size={12} />Waiting for Keychain access</span>
            <span className="set-warn-note">Allow Kernel in the macOS prompt to use this account.</span>
          </>
        )}
        {!a.active && !!others.length && <span className="set-avail"><Icon name="info" size={14} />Same organization as {joinNames(others)}, so they may share limits</span>}
      </AccountRow>
    )
  }

  // The subscription in use hit a limit: say what happens next. With switching on Kernel moves to a subscription with room by itself,
  // else the banner offers the account Kernel's own switch would pick (`switchChoices`, KERNEL-618), which can be a key.
  const autoSwitch = s.accounts.switchAtLimit[provider]
  const inUse = subscriptions.find((a) => a.active && a.signedIn)
  const hit = inUse ? limitHit(inUse, usage, now) : undefined
  const room = hit ? switchChoices(provider, accounts, usage, now).room : []
  const roomSub = room.find((a) => a.auth !== 'apiKey')
  const banner = hit && inUse
    ? autoSwitch && roomSub
      ? { text: `${inUse.label} hit its ${hit.window} limit. Kernel moves agents to ${roomSub.label} at their next turn.` }
      : {
        text: `${inUse.label} hit its ${hit.window} limit.${hit.reset ? ` Agents wait until it resets ${hit.reset}.` : ''}`,
        action: room[0] ? { label: `Switch to ${room[0].label}`, busy: busy === `use:${room[0].id}`, busyLabel: 'Switching', onClick: () => void switchTo(room[0]) } : undefined
      }
    : undefined
  const usable = subscriptions.filter((a) => a.signedIn && !a.keychainWait).length

  const binary = s.providers[provider]
  const exe = binary.path ? 'custom' : binary.useSystem ? 'system' : 'bundled'
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
  const pickExe = (value: string) => {
    if (value === exe && value !== 'custom') return
    if (value === 'custom') return void choose()
    void setPath(value, { path: '', useSystem: value === 'system' })
  }
  const exePath = binary.path || (binary.useSystem ? status?.path : undefined)
  const version = status ? status.version ?? 'Not found' : ''

  return (
    <>
      <section className="set-section">
        <div className="set-section-head">
          <h2>Subscriptions</h2>
          <Button disabled={locked} onClick={() => setAdding('subscription')}>Add account</Button>
        </div>
        {banner && <LimitBanner text={banner.text} action={banner.action} locked={locked} />}
        <div className="set-card">
          {subscriptions.length
            ? subscriptions.map(row)
            : (
              <div className="prov-empty">
                <div className="set-text">
                  <span className="set-label">Sign in to run agents on {NAME[provider]}</span>
                  <span className="set-desc">Use your plan. Keys go under API keys.</span>
                </div>
                <Button variant="primary" disabled={locked} onClick={() => setAdding('subscription')}>Sign in</Button>
              </div>
            )}
        </div>
      </section>
      <section className="set-section">
        <div className="set-section-head">
          <h2>API keys</h2>
          <Button disabled={locked} onClick={() => setAdding('apiKey')}>Add key</Button>
        </div>
        <div className="set-card">
          {keys.length
            ? keys.map(row)
            : (
              <div className="prov-empty">
                <div className="set-text">
                  <span className="set-label">No API keys</span>
                  <span className="set-desc">Add a key to run agents billed per token instead of a plan.</span>
                </div>
              </div>
            )}
        </div>
      </section>
      <Section title="Switching">
        <Row
          label="At a limit, switch to another subscription"
          desc={usable < 2 ? 'Add another subscription to use this.' : `Kernel moves agents to the ${NAME[provider]} subscription with the most room and says so in the chat. It never moves to an API key.`}
        >
          <Toggle label="At a limit, switch to another subscription" disabled={usable < 2} checked={usable >= 2 && autoSwitch} onChange={(v) => void patchSettings({ accounts: { switchAtLimit: { [provider]: v } } })} />
        </Row>
      </Section>
      {provider === 'codex' && (
        <Section title="New chats">
          <Row label="Personality" desc="How Codex talks to you in new chats. It doesn't change what it can do.">
            <SegmentedControl label="Personality" value={s.providers.codex.personality} options={PERSONALITIES} onChange={(v) => void patchSettings({ providers: { codex: { personality: v as CodexPersonality } } })} />
          </Row>
        </Section>
      )}
      <Section title="CLI">
        {status?.error && (
          <div className="set-row prov-problem">
            <Icon name="warning" size={14} />
            <div className="set-text">
              <span className="set-label">Kernel can't run {NAME[provider]}</span>
              <span className="set-desc">{status.error}</span>
            </div>
            {exe !== 'bundled' && <Button busy={busy === 'bundled'} busyLabel="Switching" disabled={busy !== null} onClick={() => void setPath('bundled', { path: '', useSystem: false })}>Use bundled</Button>}
          </div>
        )}
        <Row label="Executable" desc={<>{NAME[provider]} <span className="prov-mono">{version}</span>{exePath && <span className="prov-path">{tilde(exePath)}</span>}</>}>
          <Select label="Executable" options={EXECUTABLES} value={exe} disabled={busy !== null} onChange={(e) => pickExe(e.target.value)} />
        </Row>
        <Row label="Config file" desc={<span className="prov-path">{tilde(status?.configFile ?? '')}</span>}>
          <Button busy={busy === 'config'} busyLabel="Opening" disabled={busy !== null} onClick={() => void act('config', 'Could not open the file', () => call('providers.openConfig', { provider }))}>Open</Button>
        </Row>
      </Section>
      {adding && <AddAccount provider={provider} kind={adding} onClose={() => { setAdding(null); void read().catch(() => undefined) }} />}
      {renewing && <AddAccount provider={provider} signIn={{ label: renewing.label, accountId: renewing.id }} onClose={() => { setRenewing(null); void read().catch(() => undefined) }} />}
      {replacing && <AddAccount provider={provider} replaceKey={{ accountId: replacing.id, label: replacing.label }} onClose={() => { setReplacing(null); void read().catch(() => undefined) }} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          body={`${removing.auth === 'apiKey' ? `Kernel deletes the saved key for ${removing.label}.` : `Kernel signs out of ${removing.label} and deletes its saved login.`}${removing.active ? ` Agents move to ${accounts.find((x) => x.cli)?.label ?? `${NAME[provider]}’s own login`}.` : ''} You can add it again later.`}
          confirmLabel="Remove" danger busy={busy === `remove:${removing.id}`} busyLabel="Removing"
          onConfirm={() => void remove(removing)} onCancel={() => setRemoving(null)}
        />
      )}
    </>
  )
}
