import { useEffect, useRef, useState } from 'react'
import { PROVIDERS, type AccountProfile, type AppSettings, type CodexPersonality, type LongChatMove, type Provider, type ProviderStatus } from '@shared/types'
import { resetPhrase } from '@shared/usage'
import { call, cleanError } from '../../../api'
import { actions, getState, go, useStore } from '../../../store'
import { PROVIDER_NAME as NAME, accountRow, ownLogin, tilde, useFreshUsage } from '../../../accountRows'
import { oneOf, useRemembered } from '../../../remember'
import { Button, ConfirmDialog, Icon, LinkButton, MENU_SEPARATOR, ProviderMark, SegmentedControl, Select, Spinner, Toggle, useBusy, type MenuEntry } from '../../../ui'
import { noteCodexStatus } from '../../workspace/composer/providerModels'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { AddAccount } from './AddAccount'
import { NumberField } from './fields'
import { joinNames, serverName, useMcpAccounts, useSignInAll } from './mcpAccounts'
import { AccountRow, blockedUntil, rowCells, rowWindows, type RowAction, type RowBadge, type RowNote } from './providerRows'
import './accounts.css'

// Settings, Accounts (Calm.dc.html and its states, KERNEL-680). It replaces Account and usage and Providers: one group per provider with every account's
// meters, the limit rules, and the CLI behind a closed Advanced.

const PERSONALITIES: { value: CodexPersonality; label: string }[] = [{ value: 'pragmatic', label: 'Pragmatic' }, { value: 'friendly', label: 'Friendly' }, { value: 'none', label: 'None' }]
const EXECUTABLES = [{ value: 'bundled', label: 'Bundled with Kernel' }, { value: 'system', label: 'System, from your PATH' }]
const MOVES: { value: LongChatMove; label: string }[] = [{ value: 'summarize', label: 'Summarize first' }, { value: 'continue', label: 'Continue' }, { value: 'ask', label: 'Ask me' }]
const PAUSE_HELP = 'New work waits at 90% of the 5-hour limit or 95% of the weekly one. Your chats with Kernel are never held.'

/** Both providers use account id `cli` for their own login, so every state is keyed by provider and id. */
const keyOf = (a: Pick<AccountProfile, 'provider' | 'id'>) => `${a.provider}:${a.id}`

/** The labels of the provider's other accounts in the same claude.ai organization (`AccountProfile.sameOrg` holds their ids). */
const sameOrg = (a: AccountProfile, accounts: AccountProfile[]) => accounts.filter((x) => x.provider === a.provider && a.sameOrg?.includes(x.id)).map((x) => x.label)

