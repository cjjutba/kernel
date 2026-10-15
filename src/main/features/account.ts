import { MODELS, PROVIDERS, type ClaudeAccount, type Provider, type RateLimit, type SwitchReason } from '@shared/types'
import { nearLimit, resetPhrase, WEEKLY_WARN } from '@shared/usage'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { signOut } from '../services/account'
import { exec } from '../services/exec'
import { blockingLimit, isRejected, NetworkMonitor, WINDOW_MODEL } from '../services/health'
import type { LimitNews } from '../services/leadUpdates'
import { planOf } from '../services/settings'
import { LIMIT_NAME, limitKey } from '../services/providers/limits'
import { limitProvider } from '@shared/providers'
import { Feature } from './feature'

/** While a usage window is rejected, how often Kernel checks whether it lifted. Claude Code answers the usage call from a snapshot under a minute old, so this waits longer than that. */
const LIMIT_RECHECK_MS = 90_000

/** The reason a signed-out Codex holds its chats by. Claude's is 'auth', as it always was. */
const CODEX_AUTH = 'codex-auth'

/** The reason Claude's chats wait while the account in use waits on a macOS Keychain prompt (KERNEL-618). */
const KEYCHAIN = 'keychain'

/**
 * A rejection Kernel moves a provider off, and how far it got (`Account.moving`, KERNEL-568). `to` is the account it picked
 * and `switched` that the switch went through. A move that waits says why and until when nothing has room, the earliest
 * reset across the provider's accounts in seconds, for the Lead (KERNEL-777).
 */
interface Move { at?: number; state: 'reading' | 'waiting' | 'done'; to?: string; switched?: boolean; why?: 'full' | 'signIn'; until?: number; told?: string }

/**
 * An account Kernel switched to by itself that fills within this long stops Kernel switching by itself, so a run of full
 * accounts doesn't use up every one (KERNEL-844).
 */
