import { lookup } from 'node:dns/promises'
import type { ModelId, RateLimit } from '@shared/types'
import { MODELS } from '@shared/types'

// Failure signals for the workspace banners (KERNEL-28). Each one comes from something real:
// an SDK message, a rate_limit_event, a DNS lookup, the hook server's own socket.

/** What a failed request means for the banners. */
export type Failure = 'auth' | 'limit' | 'overloaded' | 'network'

/**
 * The SDK's assistant `error` (and api_retry's) mapped to the banner it calls for. Errors that need no banner of their own
 * (a bad request, a missing model) return undefined and show as the turn's error card.
 */
export function failureOf(error: string | undefined, status?: number | null): Failure | undefined {
  if (!error) return undefined
  if (error === 'authentication_failed' || error === 'oauth_org_not_allowed') return 'auth'
  if (error === 'rate_limit') return 'limit'
  if (error === 'overloaded' || status === 529) return 'overloaded'
  // api_retry sends a null status for connection errors that had no HTTP response at all.
  if (status === null) return 'network'
  return undefined
}

/** Windows that stop every session on the account. A rejection pauses every room until it resets. */
export const ACCOUNT_WINDOWS: RateLimit['type'][] = ['five_hour', 'seven_day', 'seven_day_overage_included']

/** The model a per-model weekly window belongs to. */
export const WINDOW_MODEL: Partial<Record<RateLimit['type'], ModelId>> = { seven_day_opus: 'claude-opus-5-5', seven_day_sonnet: 'claude-sonnet-5-5' }

/** A rejection whose reset time has passed no longer counts. `now` is in milliseconds, `resetsAt` in seconds. */
export const isRejected = (l: RateLimit, now = Date.now()) => l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt * 1000 > now)

/** The account-wide rejection that lifts last, or undefined when sessions may run. */
export function blockingLimit(limits: RateLimit[], now = Date.now()): RateLimit | undefined {
  return limits.filter((l) => ACCOUNT_WINDOWS.includes(l.type) && isRejected(l, now)).sort((a, b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0]
}

/** Models with a rejected per-model window right now. */
export function limitedModels(limits: RateLimit[], now = Date.now()): ModelId[] {
  return limits.filter((l) => isRejected(l, now)).map((l) => l.model ?? WINDOW_MODEL[l.type]).filter((m): m is ModelId => !!m)
}

/** The model to offer when `current` hits its own limit: the first model, in picker order, that is not limited. */
export function fallbackModel(current: ModelId, limited: ModelId[]): ModelId | undefined {
  return MODELS.map((m) => m.id).find((m) => m !== current && !limited.includes(m))
}

/** Can this machine reach Claude? A DNS lookup is the cheapest real answer, and it fails at once with no network. */
export async function probeNetwork(host = 'api.anthropic.com', timeoutMs = 4000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
  try {
    return await Promise.race([lookup(host).then(() => true, () => false), timeout])
  } finally { clearTimeout(timer) }
}

/**
 * Watches the network. Checks every `everyMs` while online and every `offlineMs` while offline, and on demand
 * (a session's connection error, "Try again"). `onChange` fires when the answer flips, and after every check while offline.
 */
export class NetworkMonitor {
  online = true
  private timer?: NodeJS.Timeout
  private running?: Promise<boolean>
  private stopped = false
  constructor(private o: { probe: () => Promise<boolean>; onChange: (online: boolean) => void; everyMs?: number; offlineMs?: number }) {}

  start() { void this.check() }
  stop() { clearTimeout(this.timer); this.timer = undefined; this.stopped = true }

  /** Probe now. Concurrent calls share one probe. */
  check(): Promise<boolean> {
    this.running ??= this.o.probe().catch(() => false).then((online) => {
      this.running = undefined
      const flipped = online !== this.online
      this.online = online
      // Repeated while offline, so a window that opened after the flip still hears it.
      if (flipped || !online) this.o.onChange(online)
      this.schedule()
      return online
    })
    return this.running
  }

  private schedule() {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(() => void this.check(), this.online ? this.o.everyMs ?? 30_000 : this.o.offlineMs ?? 5_000)
    this.timer.unref?.()
  }
}

/** Quote a string for a POSIX shell. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** AppleScript that opens Terminal.app in `cwd` and runs `command` there (WorkspaceSignedOut "Open terminal"). */
export function terminalScript(cwd: string, command?: string): string {
  const line = [`cd ${shellQuote(cwd)}`, command].filter(Boolean).join(' && ')
  const applescript = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return `tell application "Terminal"\n  activate\n  do script ${applescript(line)}\nend tell`
}
