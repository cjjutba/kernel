import { PROVIDERS, type ClaudeAccount, type Provider, type RateLimit } from '@shared/types'
import { nearLimit, resetPhrase, WEEKLY_WARN } from '@shared/usage'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { signOut } from '../services/account'
import { exec } from '../services/exec'
import { blockingLimit, NetworkMonitor } from '../services/health'
import { planOf } from '../services/settings'
import { limitKey } from '../services/providers/limits'
import { limitProvider } from '@shared/providers'
import { Feature } from './feature'

/** While a usage window is rejected, how often Kernel checks whether it lifted. Claude Code answers the usage call from a snapshot under a minute old, so this waits longer than that. */
const LIMIT_RECHECK_MS = 90_000

/** What the "Notify me" notification calls each window. Claude Code calls `seven_day_overage_included` the Fable limit. */
const LIMIT_NAME: Record<RateLimit['type'], string> = {
  five_hour: '5-hour limit', seven_day: 'weekly limit', seven_day_opus: 'Opus limit', seven_day_sonnet: 'Sonnet limit', seven_day_overage_included: 'Fable limit', overage: 'extra usage limit'
}

/** The reason a signed-out Codex holds its chats by. Claude's is 'auth', as it always was. */
const CODEX_AUTH = 'codex-auth'

/** How often every account's usage is read while any agent works (KERNEL-567). */
const USAGE_EVERY_MS = 10 * 60_000

/** The Claude account, the connection, and the usage limits that pause the rooms (KERNEL-325). */
export class Account extends Feature {
  network?: NetworkMonitor
  /**
   * One timer per usage window that holds something, at its reset time: a rejected one, or one close to its limit that holds
   * teammates' new work (KERNEL-220). `rejected` is the first kind, the only one "Notify me" can ask about. Keyed by `limitKey`.
   */
  private limitTimers = new Map<string, { at: number; timer: NodeJS.Timeout; rejected: boolean }>()
  /** The last account read, so a sign-out keeps the name on the account menu. */
  private account?: ClaudeAccount
  /** Windows the user asked to hear about when they reset ("Notify me"). */
  private notifyReset = new Set<RateLimit['type']>()
  /** Runs `checkLimits` while any window is rejected, or close to its limit with teammates held. */
  private limitCheck?: NodeJS.Timeout
  private limitChecking?: Promise<void>
  private authTimer?: NodeJS.Timeout
  /** While Codex is signed out, the check every 10 seconds that lifts the hold once it is signed in again (KERNEL-406). */
  private codexAuthTimer?: NodeJS.Timeout
  /** Reads every account's usage every USAGE_EVERY_MS while any agent works (KERNEL-567). */
  private usageTimer?: NodeJS.Timeout
  /** Providers whose account in use is near or at a limit, so only crossing into it reads the other accounts. */
  private tight = new Set<Provider>()

  start() {
    if (this.o.probeNetwork) {
      this.network = new NetworkMonitor({ probe: this.o.probeNetwork, onChange: (online) => this.setOnline(online) })
      this.network.start()
    }
    this.usageTimer = setInterval(() => { if (this.sessions.runningIds().length) void this.k.providers.readUsage().catch(() => undefined) }, USAGE_EVERY_MS)
    this.usageTimer.unref?.()
  }

  stop() {
    this.network?.stop()
    clearInterval(this.authTimer)
    clearInterval(this.codexAuthTimer)
    clearInterval(this.usageTimer)
    for (const t of this.limitTimers.values()) clearTimeout(t.timer)
    this.limitTimers.clear()
    clearInterval(this.limitCheck)
    this.limitCheck = undefined
  }

  // ---------- failures (KERNEL-28)

  /** Main's view of the network. Offline holds every room like a pause; back online sends what queued. */
  private setOnline(online: boolean) {
    bus.push({ type: 'online', online })
    if (online) this.sessions.releaseAll('offline')
    else this.sessions.holdAll('offline')
  }

