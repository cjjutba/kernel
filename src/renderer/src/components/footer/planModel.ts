import { MODELS, PROVIDERS, type AccountProfile, type Provider, type RateLimit } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { resetPhrase } from '@shared/usage'

// What the footer's Usage popover and its row draw (UsagePopover.png, KERNEL-619, KERNEL-674): one section per provider, each from the account that provider runs on,
// never from the first window in the list. Every input is what main pushed, so the sections follow `usage` and `accounts` pushes.

export interface PlanWindow {
  id: string
  title: string
  /** 0 to 1. */
  value: number
  /** Kernel has a number for it that hasn't reset since. Otherwise `value` is 0 and `note` says no usage was reported. */
  reported: boolean
  note: string
}

/** Another signed-in account of the provider, offered under Switch. One waiting for Keychain access isn't offered, since a turn on it would wait too (KERNEL-618). `use` is its 5-hour use, or "Billed per token" for a key. */
export interface PlanOther {
  id: string
  label: string
  plan?: string
  use?: string
}

export interface PlanSection {
  provider: Provider
  name: string
  /** The account the provider runs on, or undefined when it has none signed in. */
  account?: AccountProfile
  /** The active account when it is signed out, so Sign in knows where to go. */
  signedOut?: AccountProfile
  /** The plan, or "API key". */
  plan?: string
  /** Shown under the nickname when the nickname isn't the email already. */
  email?: string
  /** A key in use has no windows. */
  billed: boolean
  windows: PlanWindow[]
  others: PlanOther[]
}

const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id
const WINDOW_MODEL: Partial<Record<RateLimit['type'], string>> = { seven_day_opus: 'Opus 5.5', seven_day_sonnet: 'Sonnet 5.5' }

/** The account's own windows: its provider's, on its id (`accountId` absent is the CLI's own login). */
export const windowsOf = (usage: RateLimit[], a: Pick<AccountProfile, 'provider' | 'id'>): RateLimit[] =>
  usage.filter((l) => limitProvider(l) === a.provider && (l.accountId ?? 'cli') === a.id)

/** A window Kernel has a number for that hasn't reset since. One that has says nothing until the engine reads it again. */
export const live = (l: RateLimit | undefined, now: number): RateLimit | undefined =>
  l?.utilization !== undefined && (l.resetsAt === undefined || l.resetsAt * 1000 > now) ? l : undefined

const note = (l: RateLimit | undefined, now: number): string => {
  if (l?.utilization === undefined) return 'No usage reported yet'
  const used = `${Math.round(l.utilization * 100)}% used`
  return l.resetsAt ? `${used} · resets ${resetPhrase(l.resetsAt, now)}` : used
}

/** 5-hour, Weekly, then one weekly window per model that has its own, each from this account's windows alone. */
export function planWindows(usage: RateLimit[], account: AccountProfile, now: number): PlanWindow[] {
  const mine = windowsOf(usage, account)
  const perModel = mine.filter((l) => l.type === 'seven_day_opus' || l.type === 'seven_day_sonnet' || (l.type !== 'five_hour' && l.type !== 'seven_day' && l.model))
  const rows: { id: string; title: string; limit?: RateLimit }[] = [
    { id: 'five_hour', title: '5-hour', limit: live(mine.find((l) => l.type === 'five_hour' && !l.model), now) },
    { id: 'seven_day', title: 'Weekly', limit: live(mine.find((l) => l.type === 'seven_day' && !l.model), now) },
    ...perModel.map((l) => ({ id: `${l.type}:${l.model ?? ''}`, title: `Weekly, ${l.model ? modelLabel(l.model) : WINDOW_MODEL[l.type] ?? 'one model'}`, limit: live(l, now) })).filter((r) => r.limit)
  ]
  return rows.map((r) => ({ id: r.id, title: r.title, value: r.limit?.utilization ?? 0, reported: r.limit !== undefined, note: note(r.limit, now) }))
}

/** "5-hour 8% used" for a subscription account that has a 5-hour number, nothing otherwise. */
const fiveHourUse = (usage: RateLimit[], a: AccountProfile, now: number): string | undefined => {
  const w = live(windowsOf(usage, a).find((l) => l.type === 'five_hour' && !l.model), now)
  return w?.utilization === undefined ? undefined : `5-hour ${Math.round(w.utilization * 100)}% used`
}

/** One account on Settings, Account and usage: its label, plan and email, and its own windows, or "billed per token" for a key (KERNEL-665). */
export interface PlanAccount {
  account: AccountProfile
  plan?: string
  email?: string
  billed: boolean
  windows: PlanWindow[]
}

/** What both the popover and the page say about one signed-in account. */
function accountView(account: AccountProfile, usage: RateLimit[], now: number): PlanAccount {
  const key = account.auth === 'apiKey'
  return {
    account,
    ...(key ? { plan: 'API key' } : account.plan ? { plan: account.plan } : {}),
    ...(account.email && account.email !== account.label ? { email: account.email } : {}),
    billed: key,
    windows: key ? [] : planWindows(usage, account, now)
  }
}

/** One provider's section. The account it runs on is the active one, which can be an API key (billed per token) or signed out. */
export function planSection(provider: Provider, accounts: AccountProfile[], usage: RateLimit[], now: number): PlanSection {
  const name = PROVIDERS.find((p) => p.id === provider)!.label
  const mine = accounts.filter((a) => a.provider === provider)
  const active = mine.find((a) => a.active)
  const account = active?.signedIn ? active : undefined
  if (!account) return { provider, name, ...(active ? { signedOut: active } : {}), billed: false, windows: [], others: [] }
  const others = mine.filter((a) => a.id !== account.id && a.signedIn && !a.keychainWait).map((a): PlanOther => {
    const use = a.auth === 'apiKey' ? 'Billed per token' : fiveHourUse(usage, a, now)
    return { id: a.id, label: a.label, ...(a.plan ? { plan: a.plan } : {}), ...(use ? { use } : {}) }
  })
  const { account: _, ...view } = accountView(account, usage, now)
  return { provider, name, account, ...view, others }
}

/** Every signed-in account of the provider for the page: the one agents are on first, then the rest in list order. With none signed in, `signedOut` is the one Sign in goes to. */
export function planAccounts(provider: Provider, accounts: AccountProfile[], usage: RateLimit[], now: number): { name: string; accounts: PlanAccount[]; signedOut?: AccountProfile } {
  const name = PROVIDERS.find((p) => p.id === provider)!.label
  const mine = accounts.filter((a) => a.provider === provider)
  const signedIn = mine.filter((a) => a.signedIn)
  const ordered = [...signedIn.filter((a) => a.active), ...signedIn.filter((a) => !a.active)]
  const signedOut = mine.find((a) => a.active) ?? mine[0]
  return { name, accounts: ordered.map((a) => accountView(a, usage, now)), ...(ordered.length || !signedOut ? {} : { signedOut }) }
}

/** Both providers' sections, Claude Code first. A provider with no accounts at all is left out: they haven't loaded yet. */
export function planSections(accounts: AccountProfile[], usage: RateLimit[], now: number): PlanSection[] {
  return PROVIDERS.filter((p) => accounts.some((a) => a.provider === p.id)).map((p) => planSection(p.id, accounts, usage, now))
}