const CHAIN_MS = 30 * 60_000

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
  /**
   * Windows whose reset sends a notification, by `limitKey`: one the user asked about with "Notify me", and one an account
   * was left at by the limit banner or by Kernel's own switch (`left`, KERNEL-568). Each sends one.
   */
  private notifyReset = new Map<string, { limit: Pick<RateLimit, 'type' | 'provider' | 'accountId' | 'resetsAt'>; left: boolean }>()
  /**
   * Rejections Kernel moves a provider off, by `limitKey`, with the reset time that tells one rejection from the next, so each
   * moves it once (KERNEL-568). A reading can put the reset a second off, so times a minute apart count as the same. `reading`
   * while every account of the provider is read, `waiting` when none had room, which each new reading looks at again, and
   * `done` once it switched.
   */
  private moving = new Map<string, Move>()
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
  /** Kernel's last switch of each provider by itself, at a limit or ahead of one, until the user switches (KERNEL-844). */
  private selfSwitched = new Map<Provider, { from: string; to: string; at: number }>()
  /** Providers Kernel no longer switches by itself, since an account it switched to filled too soon, until the user switches. */
  private noSelfSwitch = new Set<Provider>()
  /** The move-threshold crossing Kernel last acted on, per provider, so each crossing switches once (KERNEL-844). */
  private aheadOf = new Map<Provider, string>()

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
   * provider's chats go on (KERNEL-406). Claude's chats wait at once while Kernel checks whether the login only waits on a
   * Keychain prompt, which Claude Code reads as signed out. Then it isn't marked signed out: its chats wait for the prompt,
   * until someone allows it or Kernel stops keeping it up, and after one nobody allowed they don't wait (KERNEL-618).
   *
   * `on` names the account the failing session started on. When the provider has moved to another account since, only that
   * account reads as signed out: the one in use is not, so no chat waits and its sign-in is not checked
   * (feat-make-claude-account-credentials-and).
   */
  signedOut(provider: Provider = 'claude', on?: { account: string | undefined }) {
    if (on && !this.k.providers.isActive(provider, on.account)) return this.k.providers.credentialRefused(provider, on)
    if (provider === 'codex') return this.codexSignedOut()
    const check = this.k.providers.keychainWaiting()
    if (!check) return this.claudeSignedOut()
    this.sessions.holdAll('auth', { provider: 'claude' })
    void check.catch(() => undefined).then((wait) => {
      if (this.stopped) return
      if (!wait) return this.claudeSignedOut()
      if (wait === 'prompt') this.sessions.holdAll(KEYCHAIN, { provider: 'claude' })
      if (!this.authTimer) this.sessions.releaseAll('auth')
    })
  }

  /**
   * Claude's chats wait on a Keychain prompt no more: someone allowed it, Kernel stopped keeping it up, or Claude moved to
   * another account. With `read`, the account in use is read again (KERNEL-618).
   */
  keychainDone(read = false) {
    this.sessions.releaseAll(KEYCHAIN)
    if (read) void this.accountChanged().catch(() => undefined)
  }

  private claudeSignedOut() {
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
   * lifting by any route sends "Notify me", and the reset of an account left at its limit (KERNEL-568). With "Warn me before
   * the weekly limit" on, the weekly window crossing 80% warns once (KERNEL-220). With "switch at a limit" on, a rejection
   * moves the provider to another account (`switchAtLimit`, KERNEL-568).
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
    for (const [key, w] of this.notifyReset) {
      if (limits.some((l) => limitKey(l) === key && l.status === 'rejected')) continue
      this.notifyReset.delete(key)
      this.resetNotice(key, w, now)
    }
    this.warnWeekly(limits, now)
    // Before `readOthersWhenTight`, whose read a move off a limit makes itself.
    this.switchAtLimit(limits, now)
    this.switchAhead(limits, now)
    this.readOthersWhenTight(limits, now)
    // Utilization of a window that holds teammates stays fresh while it holds, so a drop sends what waited.
    const watching = limits.some((l) => l.status === 'rejected') || (holding && !!nearLimit(limits, now))
    if (watching && !this.limitCheck) { this.limitCheck = setInterval(() => void this.checkLimits(), LIMIT_RECHECK_MS); this.limitCheck.unref?.() }
    if (!watching && this.limitCheck) { clearInterval(this.limitCheck); this.limitCheck = undefined }
  }

  /**
   * A window someone waited on reset. "Notify me" says agents can run again. An account left at its limit says the user can
   * switch back, in the Inbox too, once per window (KERNEL-568).
   */
  private resetNotice(key: string, w: { limit: Pick<RateLimit, 'type' | 'provider' | 'accountId' | 'resetsAt'>; left: boolean }, now: number) {
    const name = LIMIT_NAME[w.limit.type]
    if (!w.left) {
      this.o.showNotification?.({ id: `limit-${key}-${now}`, kind: 'system', title: `Your ${name} reset`, sub: 'Agents can run again.', needsYou: false, read: false, createdAt: now }, { silent: false })
      return
    }
    const title = `${this.k.providers.label(limitProvider(w.limit), w.limit.accountId)}'s ${name} reset`
    this.notifications.notice({ id: `n-reset-${key}-${w.limit.resetsAt ?? now}`, title, sub: 'You can switch back any time.', heading: title, body: `${title}. You can switch back any time.` })
  }

  /**
   * `provider` now runs on `to`, undefined for the CLI's own login (KERNEL-568). That account's windows no longer notify as
   * left behind, since it is in use again. `hit` is the window the account it left had hit, when the limit banner or Kernel
   * moved it off a limit, and its reset sends one notification.
   */
  switched(provider: Provider, to: string | undefined, hit?: RateLimit, reason?: SwitchReason) {
    // The user switching lets Kernel switch by itself again (KERNEL-844).
    if (reason !== 'limit') { this.selfSwitched.delete(provider); this.noSelfSwitch.delete(provider) }
    for (const [key, w] of this.notifyReset) if (w.left && limitProvider(w.limit) === provider && w.limit.accountId === to) this.notifyReset.delete(key)
    if (hit) this.notifyReset.set(limitKey(hit), { limit: hit, left: true })
  }

  /**
   * "Switch at a limit" for each provider that has it on (KERNEL-568). A 5-hour or weekly rejection on the account in use
   * reads every account of the provider, then moves to the one `spareAccount` picks, where the chats the limit held or cut
   * off carry on (`switchTo`, `Sessions.drainWaiting`). Once per rejection, and never back when the old account resets. With
   * no account to move to the rooms stay paused, and a later reading that finds one moves then.
   */
  private switchAtLimit(limits: RateLimit[], now: number) {
    for (const key of this.moving.keys()) if (!limits.some((l) => l.status === 'rejected' && limitKey(l) === key)) this.moving.delete(key)
    for (const { id: p } of PROVIDERS) {
      if (!this.settings?.accounts?.switchAtLimit?.[p]) continue
      const from = this.k.providers.active(p)
      const hit = blockingLimit(limits.filter((l) => limitProvider(l) === p && l.accountId === from), now)
      if (!hit || this.chained(p, from, now)) continue
      const key = limitKey(hit)
      const seen = this.moving.get(key)
      if (seen && Math.abs((seen.at ?? 0) - (hit.resetsAt ?? 0)) <= 60) {
        if (seen.state === 'waiting') this.moveOff(p, from, key, seen, limits)
        continue
      }
      const move: Move = { at: hit.resetsAt, state: 'reading' }
      this.moving.set(key, move)
      // The read covers every account, so `readOthersWhenTight` doesn't read them again.
      this.tight.add(p)
      void this.k.providers.readUsage({ provider: p, force: true }).catch(() => undefined).then((fresh) => {
        if (this.moving.get(key) !== move) return
        move.state = 'waiting'
        this.moveOff(p, from, key, move, fresh ?? this.store.meta<RateLimit[]>('limits') ?? [])
      })
    }
  }

  /**
   * Moves `p` off the rejection on `from` to the account `spareFor` picks: the most room, among the accounts that offer the
   * models its agents start on when one does (KERNEL-616). Reading those models can take a moment, so the move reads as
   * `reading` meanwhile, and nothing happens when the rejection went, the user moved it or turned the switch off.
   */
  private moveOff(p: Provider, from: string | undefined, key: string, move: Move, limits: RateLimit[]) {
    const still = () => !this.stopped && this.moving.get(key) === move && !!this.settings?.accounts?.switchAtLimit?.[p] && this.k.providers.active(p) === from
    if (!still()) return
    // A fresh reading can find the limit lifted.
    if (!blockingLimit(limits.filter((l) => limitProvider(l) === p && l.accountId === from))) return
    move.state = 'reading'
    void this.k.providers.spareFor(p, limits).catch(() => undefined).then((to) => {
      if (!still() || move.state !== 'reading') return
      if (!to) {
        this.moveWaits(p, move, limits, 'full')
        return
      }
      move.state = 'done'
      move.to = to
      // A switch that fails, as on an account that needs a sign-in, leaves the provider where it was (KERNEL-777).
      // Kept before the switch, whose own reading of the limits may already find `to` full (KERNEL-844).
      const self = this.selfSwitch(p, from, to)
      void this.k.moves.switchBySelf(p, to, 'limit').then(() => { move.switched = true }, () => { self.undo(); if (this.moving.get(key) === move) this.moveWaits(p, move, limits, 'signIn') })
    })
  }

  /**
   * An account Kernel switched `p` to by itself (`selfSwitched`) filled within CHAIN_MS of the switch: Kernel stops switching
   * `p` by itself, so the rooms wait for the limit as with the switch off, and one Inbox item says why (KERNEL-844). The user
   * can still switch, which lets Kernel switch by itself again. True while Kernel doesn't switch `p`.
   */
  private chained(p: Provider, account: string | undefined, now: number): boolean {
    if (this.noSelfSwitch.has(p)) return true
    const last = this.selfSwitched.get(p)
    if (!last || last.to !== (account ?? 'cli') || now - last.at >= CHAIN_MS) return false
    this.noSelfSwitch.add(p)
    const name = this.k.providers.label(p, account)
    const minutes = Math.max(1, Math.round((now - last.at) / 60_000))
    const title = `${name} filled within ${minutes} minute${minutes === 1 ? '' : 's'} of the switch, so Kernel stopped moving between accounts`
    this.notifications.notice({
      id: `n-switch-chain-${p}-${last.at}`, title, heading: title, sub: 'You can still switch accounts in Settings, Providers.',
      body: `Kernel switched to ${name} when ${this.k.providers.label(p, last.from)} reached its limit, and ${name} reached its own ${minutes} minute${minutes === 1 ? '' : 's'} later. So that the agents don't use up every account, Kernel won't switch by itself again until you switch accounts yourself. Agents wait for the limit to reset meanwhile.`
    })
    return true
  }

  /** Kernel is about to switch `p` from `from` to `to` by itself. `undo` forgets it when the switch fails. */
  private selfSwitch(p: Provider, from: string | undefined, to: string) {
    const was = this.selfSwitched.get(p)
    const now = { from: from ?? 'cli', to, at: Date.now() }
    this.selfSwitched.set(p, now)
    return { undo: () => { if (this.selfSwitched.get(p) !== now) return; if (was) this.selfSwitched.set(p, was); else this.selfSwitched.delete(p) } }
  }

  /**
   * Ahead of the limit (KERNEL-844): with "switch at a limit" on and chats kept on their account, the account in use crossing
   * the move threshold (5 hour 90%, weekly 95%) switches the provider to the account `spareFor` picks, so new chats start
   * there. Chats on the old account move at their next turn (`Placement.accountFor`), and its idle long chats are summarized
   * there first while their cache is warm (`Moves.compactAhead`). Once per crossing.
   */
  private switchAhead(limits: RateLimit[], now: number) {
    for (const { id: p } of PROVIDERS) {
      const from = this.k.providers.active(p)
      const mine = limits.filter((l) => limitProvider(l) === p && l.accountId === from)
      const near = this.settings?.accounts?.switchAtLimit?.[p] && this.k.placement.keeps() && !blockingLimit(mine, now) ? nearLimit(mine, now) : undefined
      if (!near) { this.aheadOf.delete(p); continue }
      const crossing = `${from ?? 'cli'}:${limitKey(near)}:${Math.round((near.resetsAt ?? 0) / 60)}`
      if (this.aheadOf.get(p) === crossing) continue
      this.aheadOf.set(p, crossing)
      if (this.chained(p, from, now)) continue
      void this.k.providers.spareFor(p, limits, now).catch(() => undefined).then(async (to) => {
        if (!to || this.stopped || this.k.providers.active(p) !== from || !this.settings?.accounts?.switchAtLimit?.[p]) return
        const self = this.selfSwitch(p, from, to)
        try { await this.k.moves.switchBySelf(p, to, 'near') } catch { self.undo(); return }
        await this.k.moves.compactAhead(p, from ?? 'cli')
      }).catch(() => undefined)
    }
  }

  /**
   * Nothing moves `p` off the limit for now: no account has room, which counts accounts that need a sign-in or wait on a
   * Keychain prompt (`spareFor`), or the switch failed.
   * The Lead hears it once, with the earliest reset across the provider's accounts, for the teammates the limit cut off
   * (KERNEL-777). A later reading that finds room still moves it.
   */
  private moveWaits(p: Provider, move: Move, limits: RateLimit[], why: 'full' | 'signIn') {
    const mine = limits.filter((l) => limitProvider(l) === p)
    const resets = [...new Set(mine.map((l) => l.accountId))].flatMap((id) => blockingLimit(mine.filter((l) => l.accountId === id))?.resetsAt ?? [])
    move.state = 'waiting'
    move.why = why
    move.until = resets.length ? Math.min(...resets) : undefined
    // Each reading of the same limits comes through here again, but the Lead hears about one stuck state once.
    const told = `${why}:${move.until ?? ''}`
    if (move.told === told) return
    move.told = told
    this.k.leadUpdates.limitStuck(p, { stuck: why, ...(move.until ? { resetsAt: move.until } : {}) })
  }

  /**
   * What Kernel does about the usage limit that cut off a chat of `provider` running `model` on `account`, undefined for the
   * CLI's own login, for the Lead's Team update (KERNEL-777). A switch is under way while "switch at a limit" is on and the
   * move reads accounts or switches, or once the provider runs on another account. Otherwise the chat waits for the reset:
   * the earliest across accounts when none has room, else the account's own.
   */
  limitNews(provider: Provider, account: string | undefined, model?: string): LimitNews {
    const now = Date.now()
    const mine = (this.store.meta<RateLimit[]>('limits') ?? []).filter((l) => limitProvider(l) === provider && l.accountId === account)
    const hit = blockingLimit(mine, now)
    // A limit on the chat's model alone, which no switch moves off (`limitedModels`).
    const own = hit ? undefined : mine.find((l) => isRejected(l, now) && !!model && (l.model ?? WINDOW_MODEL[l.type]) === model)
    const w = hit ?? own
    const label = (id: string | undefined) => this.k.providers.label(provider, id)
    const news: LimitNews = { provider, account: label(account), ...(w ? { window: LIMIT_NAME[w.type] } : {}), ...(w?.resetsAt ? { resetsAt: w.resetsAt } : {}) }
    if (!hit) return { ...news, stuck: 'model', ...(model ? { model: MODELS.find((m) => m.id === model)?.label ?? model } : {}) }
    const active = this.k.providers.active(provider)
    if (active !== account) return { ...news, switching: { to: label(active) } }
    if (!this.settings?.accounts?.switchAtLimit?.[provider]) return { ...news, stuck: 'off' }
    const move = this.moving.get(limitKey(hit))
    if (move?.state === 'reading') return { ...news, switching: {} }
    if (move?.state === 'done' && !move.switched) return { ...news, switching: move.to ? { to: label(move.to) } : {} }
    if (move?.state === 'waiting') return { ...news, stuck: move.why ?? 'full', ...(move.until ? { resetsAt: move.until } : {}) }
    // The switch went through and the user moved back, with Undo on its notice (KERNEL-699), or no move started.
    return { ...news, stuck: 'off' }
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
    this.notifications.notice({ id: `n-weekly-${weekly.resetsAt}`, title, sub: `Resets ${resetPhrase(weekly.resetsAt, now, { notice: true })}`, heading: title, body: `Your weekly limit resets ${resetPhrase(weekly.resetsAt, now, { notice: true })}.` })
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
      'usage.notifyOnReset': async ({ type, provider = 'claude' }) => {
        // The window on the provider's account in use, the one the banner offering this shows.
        const accountId = this.k.providers.active(provider)
        const key = limitKey({ type, provider, accountId })
        const held = this.limitTimers.get(key)
        if (!held?.rejected) throw new Error('Kernel does not know when this limit resets, so it cannot tell you. Check /usage.')
        this.notifyReset.set(key, { limit: { type, provider, accountId, resetsAt: held.at / 1000 }, left: false })
        return { ok: true }
      },
      'account.signIn': async () => this.signIn(),
      'app.checkOnline': async () => ({ online: this.network ? await this.network.check() : true }),
      // The windows Kernel has, at once: the window waits on this at launch. Every account's fresh read runs behind it, and
      // what each finds goes out as a `usage` push (KERNEL-567). The footer's refresh button forces the read and waits for it; a read
      // that fails leaves the last numbers.
      'usage.get': async (req) => {
        const force = req?.force === true
        const read = this.k.providers.readUsage({ force }).catch(() => undefined)
        if (force) await read
        return this.sessions.usage([])
      }
    } satisfies Partial<Handlers>
  }
}
