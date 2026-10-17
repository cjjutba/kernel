import { useEffect } from 'react'
import type { AccountProfile, Provider, RateLimit } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { clock, resetPhrase, usagePercent } from '@shared/usage'
import { call } from './api'
import { actions } from './store'

/** A path under the home folder as Terminal shows it: `~/.codex/config.toml`. */
export const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }

/** "at 3:40 PM" today, else "on Oct 9". */
const when = (ms: number, now: number) => (new Date(ms).toDateString() === new Date(now).toDateString() ? `at ${clock(ms)}` : `on ${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)

/** The account's own windows, as the engine last read them (`accountId` absent is the CLI's own login). */
const windowsOf = (a: AccountProfile, usage: RateLimit[]) => usage.filter((u) => limitProvider(u) === a.provider && (u.accountId ?? 'cli') === a.id && !u.model)

/** When a token account's last turn read its windows, for "As of its last turn at 2:10 PM". */
const lastRead = (a: AccountProfile, usage: RateLimit[], now: number): string | undefined => {
  const read = Math.max(0, ...windowsOf(a, usage).filter((l) => l.type === 'five_hour' || l.type === 'seven_day').map((l) => l.readAt ?? 0))
  return read ? `As of its last turn ${when(read, now)}` : undefined
}

/** "Claude Code’s own login" for the CLI's login, the heading of its row's menu. */
export const ownLogin = (a: AccountProfile) => (a.cli ? `${PROVIDER_NAME[a.provider]}’s own login` : undefined)

/** One usage window on an account row: its name, how much is used (0 to 100) and when it resets, as "tomorrow at 4:00 AM". */
export interface RowWindow { title: string; pct: number; reset?: string }

/** What an account row in Settings, Providers shows under its name (feat-providers-redesign). */
export interface AccountRowView {
  /** The email when the nickname isn't it, "Billed per token" for a key, "Signed out", or the legacy token's ask. */
  sub?: string
  /** The 5-hour and weekly windows Kernel has a live number for. A key has none. */
  windows: RowWindow[]
  /** Said in place of the meters when there is no window to show. */
  empty?: string
  /** When a token account's last turn read its windows. */
  asOf?: string
  /** When the windows at 75% or more reset: "Weekly resets tomorrow at 4:00 AM". */
  resetNote?: string
}

/** A window from 75% on is close enough to say when it resets, the step where its meter turns amber. */
const NEAR = 75

/**
 * What an account row says under its name, as data for the row to draw: one line under the name, the meters, and the notes
 * under them. A key says how it is billed, a signed-out account says so, and a legacy token account asks for a new sign-in and
 * shows the windows its last turn read.
 */
export function accountRow(a: AccountProfile, usage: RateLimit[], now = Date.now()): AccountRowView {
  if (!a.signedIn) return { sub: 'Signed out', windows: [] }
  if (a.auth === 'apiKey') return { sub: 'Billed per token', windows: [] }
  const mine = windowsOf(a, usage)
  const windows = ([['five_hour', '5-hour'], ['seven_day', 'Weekly']] as const).flatMap(([type, title]): RowWindow[] => {
    const w = mine.find((l) => l.type === type)
    if (w?.utilization === undefined || (w.resetsAt !== undefined && w.resetsAt * 1000 <= now)) return []
    return [{ title, pct: usagePercent(w.utilization), ...(w.resetsAt !== undefined ? { reset: resetPhrase(w.resetsAt, now) } : {}) }]
  })
  const sub = a.legacyToken ? 'Sign in again to show email and plan' : a.email && a.email !== a.label ? a.email : undefined
  const near = windows.filter((w) => w.pct >= NEAR && w.reset)
  const asOf = a.usageFromTurns && windows.length ? lastRead(a, usage, now) : undefined
  return {
    ...(sub ? { sub } : {}),
    windows,
    ...(windows.length ? {} : { empty: a.usageFromTurns ? 'Usage shows after its first turn' : 'No usage reported yet' }),
    ...(asOf ? { asOf } : {}),
    ...(near.length ? { resetNote: near.map((w) => `${w.title} resets ${w.reset}`).join('. ') } : {})
  }
}

/**
 * The 5-hour or weekly window that stopped an account: rejected and not reset since, by the rule `switchChoices` uses. It names
 * the window in lower case for "hit its weekly limit" and says when it resets.
 */
export function limitHit(a: AccountProfile, usage: RateLimit[], now = Date.now()): { window: string; reset?: string } | undefined {
  const hit = windowsOf(a, usage).find((l) => (l.type === 'five_hour' || l.type === 'seven_day') && l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt * 1000 > now))
  if (!hit) return undefined
  return { window: hit.type === 'five_hour' ? '5-hour' : 'weekly', ...(hit.resetsAt !== undefined ? { reset: resetPhrase(hit.resetsAt, now) } : {}) }
}

/** Asks the engine for fresh usage while `active`: the account menu, or Settings, Providers, is open. What it reads arrives as pushes. */
export function useFreshUsage(active: boolean) {
  useEffect(() => {
    if (active) void call('usage.get', undefined).then(actions.usage.set).catch(() => undefined)
  }, [active])
}