/** Settings, Accounts. The route's `tab` picks which provider's accounts show. */
export function Accounts({ s }: { s: AppSettings }) {
  const tab = useStore((st) => (st.ui.route.name === 'settings' ? st.ui.route.tab : undefined))
  const accounts = useStore((st) => st.accounts)
  const usage = useStore((st) => st.usage)
  const [provider, setProvider] = useRemembered('settings.accounts.provider', oneOf(['claude', 'codex'] as const, 'claude'))
  useEffect(() => { if (tab) setProvider(tab) }, [tab])
  const [statuses, setStatuses] = useState<Partial<Record<Provider, ProviderStatus>>>({})
  // Add account opens the dialog on the picks. An added account signs in again through the same dialog, which shows the code field if asked.
  // A key account takes a new key through it (KERNEL-524).
  const [adding, setAdding] = useState<Provider | null>(null)
  const [renewing, setRenewing] = useState<AccountProfile | null>(null)
  const [replacing, setReplacing] = useState<AccountProfile | null>(null)
  // The row whose name is a field (KERNEL-561), the row to give focus back to once its field is gone, the row whose menu is open, and the one Remove asks about.
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null)
  const renamed = useRef<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AccountProfile | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const sheetOpen = !!adding || !!renewing || !!replacing
  const [busy, run] = useBusy<string>()
  const signInAll = useSignInAll()
  const mcp = useMcpAccounts()
  const needs = (a: AccountProfile) => mcp.accounts?.find((m) => m.provider === a.provider && m.accountId === a.id)?.needsYou ?? 0
  const now = Date.now()
  useFreshUsage(true)

  // Claude Code lists each login's MCP servers that need a sign-in when the page opens, once per login. Main keeps the answer on the account's row.
  useEffect(() => {
    let stopped = false
    void (async () => {
      for (const a of getState().accounts.filter((x) => x.provider === 'claude' && x.signedIn && x.auth !== 'apiKey' && !x.legacyToken && x.mcpSignIns === undefined)) {
        if (stopped) return
        try { actions.accounts.set(await call('accounts.checkMcp', { provider: 'claude', accountId: a.id })) } catch { /* the row stays as it was */ }
      }
    })()
    return () => { stopped = true }
  }, [])
  const read = (p: Provider) => call('providers.status', { provider: p }).then((st) => { setStatuses((all) => ({ ...all, [p]: st })); if (p === 'codex') noteCodexStatus(st.signedIn); return st })
  const readAll = () => { for (const p of PROVIDERS) void read(p.id).catch(() => undefined) }
  useEffect(readAll, [])
  useEffect(() => {
    if (renaming || busy !== null || !renamed.current) return
    document.querySelector<HTMLElement>(`[aria-label="More for ${CSS.escape(renamed.current)}"]`)?.focus()
    renamed.current = null
  }, [renaming, busy])

  const act = (key: string, title: string, fn: () => Promise<unknown>) => run(key, async () => {
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
  })
  const accountsCall = (key: string, title: string, a: AccountProfile, fn: () => Promise<AccountProfile[]>, done?: () => void) => act(key, title, async () => { actions.accounts.set(await fn()); await read(a.provider); done?.() })
  const signIn = (a: AccountProfile) => {
    if (!a.cli) return setRenewing(a)
    return act(`signin:${keyOf(a)}`, 'Could not sign in', async () => {
      const st = await call('providers.signIn', { provider: a.provider, accountId: a.id })
      setStatuses((all) => ({ ...all, [a.provider]: st }))
      actions.accounts.set(await call('accounts.list', undefined))
      if (a.provider === 'claude') actions.account.set(await call('account.get', undefined))
    })
  }
  const switchTo = (a: AccountProfile) => act(`use:${keyOf(a)}`, 'Could not switch accounts', () => actions.accounts.requestSwitch(a.provider, a.id, { onSwitched: () => void read(a.provider).catch(() => undefined) }))
  const signOut = (a: AccountProfile) => accountsCall(`out:${keyOf(a)}`, 'Could not sign out', a, () => call('accounts.signOut', { provider: a.provider, accountId: a.id }))
  const remove = (a: AccountProfile) => accountsCall(`remove:${keyOf(a)}`, 'Could not remove the account', a, () => call('accounts.remove', { provider: a.provider, accountId: a.id }), () => actions.ui.toast({ title: `Removed ${a.label}` })).finally(() => setRemoving(null))
  const stopRenaming = () => { if (renaming) renamed.current = accounts.find((a) => keyOf(a) === renaming.key)?.label ?? null; setRenaming(null) }
  const saveName = (a: AccountProfile, value: string) => {
    if (value.trim() === a.label) return stopRenaming()
    void accountsCall(`rename:${keyOf(a)}`, 'Could not rename the account', a, async () => {
      const next = await call('accounts.rename', { provider: a.provider, accountId: a.id, label: value })
      renamed.current = value.trim()
      setRenaming(null)
      return next
    })
  }
  const running = useStore((st) => st.ui.switching ?? null)
  const switchingTo = (a: AccountProfile) => running?.provider === a.provider && running.accountId === a.id
  const locked = busy !== null || running !== null || sheetOpen
  const setUp = (a: AccountProfile) => actions.ui.openModal({ name: 'mcpSetUp', provider: a.provider, accountId: a.id })

  // The row's own action: Switch (Use for a key) for an account that can take agents, Sign in for one that is signed out or has MCP servers that need it, Move for a legacy login.
  const actionFor = (a: AccountProfile, blocked: boolean, mcpNeeds: number): RowAction | undefined => {
    const k = keyOf(a)
    if (a.keychainWait) return undefined
    if (!a.signedIn && a.auth === 'apiKey') return { label: 'Replace key', onClick: () => setReplacing(a) }
    if (!a.signedIn) return { label: 'Sign in', busy: busy === `signin:${k}`, busyLabel: 'Signing in', onClick: () => void signIn(a) }
    if (a.legacyToken) return { label: 'Move', onClick: () => setRenewing(a) }
    if (mcpNeeds > 0) return { label: 'Sign in', onClick: () => setUp(a) }
    if (a.active || blocked) return undefined
    return { label: a.auth === 'apiKey' ? 'Use' : 'Switch', onClick: () => void switchTo(a) }
  }
  const menuFor = (a: AccountProfile, blocked: boolean): (MenuEntry | typeof MENU_SEPARATOR)[] => {
    const canSwitch = a.signedIn && !a.active && !a.keychainWait
    return [
      { id: 'rename', label: 'Rename', icon: 'pen', onSelect: () => setRenaming({ key: keyOf(a), value: a.label }) },
      ...(canSwitch ? [{ id: 'switch', label: 'Use for new work', icon: 'star' as const, ...(blocked ? { disabled: true, note: 'At limit' } : {}), onSelect: () => void switchTo(a) }] : []),
      ...(a.auth === 'apiKey'
        ? [{ id: 'key', label: 'Replace key', icon: 'key' as const, onSelect: () => setReplacing(a) }]
        : a.signedIn && !a.legacyToken && !a.keychainWait
          ? [{ id: 'signin', label: 'Sign in again', icon: 'refresh' as const, onSelect: () => void signIn(a) }, { id: 'out', label: 'Sign out', icon: 'arrowRight' as const, onSelect: () => void signOut(a) }]
          : []),
      ...(a.cli ? [] : [MENU_SEPARATOR, { id: 'remove', label: 'Remove', icon: 'trash' as const, danger: true, onSelect: () => setRemoving(a) }])
    ]
  }

  const row = (a: AccountProfile) => {
    const k = keyOf(a)
    const view = accountRow(a, usage, now)
    const { cells, third } = rowCells(a, usage, now)
    const { blocked } = blockedUntil(a, usage, now)
    const out = !a.signedIn
    const key = a.auth === 'apiKey'
    const others = sameOrg(a, accounts)
    const editing = renaming?.key === k
    const sign = signInAll.of(a.provider, a.id)
    const live = sign.running || (!!sign.run && !sign.run.finished)
    const failed = sign.run?.finished ? sign.run.failed : []
    // The row's own Sign in and its note give way to the sign-in's rows while it runs and after it fails.
    const needing = a.signedIn && !a.keychainWait && !live && !failed.length ? (a.mcpSignIns?.length ?? needs(a)) : 0
    const chats = a.chats ? `${a.chats} chat${a.chats === 1 ? '' : 's'}` : undefined
    const sub = out ? 'Signed out'
      : key ? `Billed per token${a.active ? '' : ' · Only when you pick it'}`
      : a.legacyToken ? 'Saved with an older sign-in. Move it to a full sign-in to show its email and plan.'
      : [a.email && a.email !== a.label ? a.email : undefined, a.plan, chats].filter(Boolean).join(' · ')
    const badges: RowBadge[] = [
      ...(a.active && a.signedIn ? [{ text: 'In use' }] : []),
      ...(a.cli || a.alsoCli ? [{ text: 'Terminal' }] : !key && !a.legacyToken ? [{ text: 'Added in Kernel' }] : []),
      ...(a.legacyToken ? [{ text: 'Legacy' }] : []),
      ...(blocked && !out ? [{ text: 'At limit', tone: 'limit' as const }] : [])
    ]
    const names = a.mcpSignIns?.length ? joinNames(a.mcpSignIns.map((m) => serverName(m.server))) : ''
    const notes: RowNote[] = [
      ...(a.alsoCli ? [{ icon: 'term' as const, text: `${NAME[a.provider]} in Terminal uses this account too, so its usage counts here.` }] : []),
      ...(!a.active && !!others.length ? [{ icon: 'team' as const, text: `Same organization as ${joinNames(others)}, so they share one limit.` }] : []),
      ...(a.keychainWait ? [{ icon: 'lock' as const, text: 'Waiting for Keychain access. Allow Kernel in the macOS prompt to use this account.' }] : []),
      ...(needing > 0 ? [{ icon: 'plug' as const, text: `${needing} MCP server${needing === 1 ? '' : 's'} need${needing === 1 ? 's' : ''} a sign-in for this account${names ? `: ${names}` : ''}.` }] : []),
      ...(a.signedIn && !key && !a.keychainWait && !cells.some(Boolean) ? [{ text: view.empty ?? 'No usage reported yet' }] : []),
      ...(view.asOf ? [{ text: view.asOf }] : []),
      ...(sign.run?.finished && sign.run.canceled ? [{ text: `Canceled after ${sign.run.done.length} of ${sign.run.servers.length}` }] : [])
    ]
    const pending = busy === `out:${k}` ? 'Signing out' : busy === `use:${k}` || switchingTo(a) ? 'Switching' : undefined
    return (
      <AccountRow
        key={k} account={a} name={a.label} badges={badges} sub={sub} windows={rowWindows(cells, third)} notes={notes}
        action={actionFor(a, blocked, needing)} pending={pending} locked={locked}
        menu={menuFor(a, blocked)} menuHeading={ownLogin(a)} menuOpen={menu === k} onMenu={(o) => setMenu(o ? k : null)}
        rename={editing ? { value: renaming.value, saving: busy === `rename:${k}`, onChange: (value) => setRenaming({ key: k, value }), onSave: () => saveName(a, renaming.value), onCancel: stopRenaming } : undefined}
      >
        {live && (
          <div className="ac-subrow" role="status">
            <div className="set-text">
              <span className="set-label">{sign.run?.current ? serverName(sign.run.current) : 'MCP servers'}</span>
              <span className="set-desc">{sign.run?.current ? 'Finish signing in in your browser.' : 'Getting the next one ready.'}</span>
            </div>
            <span className="ac-pending"><Spinner label={null} pattern="ripple" />Signing in</span>
            <LinkButton aria-label={`Cancel setting up ${a.label}`} busy={signInAll.canceling} busyLabel="Canceling" busyPattern="ripple" onClick={() => void signInAll.cancel(a.provider)}>Cancel</LinkButton>
          </div>
        )}
        {failed.map((f) => (
          <div key={f.server} className="ac-subrow">
            <div className="set-text"><span className="set-label">{serverName(f.server)}</span><span className="set-desc">Not signed in</span></div>
            <Button aria-label={`Try again, ${serverName(f.server)} on ${a.label}`} disabled={locked || signInAll.active !== null} onClick={() => setUp(a)}>Try again</Button>
          </div>
        ))}
      </AccountRow>
    )
  }

  // A provider is on hold when every subscription that can take agents is at a limit and agents aren't on an API key.
  const holds = PROVIDERS.flatMap((p) => {
    const mine = accounts.filter((a) => a.provider === p.id)
    const subs = mine.filter((a) => a.auth !== 'apiKey' && a.signedIn && !a.keychainWait)
    const state = subs.map((a) => blockedUntil(a, usage, now))
    const inUse = mine.find((a) => a.active && a.signedIn)
    if (!subs.length || !state.every((b) => b.blocked) || !inUse || inUse.auth === 'apiKey') return []
    const times = state.flatMap((b) => (b.at ? [b.at] : []))
    const key = mine.find((a) => a.auth === 'apiKey' && a.signedIn)
    return [{ provider: p.id, until: times.length ? resetPhrase(Math.min(...times), now) : undefined, key }]
  })

  const usableOf = (p: Provider) => accounts.filter((a) => a.provider === p && a.auth !== 'apiKey' && a.signedIn && !a.keychainWait).length
  const canSwitch = PROVIDERS.some((p) => usableOf(p.id) >= 2)
  const switching = PROVIDERS.every((p) => s.accounts.switchAtLimit[p.id])
  // Fallback moves new work to the other provider, so it needs a signed-in account on each (KERNEL-1056).
  const signedOut = PROVIDERS.filter((p) => !accounts.some((a) => a.provider === p.id && a.signedIn))
  const canFallBack = signedOut.length === 0

  const mine = accounts.filter((a) => a.provider === provider)
  const subs = mine.filter((a) => a.auth !== 'apiKey')
  const keys = mine.filter((a) => a.auth === 'apiKey')
  const ordered = [...subs.filter((a) => a.active && a.signedIn), ...subs.filter((a) => !(a.active && a.signedIn)), ...keys]
  const hold = holds.find((h) => h.provider === provider)
  const finishSheet = (close: () => void) => () => { close(); readAll() }
  return (
    <Page title="Accounts" desc="The accounts agents run on, and what Kernel does at a limit.">
      <Section title="Providers" plain>
        <div><SegmentedControl label="Providers" value={provider} options={PROVIDERS.map((p) => ({ value: p.id, label: NAME[p.id] }))} onChange={(v) => setProvider(v as Provider)} /></div>
      </Section>
      <Section title={`${NAME[provider]} accounts`} plain action={<span className="ac-note-head">{NAME[provider]}'s own login is marked Terminal</span>}>
        <div className="set-card ac-card" id={`ac-group-${provider}`}>
          {hold && (
            <div className="ac-hold" role="status">
              <span><b>{NAME[hold.provider]} is on hold.</b> Every subscription is at a limit{hold.until ? ` until ${hold.until}` : ''}.</span>
              {hold.key && <Button busy={busy === `use:${keyOf(hold.key)}` || switchingTo(hold.key)} busyPattern="ripple" busyLabel="Switching" disabled={locked} onClick={() => void switchTo(hold.key!)}>Use {hold.key.label}</Button>}
            </div>
          )}
          {ordered.length
            ? <>
                {ordered.map((a) => row(a))}
                <button type="button" className="ac-addrow" disabled={locked} onClick={() => setAdding(provider)}><Icon name="plus" size={14} />Add account</button>
              </>
            : (
              <div className="ac-empty">
                <div className="set-text"><span className="set-label">Sign in to run agents on {NAME[provider]}</span><span className="set-desc">Use your plan, or add an API key.</span></div>
                <Button variant="primary" disabled={locked} onClick={() => setAdding(provider)}>Sign in</Button>
              </div>
            )}
        </div>
      </Section>
      <Section title="Limits">
        <Row id="switch-at-limit" label="Switch accounts at a limit" desc="Moves agents to the account with the most room.">
          <Toggle label="Switch accounts at a limit" disabled={!canSwitch} checked={canSwitch && switching} onChange={(v) => void patchSettings({ accounts: { switchAtLimit: { claude: v, codex: v } } })} />
        </Row>
        <Row id="provider-fallback" label="When every account is at its limit, start new work on the other provider" desc={canFallBack ? 'Uses the role’s model for the other provider, set in Models and effort.' : `Sign in to ${signedOut.map((p) => NAME[p.id]).join(' and ')} to use this.`}>
          <Toggle label="When every account is at its limit, start new work on the other provider" disabled={!canFallBack} checked={canFallBack && s.providers.fallback} onChange={(v) => void patchSettings({ providers: { fallback: v } })} />
        </Row>
        <Row id="pause-near-limit" label="Pause new work near a limit" desc={PAUSE_HELP}>
          <Toggle label="Pause new work near a limit" checked={s.usage.pauseNearLimit} onChange={(v) => void patchSettings({ usage: { pauseNearLimit: v } })} />
        </Row>
        <Row id="weekly-limit-warning" label="Weekly limit warning" desc="Notify me at 80% of a weekly limit.">
          <Toggle label="Weekly limit warning" checked={s.usage.warnBeforeWeekly} onChange={(v) => void patchSettings({ usage: { warnBeforeWeekly: v } })} />
        </Row>
      </Section>
      <Section title="Chats and accounts">
        <Row id="keep-chats" setting="accounts.keepChatsOnAccount" label="Keep chats on their account" desc="A switch changes the account for new chats. Chats stay where their cache is, so they don't read their history again.">
          <Toggle label="Keep chats on their account" checked={s.accounts.keepChatsOnAccount} onChange={(v) => void patchSettings({ accounts: { keepChatsOnAccount: v } })} />
        </Row>
        {PROVIDERS.map((p) => (
          <Row key={p.id} id={`long-chat-move-${p.id}`} setting="accounts.longChatMove" label={`When a long chat moves to another account, ${NAME[p.id]}`} desc="Summarizing first keeps the chat short on the new account.">
            <Select label={`${NAME[p.id]}, when a long chat moves`} align="right" value={s.accounts.longChatMove[p.id]} options={MOVES} onChange={(v) => void patchSettings({ accounts: { longChatMove: { [p.id]: v as LongChatMove } } })} />
          </Row>
        ))}
        <Row id="long-chat" setting="accounts.longChatTokens" label="Long chat" desc="Chats this big are the ones a switch asks about.">
          <NumberField label="Long chat" value={s.accounts.longChatTokens} unit="tokens" min={1000} onSave={(longChatTokens) => patchSettings({ accounts: { longChatTokens } }).then((saved) => saved?.accounts.longChatTokens)} />
        </Row>
      </Section>
      <section className="set-section" aria-label="Advanced" data-row="advanced" data-keep-id="advanced">
        <div className="set-section-head">
          <button type="button" className="ac-fold" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Icon name="right" size={12} /><h2>Advanced</h2></button>
          <span className="set-section-act ac-note-head">CLI and config files</span>
        </div>
        {advanced && (
          <div className="set-card">
            {PROVIDERS.map((p) => <CliRows key={p.id} provider={p.id} s={s} status={statuses[p.id]} busy={busy} act={act} setStatus={(st) => setStatuses((all) => ({ ...all, [p.id]: st }))} />)}
          </div>
        )}
      </section>
      {adding && <AddAccount provider={adding} onClose={finishSheet(() => setAdding(null))} />}
      {renewing && <AddAccount provider={renewing.provider} signIn={{ label: renewing.label, accountId: renewing.id }} onClose={finishSheet(() => setRenewing(null))} />}
      {replacing && <AddAccount provider={replacing.provider} replaceKey={{ accountId: replacing.id, label: replacing.label }} onClose={finishSheet(() => setReplacing(null))} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          body={removeBody(removing, accounts)}
          confirmLabel="Remove" danger busy={busy === `remove:${keyOf(removing)}`} busyPattern="ripple" busyLabel="Removing"
          onConfirm={() => void remove(removing)} onCancel={() => setRemoving(null)}
        />
      )}
    </Page>
  )
}