  /**
   * A session reported an auth failure: its provider is signed out. That provider's chats wait until it is signed in again,
   * by Sign in here or in a terminal (`claude /login`, `codex login`), which a check every 10 seconds picks up. The other
   * provider's chats go on (KERNEL-406).
   */
  signedOut(provider: Provider = 'claude') {
    if (provider === 'codex') return this.codexSignedOut()
    // An added account's token or API key was refused. It reads as signed out until a new one replaces it, or the next check
    // would lift the hold at once.
    this.k.providers.credentialRefused('claude')
    this.sessions.holdAll('auth', { provider: 'claude' })
    bus.push({ type: 'account', account: { ...this.account, signedIn: false } })
    if (this.authTimer) return
    this.authTimer = setInterval(() => void this.readAccount().catch(() => undefined), 10_000)
    this.authTimer.unref?.()
  }

  /** Codex signed out: its chats wait, and Settings, Providers and the account menu say so. A refused API key stays refused (KERNEL-523). */
  private codexSignedOut() {
    this.k.providers.credentialRefused('codex')
    this.sessions.holdAll(CODEX_AUTH, { provider: 'codex' })
    void this.k.providers.pushAccounts()
    if (this.codexAuthTimer) return
    this.codexAuthTimer = setInterval(() => void this.readCodex().catch(() => undefined), 10_000)
    this.codexAuthTimer.unref?.()
  }

  /** A signed-in Codex lifts its hold. */
  private async readCodex() {
    if (!(await this.k.providers.signedIn('codex'))) return
    clearInterval(this.codexAuthTimer); this.codexAuthTimer = undefined
    this.sessions.releaseAll(CODEX_AUTH)
    void this.k.providers.pushAccounts()
  }

  /**
   * Every read of the account can end a sign-out: a signed-in answer lifts the hold and tells the renderer. An account Kernel
   * added reads its email and plan from its own login, so the defaults follow its real plan (KERNEL-567). A legacy token
   * account is what the user said when adding it (KERNEL-406). The CLI's own login is read from the CLI.
   */
  async readAccount(): Promise<ClaudeAccount> {
    const { subscriptionType, ...account } = (await this.k.providers.addedClaudeAccount()) ?? await this.k.accountReader()
    if (!account.signedIn) return account
    this.account = account
    // The defaults follow the plan, so a new plan, or the first read of it, changes what the user never set (KERNEL-225). An
    // API key account has no plan, so the last plan's defaults stay, as after a sign-out (KERNEL-523).
    if (this.k.providers.auth('claude') !== 'apiKey') this.k.config.setPlan(planOf(subscriptionType))
    if (this.sessions.heldFor().includes('auth')) {
      clearInterval(this.authTimer); this.authTimer = undefined
      this.sessions.releaseAll('auth')
      bus.push({ type: 'account', account })
    }
    return account
  }

  /** Claude runs on another account, or the active one has a new token: read it, and tell the account menu. */
  async accountChanged() {
    const account = await this.readAccount()
    this.account = account
    bus.push({ type: 'account', account })
  }

  /** Runs Claude Code's own login with Kernel's own copy (it opens the browser), then reads the account back (KERNEL-277). */
  private async signIn() {
    await exec(this.k.providers.binary('claude').path ?? 'claude', ['auth', 'login'], { timeoutMs: 5 * 60_000 })
    const account = await this.readAccount()
    bus.push({ type: 'account', account })
    if (!account.signedIn) throw new Error('Sign in did not finish. Open a terminal and run claude /login.')
    return account
  }

