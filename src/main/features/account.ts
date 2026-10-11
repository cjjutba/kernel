import type { ClaudeAccount, RateLimit } from '@shared/types'
import { nearLimit, resetPhrase, WEEKLY_WARN } from '@shared/usage'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { signOut } from '../services/account'
import { exec } from '../services/exec'
import { blockingLimit, NetworkMonitor } from '../services/health'
import { planOf } from '../services/settings'
import { Feature } from './feature'

/** While a usage window is rejected, how often Kernel checks whether it lifted. Claude Code answers the usage call from a snapshot under a minute old, so this waits longer than that. */
const LIMIT_RECHECK_MS = 90_000

/** What the "Notify me" notification calls each window. Claude Code calls `seven_day_overage_included` the Fable limit. */
const LIMIT_NAME: Record<RateLimit['type'], string> = {
  five_hour: '5-hour limit', seven_day: 'weekly limit', seven_day_opus: 'Opus limit', seven_day_sonnet: 'Sonnet limit', seven_day_overage_included: 'Fable limit', overage: 'extra usage limit'
}

/** The Claude account, the connection, and the usage limits that pause the rooms (KERNEL-325). */
export class Account extends Feature {
  network?: NetworkMonitor
  /**
   * One timer per usage window that holds something, at its reset time: a rejected one, or one close to its limit that holds
   * teammates' new work (KERNEL-220). `rejected` is the first kind, the only one "Notify me" can ask about.
   */
  private limitTimers = new Map<RateLimit['type'], { at: number; timer: NodeJS.Timeout; rejected: boolean }>()
  /** The last account read, so a sign-out keeps the name on the account menu. */
  private account?: ClaudeAccount
  /** Windows the user asked to hear about when they reset ("Notify me"). */
  private notifyReset = new Set<RateLimit['type']>()
  /** Runs `checkLimits` while any window is rejected, or close to its limit with teammates held. */
  private limitCheck?: NodeJS.Timeout
  private limitChecking?: Promise<void>
  private authTimer?: NodeJS.Timeout

  start() {
    if (this.o.probeNetwork) {
      this.network = new NetworkMonitor({ probe: this.o.probeNetwork, onChange: (online) => this.setOnline(online) })
      this.network.start()
    }
  }

