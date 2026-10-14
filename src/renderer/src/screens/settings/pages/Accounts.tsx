import { useEffect, useRef, useState } from 'react'
import { PROVIDERS, type AccountProfile, type AppSettings, type CodexPersonality, type LongChatMove, type Provider, type ProviderStatus } from '@shared/types'
import { resetPhrase } from '@shared/usage'
import { call, cleanError } from '../../../api'
import { actions, getState, go, useStore } from '../../../store'
import { PROVIDER_NAME as NAME, accountRow, ownLogin, tilde, useFreshUsage } from '../../../accountRows'
import { Button, ConfirmDialog, Icon, MENU_SEPARATOR, Menu, ProviderMark, SegmentedControl, Select, Toggle, useBusy, type MenuEntry } from '../../../ui'
import { noteCodexStatus } from '../../workspace/composer/providerModels'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { AddAccount } from './AddAccount'
import { NumberField } from './fields'
import { SignInLine, joinNames, useMcpAccounts, useSignInAll } from './mcpAccounts'
import { AccountRow, blockedUntil, rowCells, type RowAction } from './providerRows'
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

/** Settings, Accounts. The route's `tab` scrolls that provider's group into view. */
export function Accounts({ s }: { s: AppSettings }) {
  const tab = useStore((st) => (st.ui.route.name === 'settings' ? st.ui.route.tab : undefined))
  const accounts = useStore((st) => st.accounts)
  const usage = useStore((st) => st.usage)
  const [statuses, setStatuses] = useState<Partial<Record<Provider, ProviderStatus>>>({})
  // Add account opens the sheet on Subscription or API key for a provider.
  const [adding, setAdding] = useState<{ provider: Provider; kind: 'subscription' | 'apiKey' } | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const addAnchor = useRef<HTMLDivElement>(null)
  // An added account signs in again through the same sheet, which shows the code field if asked. A key account takes a new key through it (KERNEL-524).
  const [renewing, setRenewing] = useState<AccountProfile | null>(null)
  const [replacing, setReplacing] = useState<AccountProfile | null>(null)
  // The row whose name is a field (KERNEL-561), the row to give focus back to once its field is gone, the row whose menu is open, and the one Remove asks about.
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null)
  const renamed = useRef<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AccountProfile | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
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
  const read = (provider: Provider) => call('providers.status', { provider }).then((st) => { setStatuses((all) => ({ ...all, [provider]: st })); if (provider === 'codex') noteCodexStatus(st.signedIn); return st })
  const readAll = () => { for (const p of PROVIDERS) void read(p.id).catch(() => undefined) }
  useEffect(readAll, [])
  useEffect(() => { if (tab) document.getElementById(`ac-group-${tab}`)?.scrollIntoView({ block: 'start' }) }, [tab])
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
  const switchTo = (a: AccountProfile) => act(`use:${keyOf(a)}`, 'Could not switch accounts', () => actions.accounts.requestSwitch(a.provider, a.id, { onSwitched: () => { void read(a.provider).catch(() => undefined); actions.ui.toast({ title: `Switched to ${a.label}`, sub: 'Agents use it from their next turn.' }) } }))
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
  const locked = busy !== null || sheetOpen || addMenu

  // The row's own action: Switch for an account that can take agents, Sign in for one that is signed out.
  const actionFor = (a: AccountProfile, blocked: boolean): RowAction | undefined => {
    const k = keyOf(a)
    if (a.keychainWait) return undefined
    if (!a.signedIn && a.auth === 'apiKey') return { label: 'Replace key', onClick: () => setReplacing(a) }
    if (!a.signedIn) return { label: 'Sign in', busy: busy === `signin:${k}`, busyLabel: 'Signing in', onClick: () => void signIn(a) }
    if (a.legacyToken) return { label: 'Sign in again', onClick: () => setRenewing(a) }
    if (a.active || blocked) return undefined
    return { label: 'Switch', busy: busy === `use:${k}`, busyLabel: 'Switching', onClick: () => void switchTo(a) }
  }
  const menuFor = (a: AccountProfile, blocked: boolean): (MenuEntry | typeof MENU_SEPARATOR)[] => {
    const canSwitch = a.signedIn && !a.active && !a.keychainWait
    return [
      ...(canSwitch ? [{ id: 'switch', label: 'Switch to this account', ...(blocked ? { disabled: true, note: 'At limit' } : {}), onSelect: () => void switchTo(a) }, MENU_SEPARATOR] : []),
      { id: 'rename', label: 'Rename', onSelect: () => setRenaming({ key: keyOf(a), value: a.label }) },
      ...(a.auth === 'apiKey'
        ? [{ id: 'key', label: 'Replace key', onSelect: () => setReplacing(a) }]
        : a.signedIn && !a.legacyToken && !a.keychainWait
          ? [{ id: 'signin', label: 'Sign in again', onSelect: () => void signIn(a) }, { id: 'out', label: 'Sign out', onSelect: () => void signOut(a) }]
          : []),
      ...(a.cli ? [] : [MENU_SEPARATOR, { id: 'remove', label: 'Remove', danger: true, onSelect: () => setRemoving(a) }])
    ]
  }

  const row = (a: AccountProfile, third: string | undefined) => {
    const k = keyOf(a)
    const view = accountRow(a, usage, now)
    const { cells } = rowCells(a, usage, now, third)
    const { blocked, at } = blockedUntil(a, usage, now)
    const out = !a.signedIn
    const key = a.auth === 'apiKey'
    const others = sameOrg(a, accounts)
    const editing = renaming?.key === k
    const note = out ? 'Sign in to see usage' : key ? 'Billed per token' : a.keychainWait ? 'Waiting for Keychain access' : cells.every((c) => !c) ? view.empty : undefined
    const line2 = key ? 'API key' : out ? 'Signed out' : a.plan ?? view.sub ?? ''
    const [five, week, model] = cells
    const details: { k: string; v: React.ReactNode }[] = []
    if (key) details.push({ k: 'Switching', v: 'Only when you pick it' })
    else {
      if (a.email) details.push({ k: 'Email', v: a.email })
      if (view.sub && a.plan) details.push({ k: 'Sign-in', v: view.sub })
      if (five?.reset) details.push({ k: '5-hour', v: `Resets ${five.reset}` })
      if (week?.reset) details.push({ k: 'Weekly', v: `Resets ${week.reset}` })
      if (model && !model.absent && third) details.push({ k: third, v: `Its own weekly limit${model.reset ? `, resets ${model.reset}` : ''}` })
      if (view.asOf) details.push({ k: 'Usage', v: view.asOf })
      if (a.signedIn && !a.keychainWait && (!!needs(a) || !!signInAll.of(a.provider, a.id).run)) {
        details.push({
          k: 'MCP servers',
          v: <SignInLine
            label={a.label} needs={needs(a)} {...signInAll.of(a.provider, a.id)} canceling={signInAll.canceling}
            disabled={locked || signInAll.active !== null} onSetUp={() => actions.ui.openModal({ name: 'mcpSetUp', provider: a.provider, accountId: a.id })} onCancel={() => void signInAll.cancel(a.provider)}
          />
        })
      }
      if (!a.active && !!others.length) details.push({ k: 'Organization', v: `Same organization as ${joinNames(others)}, so they may share limits` })
      details.push({ k: 'Sign-in source', v: a.cli ? `${NAME[a.provider]}’s own login, also used in Terminal` : a.alsoCli ? `Added in Kernel, also ${NAME[a.provider]}’s own login in Terminal` : 'Added in Kernel' })
    }
    const backText = blocked && !out ? (at ? `Back ${resetPhrase(at, now)}` : 'At a limit') : undefined
    return (
      <AccountRow
        key={k} account={a} line2={line2} back={backText} note={note} cells={cells} active={a.active && a.signedIn}
        action={actionFor(a, blocked)} pending={busy === `out:${k}` ? 'Signing out' : undefined} locked={locked}
        menu={menuFor(a, blocked)} menuHeading={ownLogin(a)} menuOpen={menu === k} onMenu={(o) => setMenu(o ? k : null)}
        open={!!open[k]} onToggle={() => setOpen((o) => ({ ...o, [k]: !o[k] }))} details={details}
        rename={editing ? { value: renaming.value, saving: busy === `rename:${k}`, onChange: (value) => setRenaming({ key: k, value }), onSave: () => saveName(a, renaming.value), onCancel: stopRenaming } : undefined}
      >
        {a.keychainWait && <span className="set-warn-note">Allow Kernel in the macOS prompt to use this account.</span>}
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

  const addItems: MenuEntry[] = PROVIDERS.flatMap((p) => [
    { id: `${p.id}-title`, label: NAME[p.id], title: true },
    { id: `${p.id}-subscription`, label: 'Subscription', note: p.id === 'claude' ? 'Pro or Max plan' : 'ChatGPT plan', onSelect: () => setAdding({ provider: p.id, kind: 'subscription' }) },
    { id: `${p.id}-apiKey`, label: 'API key', note: 'Billed per token', onSelect: () => setAdding({ provider: p.id, kind: 'apiKey' }) }
  ])

  const usableOf = (p: Provider) => accounts.filter((a) => a.provider === p && a.auth !== 'apiKey' && a.signedIn && !a.keychainWait).length
  const canSwitch = PROVIDERS.some((p) => usableOf(p.id) >= 2)
  const switching = PROVIDERS.every((p) => s.accounts.switchAtLimit[p.id])

  const finishSheet = (close: () => void) => () => { close(); readAll() }
  return (
    <Page title="Accounts" action={
      <div className="ac-add" ref={addAnchor}>
        <Button variant="primary" icon="plus" aria-haspopup="menu" aria-expanded={addMenu} disabled={busy !== null || sheetOpen} onClick={() => setAddMenu(!addMenu)}>Add account</Button>
        {addMenu && <Menu label="Add account" anchorRef={addAnchor} onClose={() => setAddMenu(false)} style={{ right: 0, top: 36, width: 236 }} items={addItems.map((it) => ({ ...it, ...(it.onSelect ? { onSelect: () => { setAddMenu(false); it.onSelect?.() } } : {}) }))} />}
      </div>
    }>
      {holds.map((h) => (
        <div key={h.provider} className="ac-hold" role="status">
          <span><b>{NAME[h.provider]} is on hold.</b> Every subscription is at a limit{h.until ? ` until ${h.until}` : ''}.</span>
          {h.key && <Button busy={busy === `use:${keyOf(h.key)}`} busyPattern="wave-back" busyLabel="Switching" disabled={locked} onClick={() => void switchTo(h.key!)}>Use {h.key.label}</Button>}
        </div>
      ))}
      {PROVIDERS.map((p) => {
        const mine = accounts.filter((a) => a.provider === p.id)
        const subs = mine.filter((a) => a.auth !== 'apiKey')
        const keys = mine.filter((a) => a.auth === 'apiKey')
        const ordered = [...subs.filter((a) => a.active && a.signedIn), ...subs.filter((a) => !(a.active && a.signedIn)), ...keys]
        const third = mine.map((a) => rowCells(a, usage, now).third).find(Boolean)
        const heads = [{ long: '5-hour', short: '5h' }, { long: 'Weekly', short: 'Wk' }, { long: third ?? '', short: third ? 'Fable' : '' }]
        return (
          <section key={p.id} id={`ac-group-${p.id}`} className="ac-group" aria-label={NAME[p.id]}>
            <div className="ac-grid ac-head">
              <h2><ProviderMark provider={p.id} size={14} />{NAME[p.id]}</h2>
              {heads.map((h, i) => <span key={i} className="ac-colhead" aria-hidden="true"><span className="long">{h.long}</span><span className="short">{h.short}</span></span>)}
              <span />
            </div>
            <div className="ac-card">
              {ordered.length
                ? ordered.map((a) => row(a, third))
                : (
                  <div className="ac-empty">
                    <div className="set-text"><span className="set-label">Sign in to run agents on {NAME[p.id]}</span><span className="set-desc">Use your plan, or add an API key.</span></div>
                    <Button variant="primary" disabled={locked} onClick={() => setAdding({ provider: p.id, kind: 'subscription' })}>Sign in</Button>
                  </div>
                )}
            </div>
          </section>
        )
      })}
      <Section title="Limits">
        <Row id="switch-at-limit" label="Switch accounts at a limit" desc="Move agents to the subscription with the most room.">
          <Toggle label="Switch accounts at a limit" disabled={!canSwitch} checked={canSwitch && switching} onChange={(v) => void patchSettings({ accounts: { switchAtLimit: { claude: v, codex: v } } })} />
        </Row>
        <Row
          id="pause-near-limit"
          label={<>Pause new work near a limit<button type="button" className="icon-btn ac-info" data-tip={PAUSE_HELP} aria-label="About pausing new work"><Icon name="info" size={14} /></button></>}
          desc="Hold new tasks so running ones can finish."
        >
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
      <Section title="Advanced" note="CLI and config files" collapsible>
        {PROVIDERS.map((p) => <CliRows key={p.id} provider={p.id} s={s} status={statuses[p.id]} busy={busy} act={act} setStatus={(st) => setStatuses((all) => ({ ...all, [p.id]: st }))} />)}
      </Section>
      {adding && <AddAccount provider={adding.provider} kind={adding.kind} onClose={finishSheet(() => setAdding(null))} />}
      {renewing && <AddAccount provider={renewing.provider} signIn={{ label: renewing.label, accountId: renewing.id }} onClose={finishSheet(() => setRenewing(null))} />}
      {replacing && <AddAccount provider={replacing.provider} replaceKey={{ accountId: replacing.id, label: replacing.label }} onClose={finishSheet(() => setReplacing(null))} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          body={`${removing.auth === 'apiKey' ? `Kernel deletes the saved key for ${removing.label}.` : `Kernel signs out of ${removing.label} and deletes its saved login.`}${removing.active ? ` Agents move to ${accounts.find((x) => x.provider === removing.provider && x.cli)?.label ?? `${NAME[removing.provider]}’s own login`}.` : ''} You can add it again later.`}
          confirmLabel="Remove" danger busy={busy === `remove:${keyOf(removing)}`} busyPattern="scatter" busyLabel="Removing"
          onConfirm={() => void remove(removing)} onCancel={() => setRemoving(null)}
        />
      )}
    </Page>
  )
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
          {exe !== 'bundled' && <Button busy={busy === `${provider}:bundled`} busyPattern="wave-back" busyLabel="Switching" disabled={busy !== null} onClick={() => void setPath('bundled', { path: '', useSystem: false })}>Use bundled</Button>}
        </div>
      )}
      <Row label="Executable" labelId={`ac-exe-${provider}`} desc={<><span className="ac-mono">{version}</span>{exePath && <span className="ac-path">{tilde(exePath)}</span>}</>}>
        <Select label={`${NAME[provider]} executable`} labelledBy={`ac-exe-${provider}`} options={options} value={exe} disabled={busy !== null} onChange={pickExe} align="right" actions={[{ label: 'Custom folder…', onSelect: () => void choose() }]} />
      </Row>
      <Row label="Config file" desc={<span className="ac-path">{tilde(status?.configFile ?? '')}</span>}>
        <Button aria-label={`Open ${tilde(status?.configFile ?? '') || `${NAME[provider]} config file`}`} busy={busy === `${provider}:config`} busyLabel="Opening" disabled={busy !== null} onClick={() => void act(`${provider}:config`, 'Could not open the file', () => call('providers.openConfig', { provider }))}>Open</Button>
      </Row>
      {provider === 'codex' && (
        <Row setting="providers.codex.personality" label="Personality" desc="How Codex talks to you in new chats. It doesn't change what it can do.">
          <SegmentedControl label="Personality" value={s.providers.codex.personality} options={PERSONALITIES} onChange={(v) => void patchSettings({ providers: { codex: { personality: v as CodexPersonality } } })} />
        </Row>
      )}
    </div>
  )
}