  /**
   * A 5-hour or weekly rejection pauses every room by `limit` (FloorLimit.png); its end resumes them, and the chats it
   * stopped mid-turn carry on (`Sessions.carryOn`). The limits are saved, so a restart keeps the pause. Each rejected
   * window, and each one close to its limit while teammates are held, gets a timer at its reset time, which marks it allowed
   * again and sends what it held. While any such window stands, `checkLimits` also runs every LIMIT_RECHECK_MS. A window
   * lifting by any route sends "Notify me". With "Warn me before the weekly limit" on, the weekly window crossing 80% warns once (KERNEL-220).
   */
  applyLimits(limits: RateLimit[]) {
    const now = Date.now()
    this.store.saveMeta('limits', limits)
    const rooms = this.store.rooms().filter((r) => !r.archived)
    // A provider is stopped when its active account has a 5-hour or weekly rejection. A room pauses only when every provider
    // its agents run on is stopped, so Codex agents keep working through a Claude limit (KERNEL-406).
    const stopped = (p: Provider) => !!blockingLimit(limits.filter((l) => limitProvider(l) === p && l.accountId === this.k.providers.active(p)), now)
    for (const r of rooms) {
      const uses = this.k.providers.usedIn(r.id)
      const pause = uses.length > 0 && uses.every(stopped)
      if (pause && !r.paused) this.k.rooms.pauseRoom(r.id, 'limit')
      else if (!pause && r.paused && r.pausedBy === 'limit') this.k.rooms.resumeRoom(r.id, 'limit')
    }
    const holding = this.holdsTeammates()
    for (const l of limits) {
      const at = l.resetsAt ? l.resetsAt * 1000 : undefined
      const key = limitKey(l)
      const held = this.limitTimers.get(key)
      const rejected = l.status === 'rejected'
      if ((!rejected && !(holding && nearLimit([l], now))) || !at) { if (held) { clearTimeout(held.timer); this.limitTimers.delete(key) } continue }
      if (held?.at === at) { held.rejected = rejected; continue }
      if (held) clearTimeout(held.timer)
      const timer = setTimeout(() => this.limitReset(key), Math.min(Math.max(0, at - now), 2 ** 31 - 1))
      timer.unref?.()
      this.limitTimers.set(key, { at, timer, rejected })
    }
    for (const type of this.notifyReset) {
      if (limits.some((l) => l.type === type && limitProvider(l) === 'claude' && l.accountId === this.k.providers.active('claude') && l.status === 'rejected')) continue
      this.notifyReset.delete(type)
      this.o.showNotification?.({ id: `limit-${type}-${now}`, kind: 'system', title: `Your ${LIMIT_NAME[type]} reset`, sub: 'Agents can run again.', needsYou: false, read: false, createdAt: now }, { silent: false })
    }
    this.warnWeekly(limits, now)
    this.readOthersWhenTight(limits, now)
    // Utilization of a window that holds teammates stays fresh while it holds, so a drop sends what waited.
    const watching = limits.some((l) => l.status === 'rejected') || (holding && !!nearLimit(limits, now))
    if (watching && !this.limitCheck) { this.limitCheck = setInterval(() => void this.checkLimits(), LIMIT_RECHECK_MS); this.limitCheck.unref?.() }
    if (!watching && this.limitCheck) { clearInterval(this.limitCheck); this.limitCheck = undefined }
  }

  /**
   * The account in use nearing or hitting a limit reads every account of its provider at once, so a switch has current
   * numbers to go by (KERNEL-567). Once per crossing, and only when the provider has another account to read. Holds and
   * pauses still go by the account in use alone.
   */
  private readOthersWhenTight(limits: RateLimit[], now: number) {
    for (const { id: p } of PROVIDERS) {
      const mine = limits.filter((l) => limitProvider(l) === p && l.accountId === this.k.providers.active(p))
      const tight = !!blockingLimit(mine, now) || !!nearLimit(mine, now)
      if (tight && !this.tight.has(p) && this.k.providers.usageReads({ provider: p }).length > 1) void this.k.providers.readUsage({ provider: p, force: true }).catch(() => undefined)
      if (tight) this.tight.add(p)
      else this.tight.delete(p)
    }
  }

  /** Settings, Account: "Pause new work when close to the limit" is on, so a window close to its limit holds teammates. */
  private holdsTeammates(): boolean { return !!this.settings?.usage?.pauseNearLimit }

  /**
   * The usage window of `provider`'s account in use that holds teammates' new work now, as Sessions holds it, or undefined
   * (KERNEL-552). Reviews read it as a round starts: an optional kind is skipped, and a required one starts and waits.
   */
  nearLimit(provider: Provider): RateLimit | undefined {
    if (!this.holdsTeammates()) return undefined
    const limits = this.store.meta<RateLimit[]>('limits') ?? []
    return nearLimit(limits.filter((l) => limitProvider(l) === provider && l.accountId === this.k.providers.active(provider)))
  }