/** What Remove tells you: the account is signed out and forgotten, and the chats on it move to the account in use first. */
function removeBody(a: AccountProfile, accounts: AccountProfile[]): string {
  const target = accounts.find((x) => x.provider === a.provider && x.active && x.id !== a.id) ?? accounts.find((x) => x.provider === a.provider && x.cli && x.id !== a.id)
  const chats = a.chats ? ` ${a.chats} chat${a.chats === 1 ? '' : 's'} run${a.chats === 1 ? 's' : ''} on it now${target ? `, and Kernel moves ${a.chats === 1 ? 'it' : 'them'} to ${target.label} first` : ''}.` : ''
  return `${a.auth === 'apiKey' ? 'Kernel deletes the saved key.' : 'Kernel signs it out and forgets it.'}${chats}${chats ? '' : ' You can add it again later.'}`
}

/** One provider's Advanced rows: its executable, config file and, for Codex, its personality. */
function CliRows({ provider, s, status, busy, act, setStatus }: {
  provider: Provider; s: AppSettings; status?: ProviderStatus; busy: string | null
  act: (key: string, title: string, fn: () => Promise<unknown>) => Promise<unknown>; setStatus: (st: ProviderStatus) => void
}) {
  const binary = s.providers[provider]
  const exe = binary.path ? 'custom' : binary.useSystem ? 'system' : 'bundled'
  const setPath = (key: string, o: { path?: string; useSystem?: boolean }) => act(`${provider}:${key}`, 'Could not change the executable', async () => {
    setStatus(await call('providers.setPath', { provider, ...o }))
    actions.settings.set(await call('settings.get', undefined))
  })
  const choose = () => act(`${provider}:choose`, 'Could not change the executable', async () => {
    const folder = await call('system.pickFolder', undefined)
    if (!folder) return
    setStatus(await call('providers.setPath', { provider, path: `${folder.replace(/\/$/, '')}/${provider}` }))
    actions.settings.set(await call('settings.get', undefined))
  })
  const pickExe = (value: string) => { if (value !== exe) void setPath(value, { path: '', useSystem: value === 'system' }) }
  const exePath = binary.path || (binary.useSystem ? status?.path : undefined)
  const version = status ? status.version ?? 'Not found' : ''
  const options = exe === 'custom' ? [...EXECUTABLES, { value: 'custom', label: 'Custom folder' }] : EXECUTABLES
  return (
    <div className="ac-adv-group" role="group" aria-label={NAME[provider]}>
      <div className="ac-adv-head"><ProviderMark provider={provider} size={12} />{NAME[provider]}</div>
      {status?.error && (
        <div className="ac-problem">
          <Icon name="warning" size={14} />
          <div className="set-text">
            <span className="set-label">Kernel can't run {NAME[provider]}</span>
            <span className="set-desc">{status.error}</span>
          </div>
          {exe !== 'bundled' && <Button busy={busy === `${provider}:bundled`} busyPattern="ripple" busyLabel="Switching" disabled={busy !== null} onClick={() => void setPath('bundled', { path: '', useSystem: false })}>Use bundled</Button>}
        </div>
      )}
      <Row label="Executable" labelId={`ac-exe-${provider}`} desc={<><span className="ac-mono">{version}</span>{exePath && <span className="ac-path">{tilde(exePath)}</span>}</>}>
        <Select label={`${NAME[provider]} executable`} labelledBy={`ac-exe-${provider}`} options={options} value={exe} disabled={busy !== null} onChange={pickExe} align="right" actions={[{ label: 'Custom folder…', onSelect: () => void choose() }]} />
      </Row>
      <Row label="Config file" desc={<span className="ac-path">{tilde(status?.configFile ?? '')}</span>}>
        <Button icon="ext" aria-label={`Open ${tilde(status?.configFile ?? '') || `${NAME[provider]} config file`}`} busy={busy === `${provider}:config`} busyLabel="Opening" disabled={busy !== null} onClick={() => void act(`${provider}:config`, 'Could not open the file', () => call('providers.openConfig', { provider }))}>Open</Button>
      </Row>
      {provider === 'codex' && (
        <Row setting="providers.codex.personality" label="Personality" desc="How Codex talks to you in new chats. It doesn't change what it can do.">
          <SegmentedControl label="Personality" value={s.providers.codex.personality} options={PERSONALITIES} onChange={(v) => void patchSettings({ providers: { codex: { personality: v as CodexPersonality } } })} />
        </Row>
      )}
    </div>
  )
}