  stop() {
    this.network?.stop()
    clearInterval(this.authTimer)
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
   * A session reported an auth failure: Claude Code is signed out. Everything waits until the CLI is signed in again,
   * by Sign in here or by `claude /login` in a terminal, which a check every 10 seconds picks up.
   */
  signedOut() {
    this.sessions.holdAll('auth')
    bus.push({ type: 'account', account: { ...this.account, signedIn: false } })
    if (this.authTimer) return
    this.authTimer = setInterval(() => void this.readAccount().catch(() => undefined), 10_000)
    this.authTimer.unref?.()
  }

  /** Every read of the account can end a sign-out: a signed-in answer lifts the hold and tells the renderer. */
  async readAccount(): Promise<ClaudeAccount> {
    const { subscriptionType, ...account } = await this.k.accountReader()
    if (!account.signedIn) return account
    this.account = account
    // The defaults follow the plan, so a new plan, or the first read of it, changes what the user never set (KERNEL-225).
    this.k.config.setPlan(planOf(subscriptionType))
    if (this.sessions.heldFor().includes('auth')) {
      clearInterval(this.authTimer); this.authTimer = undefined
      this.sessions.releaseAll('auth')
      bus.push({ type: 'account', account })
    }
    return account
  }

  /** Runs Claude Code's own login (it opens the browser), then reads the account back. */
  private async signIn() {
    await exec('claude', ['auth', 'login'], { timeoutMs: 5 * 60_000 })
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
    if (blockingLimit(limits, now)) { for (const r of rooms) if (!r.paused) this.k.rooms.pauseRoom(r.id, 'limit') }
    else for (const r of rooms) if (r.paused && r.pausedBy === 'limit') this.k.rooms.resumeRoom(r.id, 'limit')
    const holding = this.holdsTeammates()
    for (const l of limits) {
      const at = l.resetsAt ? l.resetsAt * 1000 : undefined
      const held = this.limitTimers.get(l.type)
      const rejected = l.status === 'rejected'
      if ((!rejected && !(holding && nearLimit([l], now))) || !at) { if (held) { clearTimeout(held.timer); this.limitTimers.delete(l.type) } continue }
      if (held?.at === at) { held.rejected = rejected; continue }
      if (held) clearTimeout(held.timer)
      const timer = setTimeout(() => this.limitReset(l.type), Math.min(Math.max(0, at - now), 2 ** 31 - 1))
      timer.unref?.()
      this.limitTimers.set(l.type, { at, timer, rejected })
    }
    for (const type of this.notifyReset) {
      if (limits.some((l) => l.type === type && l.status === 'rejected')) continue
      this.notifyReset.delete(type)
      this.o.showNotification?.({ id: `limit-${type}-${now}`, kind: 'system', title: `Your ${LIMIT_NAME[type]} reset`, sub: 'Agents can run again.', needsYou: false, read: false, createdAt: now }, { silent: false })
    }
    this.warnWeekly(limits, now)
    // Utilization of a window that holds teammates stays fresh while it holds, so a drop sends what waited.
    const watching = limits.some((l) => l.status === 'rejected') || (holding && !!nearLimit(limits, now))
    if (watching && !this.limitCheck) { this.limitCheck = setInterval(() => void this.checkLimits(), LIMIT_RECHECK_MS); this.limitCheck.unref?.() }
    if (!watching && this.limitCheck) { clearInterval(this.limitCheck); this.limitCheck = undefined }
  }

  /** Settings, Account: "Pause new work when close to the limit" is on, so a window close to its limit holds teammates. */
  private holdsTeammates(): boolean { return !!this.settings?.usage?.pauseNearLimit }

  /**
   * "Warn me before the weekly limit": the weekly window at 80% or more saves one Inbox row and shows one macOS banner. One
   * per window, kept under `weeklyWarned` by its reset time, which a reading from the usage call can put a second off, so
   * times a minute apart count as the same window. A window already past its reset doesn't warn.
   */
  private warnWeekly(limits: RateLimit[], now: number) {
    const weekly = limits.find((l) => l.type === 'seven_day')
    if (!this.settings?.usage?.warnBeforeWeekly || !weekly?.resetsAt || weekly.resetsAt * 1000 <= now || (weekly.utilization ?? 0) < WEEKLY_WARN) return
    const warned = this.store.meta<number[]>('weeklyWarned') ?? []
    if (warned.some((at) => Math.abs(at - weekly.resetsAt!) <= 60)) return
    this.store.saveMeta('weeklyWarned', [...warned, weekly.resetsAt].slice(-8))
    const used = Math.round((weekly.utilization ?? WEEKLY_WARN) * 100)
    const title = `You've used ${used}% of this week's limit`
    this.notifications.notice({ id: `n-weekly-${weekly.resetsAt}`, title, sub: `Resets ${resetPhrase(weekly.resetsAt, now)}`, heading: title, body: `Your weekly limit resets ${resetPhrase(weekly.resetsAt, now)}.` })
  }

  private limitReset(type: RateLimit['type']) {
    const held = this.limitTimers.get(type)
    if (held) clearTimeout(held.timer)
    this.limitTimers.delete(type)
    this.sessions.resetLimit(type)
  }

  /**
   * A rejected window can lift without Kernel hearing: its timer fires late after the Mac slept, or the limit is reset
   * on claude.ai. Lift what the clock says has reset, then ask Claude Code for the real numbers. While a limit pauses
   * the rooms and no session is live, a short session asks. Runs every LIMIT_RECHECK_MS while a window is rejected, and when the Mac wakes.
   */
  checkLimits(): Promise<void> {
    this.limitChecking ??= (async () => {
      for (const [type, t] of [...this.limitTimers]) if (t.at <= Date.now()) this.limitReset(type)
      const paused = this.store.rooms().some((r) => r.pausedBy === 'limit')
      await this.sessions.usage({ probeIn: paused ? this.o.dataDir : undefined })
    })().catch(() => undefined).finally(() => { this.limitChecking = undefined })
    return this.limitChecking
  }

  handlers() {
    return {
      'account.get': async () => this.readAccount(),
      'account.signOut': async () => signOut(),
      'usage.notifyOnReset': async ({ type }) => {
        if (!this.limitTimers.get(type)?.rejected) throw new Error('Kernel does not know when this limit resets, so it cannot tell you. Check /usage.')
        this.notifyReset.add(type)
        return { ok: true }
      },
      'account.signIn': async () => this.signIn(),
      'app.checkOnline': async () => ({ online: this.network ? await this.network.check() : true }),
      'usage.get': async () => this.sessions.usage()
    } satisfies Partial<Handlers>
  }
}