  /**
   * "Warn me before the weekly limit": the weekly window at 80% or more saves one Inbox row and shows one macOS banner. One
   * per window, kept under `weeklyWarned` by its reset time, which a reading from the usage call can put a second off, so
   * times a minute apart count as the same window. A window already past its reset doesn't warn.
   */
  private warnWeekly(limits: RateLimit[], now: number) {
    // Claude's weekly window. Codex reports one too, under the same type (KERNEL-406).
    const weekly = limits.find((l) => l.type === 'seven_day' && limitProvider(l) === 'claude' && l.accountId === this.k.providers.active('claude'))
    if (!this.settings?.usage?.warnBeforeWeekly || !weekly?.resetsAt || weekly.resetsAt * 1000 <= now || (weekly.utilization ?? 0) < WEEKLY_WARN) return
    const warned = this.store.meta<number[]>('weeklyWarned') ?? []
    if (warned.some((at) => Math.abs(at - weekly.resetsAt!) <= 60)) return
    this.store.saveMeta('weeklyWarned', [...warned, weekly.resetsAt].slice(-8))
    const used = Math.round((weekly.utilization ?? WEEKLY_WARN) * 100)
    const title = `You've used ${used}% of this week's limit`
    this.notifications.notice({ id: `n-weekly-${weekly.resetsAt}`, title, sub: `Resets ${resetPhrase(weekly.resetsAt, now)}`, heading: title, body: `Your weekly limit resets ${resetPhrase(weekly.resetsAt, now)}.` })
  }

  private limitReset(key: string) {
    const held = this.limitTimers.get(key)
    if (held) clearTimeout(held.timer)
    this.limitTimers.delete(key)
    this.sessions.resetLimit(key)
  }

  /**
   * A rejected window can lift without Kernel hearing: its timer fires late after the Mac slept, or the limit is reset
   * on claude.ai. Lift what the clock says has reset, then ask Claude Code for the real numbers. While a limit pauses
   * the rooms and no session is live, a short session asks. Runs every LIMIT_RECHECK_MS while a window is rejected, and when the Mac wakes.
   */
  checkLimits(): Promise<void> {
    this.limitChecking ??= (async () => {
      for (const [key, t] of [...this.limitTimers]) if (t.at <= Date.now()) this.limitReset(key)
      // The accounts in use. Claude's gets a short session of its own while a limit pauses the rooms and none is live.
      const paused = this.store.rooms().some((r) => r.pausedBy === 'limit')
      await this.sessions.usage([...this.k.providers.usageReads({ active: true, provider: 'claude', probe: paused }), ...this.k.providers.usageReads({ active: true, provider: 'codex' })])
    })().catch(() => undefined).finally(() => { this.limitChecking = undefined })
    return this.limitChecking
  }

  handlers() {
    return {
      'account.get': async () => this.readAccount(),
      'account.signOut': async () => signOut(this.k.providers.binary('claude').path),
      'usage.notifyOnReset': async ({ type }) => {
        // Claude's window on the account in use, the one the banner offering this shows.
        if (!this.limitTimers.get(limitKey({ type, provider: 'claude', accountId: this.k.providers.active('claude') }))?.rejected) throw new Error('Kernel does not know when this limit resets, so it cannot tell you. Check /usage.')
        this.notifyReset.add(type)
        return { ok: true }
      },
      'account.signIn': async () => this.signIn(),
      'app.checkOnline': async () => ({ online: this.network ? await this.network.check() : true }),
      // The windows Kernel has, at once: the window waits on this at launch. Every account's fresh read runs behind it, and
      // what each finds goes out as a `usage` push (KERNEL-567).
      'usage.get': async () => {
        void this.k.providers.readUsage().catch(() => undefined)
        return this.sessions.usage([])
      }
    } satisfies Partial<Handlers>
  }
}
