import { useEffect, useState } from 'react'
import { type AccountProfile, type AppSettings, type CodexPersonality, type Provider, type ProviderStatus, type RateLimit } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { clock } from '@shared/usage'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, SegmentedControl, Tabs, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { AddAccount } from './AddAccount'

// Settings, Providers (SettingsProviders.png, SettingsProvidersCodex.png, KERNEL-406, and the API key accounts of
// KERNEL-524). Kernel already calls teammates agents, so the page is Providers. Status is words only, never a dot (DESIGN.md).

const NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }
const SYSTEM: Record<Provider, string> = { claude: 'Use system Claude', codex: 'Use system Codex' }
const PERSONALITIES: { value: CodexPersonality; label: string }[] = [{ value: 'pragmatic', label: 'Pragmatic' }, { value: 'friendly', label: 'Friendly' }, { value: 'none', label: 'None' }]

/** A path under the home folder as Terminal shows it: `~/.codex/config.toml`. */
export const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** "3:40 PM" today, else "Oct 9". */
const when = (ms: number, now: number) => (new Date(ms).toDateString() === new Date(now).toDateString() ? `at ${clock(ms)}` : `on ${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)

/**
 * The account's usage, when Kernel has heard of it: "62% of the 5-hour limit used". An account whose usage comes only from
 * its turns (a Claude token) gives both windows and when its last turn read them, since nothing reads them between turns.
 */
export function accountUsage(a: AccountProfile, usage: RateLimit[], now = Date.now()): string | undefined {
  const mine = usage.filter((u) => limitProvider(u) === a.provider && (u.accountId ?? 'cli') === a.id)
  const pct = (type: RateLimit['type']) => { const u = mine.find((l) => l.type === type)?.utilization; return u === undefined ? undefined : Math.round(u * 100) }
  const hour = pct('five_hour')
  if (!a.usageFromTurns) return hour !== undefined ? `${hour}% of the 5-hour limit used` : undefined
  const week = pct('seven_day')
  const read = Math.max(0, ...mine.filter((l) => l.type === 'five_hour' || l.type === 'seven_day').map((l) => l.readAt ?? 0))
  if (hour === undefined && week === undefined) return 'Usage shows after its first turn'
  const used = [hour !== undefined ? `${hour}% of the 5-hour limit` : undefined, week !== undefined ? `${week}% of the weekly limit` : undefined].filter(Boolean).join(' and ')
  return `${used} used${read ? `, as of its last turn ${when(read, now)}` : ''}`
}

/** What an account row says under its name: the email when the name isn't it, the plan, the CLI login, and its usage. A key says how it is billed. */
export function accountLine(a: AccountProfile, usage: RateLimit[], now = Date.now()): string {
  if (!a.signedIn) return 'Not signed in'
  if (a.auth === 'apiKey') return 'API key · billed per token'
  return [a.email && a.email !== a.label ? a.email : undefined, a.plan, a.cli ? `${NAME[a.provider]}’s own login` : undefined, accountUsage(a, usage, now)].filter(Boolean).join(' · ')
}

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
  // An added Claude account signs in again with a new token, through the same sheet, which shows the code field if asked.
  const [renewing, setRenewing] = useState<string | null>(null)
  // A key account takes a new key through the same sheet, with its field only (KERNEL-524).
  const [replacing, setReplacing] = useState<AccountProfile | null>(null)
  const addedClaude = provider === 'claude' ? accounts.find((a) => a.active && !a.cli && a.auth !== 'apiKey') : undefined
  const activeKey = accounts.find((a) => a.active && a.auth === 'apiKey')
  const sheetOpen = adding || !!renewing || !!replacing
  const [busy, run] = useBusy<string>()
  const read = () => call('providers.status', { provider }).then(setStatus)
  useEffect(() => { void read().catch(() => undefined) }, [provider])
  const act = (key: string, title: string, fn: () => Promise<unknown>) => run(key, async () => {
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
  })
  const accountsCall = (key: string, title: string, fn: () => Promise<AccountProfile[]>) => act(key, title, async () => { actions.accounts.set(await fn()); await read() })
  const signIn = () => addedClaude ? setRenewing(addedClaude.label) : act('signin', 'Could not sign in', async () => { setStatus(await call('providers.signIn', { provider })); actions.accounts.set(await call('accounts.list', undefined)) })
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
        {accounts.map((a) => (
          <Row key={a.id} label={a.label} desc={accountLine(a, usage)}>
            {a.active && a.signedIn && <span className="set-tag">Active</span>}
            <div className="set-entry-actions">
              {!a.active && a.signedIn && <Button variant="ghost" aria-label={`Use ${a.label}`} busy={busy === `use:${a.id}`} busyLabel="Switching" disabled={busy !== null} onClick={() => void accountsCall(`use:${a.id}`, 'Could not switch accounts', () => call('accounts.switch', { provider, accountId: a.id }))}>Use</Button>}
              {!a.signedIn && a.active && a.auth !== 'apiKey' && <Button variant="ghost" aria-label={`Sign in to ${a.label}`} busy={busy === 'signin'} busyLabel="Signing in" disabled={busy !== null} onClick={() => void signIn()}>Sign in</Button>}
              {!a.signedIn && a.auth === 'apiKey' && <Button variant="ghost" aria-label={`Replace the key for ${a.label}`} disabled={busy !== null || sheetOpen} onClick={() => setReplacing(a)}>Replace key</Button>}
              {a.signedIn && a.auth !== 'apiKey' && <Button variant="ghost" aria-label={`Sign out of ${a.label}`} busy={busy === `out:${a.id}`} busyLabel="Signing out" disabled={busy !== null} onClick={() => void accountsCall(`out:${a.id}`, 'Could not sign out', () => call('accounts.signOut', { provider, accountId: a.id }))}>Sign out</Button>}
              {!a.cli && <Button variant="ghost" aria-label={`Remove ${a.label}`} busy={busy === `remove:${a.id}`} busyLabel="Removing" disabled={busy !== null} onClick={() => void accountsCall(`remove:${a.id}`, 'Could not remove the account', () => call('accounts.remove', { provider, accountId: a.id }))}>Remove</Button>}
            </div>
          </Row>
        ))}
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
      {renewing && <AddAccount provider={provider} signIn={{ label: renewing }} onClose={() => { setRenewing(null); void read().catch(() => undefined) }} />}
      {replacing && <AddAccount provider={provider} replaceKey={{ accountId: replacing.id, label: replacing.label }} onClose={() => { setReplacing(null); void read().catch(() => undefined) }} />}
    </>
  )
}
