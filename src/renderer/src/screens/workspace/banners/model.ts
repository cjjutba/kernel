import type { AccountProfile, BannerKind, Chat, ClaudeAccount, HookStatus, ModelId, Provider, RateLimit, ScriptLine, ToastAction, Workspace } from '@shared/types'
import { MODELS, PROVIDERS } from '@shared/types'
import { chatProvider, limitProvider } from '@shared/providers'
import { clock, nearLimit, pctLabel, resetPhrase, switchChoices, WEEKLY_WARN } from '@shared/usage'

export { clock, resetPhrase }

// Which failure banner a workspace shows, worked out from the store alone (KERNEL-28). Every input is a real signal
// main pushed: usage from rate_limit_event, the account, main's network check, api_retry, setup's exit, the hook server.

export type BannerAction =
  | 'queue' | 'notify' | 'usage' | 'wait' | 'switch'
  | 'newChat' | 'compact' | 'switchModel' | 'retryNow' | 'tryAgain'
  | 'terminal' | 'signIn' | 'editScript' | 'runAgain' | 'checkHooks' | 'reconnect' | 'archive' | 'switchAccount' | 'providers'
  | 'switchBack' | 'models' | 'signInAccount' | 'dismiss'

export type BannerId = 'folder' | 'signedOut' | 'offline' | 'setup' | 'weekly' | 'session' | 'model' | 'accountNearLimit' | 'nearLimit' | 'weeklyWarn' | 'switchWarning' | 'overloaded' | 'context' | 'hooks'

export interface BannerView {
  id: BannerId
  /** `warn` is a heads-up that stops nothing (KERNEL-619). */
  kind: BannerKind | 'warn'
  title: string
  sub: string
  actions: { id: BannerAction; label: string; primary?: boolean }[]
  /** The composer can't take a message until this clears ("Paused until this is resolved"). */
  blocks: boolean
  /** The limit "Notify me" asks about. */
  limit?: RateLimit['type']
  /** The model "Switch to" moves the chat to. */
  switchTo?: ModelId
  /** The account "Switch to" moves the provider to (KERNEL-406). Switching is always the user's click. */
  switchAccount?: { provider: Provider; accountId: string; label: string }
  /** The signed-out account a limit banner asks the user to sign in to, `cli` for the provider's own login (KERNEL-619). */
  signIn?: { provider: Provider; accountId: string; label: string; cli: boolean }
  /** Set on the banners the user can close until their window resets (KERNEL-595), the near-limit offer to switch accounts too (KERNEL-569). */
  dismissKey?: string
  /**
   * Where it shows (Pen 14.7). Only a limit that needs a choice is a banner above the composer. Provider, network and Mac errors are a toast, raised once when the condition starts,
   * and `none` has neither: the composer's placeholder says it all.
   */
  as?: 'toast' | 'none'
  /** The toast for `as: 'toast'`. `key` names the condition, so it is raised once until the condition clears. */
  toast?: { key: string; title: string; sub: string; actions: ToastAction[] }
  /** What the composer's placeholder says while this holds, so a person sees why a message can't go (Pen 14.7). */
  placeholder?: string
}

/**
 * What a closed limit banner is remembered by: the banner and the window it spoke of. `resetsAt` is epoch seconds. A new window has a
 * new one. `scope` tells apart windows of different accounts, which can reset at the same second (KERNEL-569).
 */
export const limitBannerKey = (id: BannerId, resetsAt: number, scope?: string) => `${id}:${scope ? `${scope}:` : ''}${resetsAt}`
/** A window that has reset can never match its key again, so the key can go. */
export const limitBannerExpired = (key: string, now: number) => Number(key.slice(key.lastIndexOf(':') + 1)) * 1000 <= now

export interface BannerInput {
  ws: Workspace
  chat?: Chat
  agentName: string
  running: boolean
  usage: RateLimit[]
  account: ClaudeAccount | null
  online: boolean
  hooks: HookStatus | null
  retry?: { attempt: number; of: number; nextAt: number }
  /** The workspace's script output, for the setup command that failed. */
  scripts?: ScriptLine[]
  setupCode?: number | null
  /** The workspace is the Lead's. The near-limit hold doesn't apply to it, so it has no banner for it (KERNEL-224). */
  isLead?: boolean
  /** The Lead's name, for "Kernel can still answer you". */
  leadName?: string
  /** Nothing in the chat is held for setup, so setup running or failing doesn't hold it and the composer stays open (KERNEL-490, KERNEL-1012). */
  skipsSetup?: boolean
  /** The chat has history, so setup doesn't lock its box (KERNEL-1018). */
  hasHistory?: boolean
  /** Messages in the chat wait in main until its workspace is made. Only then does the banner say messages queue (KERNEL-1018). */
  heldForSetup?: boolean
  /** The limit banners the user closed, by `limitBannerKey`. Only the near-limit, 80% and switch-account banners look here (KERNEL-595). */
  dismissed?: ReadonlySet<string>
  /** Settings, Providers: Kernel switches this chat's provider on its own at a limit, so the near-limit offer would only nag (KERNEL-569). */
  switchAtLimit?: boolean
  /** Settings, Accounts "Keep chats on their account". Left out counts as on, the default (KERNEL-841). */
  keepChats?: boolean
  /** Settings, Account. A switch left out counts as on, which is the default. */
  usageSettings?: { pauseNearLimit?: boolean; warnBeforeWeekly?: boolean }
  /** Both providers' accounts (KERNEL-406). Without them every limit counts as the Claude login's, as before. */
  accounts?: AccountProfile[]
  /** A role or this chat runs on Codex, so the banners name the provider (KERNEL-406). */
  codexInUse?: boolean
  now: number
}

/** From this much context use the chat offers to compact. */
export const CONTEXT_WARN = 90

/** `resetsAt` is epoch seconds. A rejection whose reset has passed no longer counts. */
const rejected = (l: RateLimit, now: number) => l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt * 1000 > now)
const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id

/** "Artkin", "Artkin and Sean", "Artkin, Sean and Christian". */
const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`)

/** "3:40 PM" today, else "tomorrow at 4:00 AM", "Monday at 9:00 AM" or "Oct 21 at 9:00 AM": the time something waits until. */
const untilPhrase = (resetsAt: number, now: number) => resetPhrase(resetsAt, now).replace(/^at /, '')

/** The model to offer when `current` hits its own limit: the first current one, in picker order, that is not limited. */
export function fallbackModel(current: string, usage: RateLimit[], now: number): ModelId | undefined {
  const limited = new Set(usage.filter((l) => rejected(l, now) && l.model).map((l) => l.model))
  return MODELS.filter((m) => !m.legacy).map((m) => m.id).find((m) => m !== current && !limited.has(m))
}

/** "pnpm install" from the script's "$ pnpm install --frozen-lockfile && cp …" line. */
export function setupCommand(lines: ScriptLine[] = []): string | undefined {
  const cmd = [...lines].reverse().find((l) => l.kind === 'setup' && l.line.startsWith('$ '))?.line.slice(2).split(' && ')[0]
  const words = cmd?.split(/\s+/).filter((w) => w && !w.startsWith('-')).slice(0, 2)
  return words?.length ? words.join(' ') : undefined
}

/** The one banner this workspace shows, most pressing first, or null. */
export function bannerFor(i: BannerInput): BannerView | null {
  const { ws, chat, agentName: name, now } = i
  // KERNEL-406: a chat hears only its own provider's limits, on the account that provider runs on now.
  const provider: Provider = chat ? chatProvider(chat) : 'claude'
  const providerName = PROVIDERS.find((p) => p.id === provider)!.label
  const otherName = PROVIDERS.find((p) => p.id !== provider)!.label
  const accounts = (i.accounts ?? []).filter((a) => a.provider === provider)
  const current = accounts.find((a) => a.active)
  const active = current?.id ?? 'cli'
  const windowsOf = (id: string) => i.usage.filter((l) => limitProvider(l) === provider && (l.accountId ?? 'cli') === id)
  // A chat kept on the account that holds its cache runs there while that account is signed in, below its limits and the move
  // threshold, as main's `Placement.accountFor` decides, so it hears that account's windows, not the one in use (KERNEL-941).
  const kept = chat && i.keepChats !== false && chat.ranOn && chat.ranOn !== active ? chat.ranOn : undefined
  const keptRuns = !!kept && accounts.some((a) => (a.id === kept || (kept === 'cli' && a.alsoCli)) && a.signedIn) &&
    !windowsOf(kept).some((l) => (l.type === 'five_hour' || l.type === 'seven_day') && rejected(l, now)) &&
    // A chat the user chose to keep stays past the move threshold, as `accountFor` lets it (KERNEL-844).
    (chat?.moveChoice?.choice === 'keep' || !nearLimit(windowsOf(kept), now))
  const usage = windowsOf(keptRuns && kept ? kept : active)
  const named = (what: string) => (i.codexInUse ? `${providerName} ${what}` : what)
  // Where the provider can go: the same answer Kernel's own switch at a limit uses (`switchChoices`, KERNEL-618). The other signed-in accounts with no rejected
  // window take over with one click, a subscription before an API key, which a switch starts paying for (KERNEL-524), and the one with the most 5-hour headroom first
  // (KERNEL-569). One waiting on a Keychain prompt never is, and one in the active account's organization only when its own windows say it has headroom.
  const choices = switchChoices(provider, accounts, i.usage, now)
  const subscriptions = choices.headroom.filter((a) => a.auth !== 'apiKey')
  const alt = choices.headroom[0]
  const switchAccount = alt ? { provider, accountId: alt.id, label: alt.label } : undefined
  const switchAction = alt ? [{ id: 'switchAccount' as const, label: alt.auth === 'apiKey' ? 'Use API key' : `Switch to ${alt.label}`, primary: true }] : []
  // No account has headroom and one that would is signed out: the banner says so and offers its sign-in, which is how a limit gets past (KERNEL-618, KERNEL-619).
  const signedOut = choices.signedOut
  const signIn = signedOut ? { provider, accountId: signedOut.id, label: signedOut.label, cli: signedOut.cli } : undefined
  const signInAction = signedOut ? [{ id: 'signInAccount' as const, label: 'Sign in', primary: true }] : []
  const signedOutNote = signedOut ? ` ${signedOut.label} is signed out. Sign in to switch to it.` : ''
  const keepGoing = i.codexInUse ? ` Agents on ${otherName} keep working.` : ''
  const billed = alt?.auth === 'apiKey' ? ` ${alt.label} is billed per token.` : ''

  // A worktree deleted outside Kernel has nowhere to run anything, so it says so first, like a failed setup (KERNEL-291).
  if (ws.folderGone) return {
    id: 'folder', kind: 'setup', title: "This workspace's folder is gone",
    sub: `${ws.path} was deleted outside Kernel. Archive it, then restore it from History to make the folder again.`,
    actions: [], blocks: true, as: 'none', placeholder: "This chat's folder is gone. Archive the chat, or put the folder back."
  }

  const codexOut = provider === 'codex' && accounts.find((a) => a.active && !a.signedIn)
  if (codexOut) return {
    id: 'signedOut', kind: 'auth', title: 'Codex is signed out', sub: 'Agents on Codex cannot run until you sign in. Workspaces and chats are safe.',
    actions: [{ id: 'providers', label: 'Sign in', primary: true }], blocks: true, as: 'toast', placeholder: 'Sign in to Codex to keep going',
    toast: { key: `signedOut:codex:${codexOut.id}`, title: 'Codex is signed out', sub: 'Agents on Codex cannot run until you sign in. Workspaces and chats are safe.', actions: [{ label: 'Sign in', route: { name: 'settings', page: 'accounts', tab: 'codex' }, primary: true }] }
  }

  // An account Kernel added signs in from its row in Settings, Accounts, in its own folder. `claude /login` in a terminal and the
  // banner's own sign-in would sign in the CLI's login instead (KERNEL-941).
  if (provider === 'claude' && i.account && !i.account.signedIn) {
    const added = !!current && !current.cli && !current.alsoCli
    const title = added ? `${current.label} is signed out` : 'Claude Code is signed out'
    return {
      id: 'signedOut', kind: 'auth', title, sub: 'Agents cannot run until you sign in. Workspaces and chats are safe.',
      actions: added ? [{ id: 'providers', label: 'Sign in', primary: true }] : [{ id: 'terminal', label: 'Open terminal' }, { id: 'signIn', label: 'Sign in', primary: true }],
      blocks: true, as: 'toast', placeholder: `Sign in to ${added ? current.label : 'Claude Code'} to keep going`,
      toast: added
        ? { key: `signedOut:claude:${current.id}`, title, sub: 'Sign in again from Settings, Accounts to use it.', actions: [{ label: 'Sign in', route: { name: 'settings', page: 'accounts', tab: 'claude' }, primary: true }] }
        : { key: 'signedOut:claude:cli', title, sub: 'Run claude auth login in Terminal, then try again.', actions: [{ label: 'Copy command', copy: 'claude auth login' }, { label: 'Try again', recheckAccount: true, primary: true }] }
    }
  }

  if (!i.online) return {
    id: 'offline', kind: 'offline', title: "You're offline", sub: 'Messages you send wait in the queue.',
    actions: [], blocks: false, as: 'toast', placeholder: "You're offline. Messages queue until you're back.",
    toast: { key: 'offline', title: "You're offline", sub: 'Messages you send wait in the queue.', actions: [] }
  }

  // Setup failed and nothing waits for it: the chat keeps working, so the banner says so and never blocks (KERNEL-1012). That is a
  // failed setup in a chat that isn't held, whether main marked the workspace failed (no worktree, nothing sent) or let it run on.
  const run = ws.setupRun
  const ranOn = ws.status === 'ready' && !!run?.endedAt && run.end !== 0 && run.end !== null && run.end !== undefined
  if ((ws.status === 'failed' && i.skipsSetup) || ranOn) return {
    id: 'setup', kind: 'setup', title: 'Setup failed', sub: `${name} keeps working without it.`,
    actions: [{ id: 'editScript', label: 'Edit script' }, { id: 'runAgain', label: 'Rerun setup', primary: true }], blocks: false
  }

  if (ws.status === 'failed') {
    const cmd = setupCommand(i.scripts)
    const what = cmd ? `${cmd} exited` : 'The setup script exited'
    const code = i.setupCode
    return {
      id: 'setup', kind: 'setup', title: 'Setup script failed',
      sub: `${code === null || code === undefined ? `${cmd ?? 'The setup script'} did not finish` : `${what} with code ${code}`}.${i.hasHistory ? (i.heldForSetup ? ' Messages you send go out when you run it again.' : '') : ` ${name} starts when you run it again.`}`,
      actions: [{ id: 'editScript', label: 'Edit script' }, { id: 'runAgain', label: 'Run again', primary: true }], blocks: !i.hasHistory
    }
  }

  // Fable's own weekly limit (`seven_day_overage_included`) is a model limit, shown below.
  // "Notify me" knows the Claude login's windows, so a Codex window or an added account's offers its other actions.
  const notify = provider === 'claude' && active === 'cli'
  const weekly = usage.find((l) => l.type === 'seven_day' && rejected(l, now))
  if (weekly) {
    const held = i.codexInUse ? `Agents on ${providerName} wait until it resets.` : 'Every project is paused.'
    return {
      id: 'weekly', kind: 'limit', title: i.codexInUse ? `You've hit ${providerName}'s weekly limit` : "You've hit this week's limit",
      sub: `${weekly.resetsAt ? `Resets ${resetPhrase(weekly.resetsAt, now)}. ${held}${keepGoing}` : i.codexInUse ? `${held}${keepGoing}` : 'Every project is paused until it resets.'}${billed}${signedOutNote}`,
      actions: [...(notify ? [{ id: 'notify' as const, label: 'Notify me', primary: !alt && !signedOut }] : []), ...switchAction, ...signInAction],
      blocks: !alt, limit: weekly.type, switchAccount, signIn
    }
  }

  const session = usage.find((l) => l.type === 'five_hour' && rejected(l, now))
  if (session) {
    const after = i.running ? `${name} finishes this step, then waits.` : `${name} finished this turn and stopped.`
    return {
      id: 'session', kind: 'limit', title: `You've hit your ${named('5-hour limit')}`,
      sub: `${session.resetsAt ? `Resets ${resetPhrase(session.resetsAt, now)}. ` : ''}${after}${keepGoing}${billed}${signedOutNote}`,
      actions: alt || signedOut
        ? [...(notify ? [{ id: 'notify' as const, label: 'Notify me' }] : []), ...switchAction, ...signInAction]
        : notify ? [{ id: 'notify' as const, label: 'Notify me', primary: true }] : [],
      blocks: false, limit: 'five_hour', switchAccount, signIn
    }
  }

  const own = chat && usage.find((l) => l.model === chat.model && rejected(l, now))
  if (chat && own) {
    const to = fallbackModel(chat.model, usage, now)
    const when = own.resetsAt ? `It resets ${resetPhrase(own.resetsAt, now)}.` : 'It resets on its own.'
    return {
      id: 'model', kind: 'limit', title: `${modelLabel(chat.model)}'s own limit is used up`,
      sub: to ? `${name} can carry on with ${modelLabel(to)} until it resets${own.resetsAt ? ` ${resetPhrase(own.resetsAt, now)}` : ''}.` : when,
      actions: to ? [{ id: 'wait', label: 'Not now' }, { id: 'switch', label: `Use ${modelLabel(to)}`, primary: true }] : [],
      blocks: false, limit: own.type, switchTo: to
    }
  }

  // The account in use is close to a window's limit and another subscription account has headroom: the user can move first. A key never
  // is offered, and with Kernel switching at a limit on its own the offer would only nag. Closed per account and window, and a
  // switch from it closes it too, so it comes at most once per window (KERNEL-569).
  const near = nearLimit(usage, now)
  const roomy = subscriptions.find((a) => !nearLimit(windowsOf(a.id), now))
  if (current && roomy && near?.resetsAt && !i.switchAtLimit) {
    const key = limitBannerKey('accountNearLimit', near.resetsAt, `${provider}:${active}`)
    if (!i.dismissed?.has(key)) return {
      id: 'accountNearLimit', kind: 'limit',
      title: `${current.label} is ${near.utilization === undefined ? 'close to' : `at ${pctLabel(near.utilization)} of`} its ${named(near.type === 'five_hour' ? '5-hour window' : 'weekly window')}`,
      sub: `${roomy.label} has room. New work can move there now.`,
      actions: [{ id: 'dismiss', label: 'Not now' }, { id: 'switchAccount', label: 'Move new work', primary: true }],
      blocks: false, switchAccount: { provider, accountId: roomy.id, label: roomy.label }, dismissKey: key
    }
  }

  // A switch to an account whose plan lacks a model agents start on: their next turns there would fail, so say which agents and offer the way back or the
  // place to pick another model. Closed until midnight, the way the Inbox says it once a day (KERNEL-616, KERNEL-619).
  const lacks = current && current.auth !== 'apiKey' ? current.missingModels : undefined
  if (current && lacks?.length) {
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    const key = limitBannerKey('switchWarning', Math.floor(midnight.getTime() / 1000), `${provider}:${current.id}:${lacks.map((m) => m.model).join('+')}`)
    const back = accounts.find((a) => a.id !== current.id && a.signedIn && a.auth !== 'apiKey' && !a.missingModels?.length)
    const agents = [...new Set(lacks.flatMap((m) => m.agents))]
    if (!i.dismissed?.has(key)) return {
      id: 'switchWarning', kind: 'warn', title: `${current.label}\u2019s plan has no ${names(lacks.map((m) => m.label))}`,
      sub: `${names(agents)} ${agents.length === 1 ? 'uses' : 'use'} ${lacks.length === 1 ? 'it' : 'them'}.`,
      actions: [...(back ? [{ id: 'switchBack' as const, label: `Switch back to ${back.label}` }] : []), { id: 'models', label: 'Change roles', primary: true }],
      blocks: false, switchAccount: back ? { provider, accountId: back.id, label: back.label } : undefined, dismissKey: key
    }
  }

  // A window close to its limit holds teammates' new work (KERNEL-220). Nothing is blocked: turns that run go on, and the Lead can still answer.
  // Only this chat's provider counts, as in the engine (KERNEL-406).
  const usageAction = provider === 'claude' ? [{ id: 'usage' as const, label: 'See usage' }] : []
  // Closing one is remembered for its window (KERNEL-595). The next banner in line shows in its place, and so does the 80% one when
  // the week that holds teammates is the one the user closed: it would say the same thing about the same window.
  const closed = (id: BannerId, resetsAt: number) => !!i.dismissed?.has(limitBannerKey(id, resetsAt))
  const held = !i.isLead && i.usageSettings?.pauseNearLimit !== false ? near : undefined
  if (held?.resetsAt && !closed('nearLimit', held.resetsAt)) return {
    id: 'nearLimit', kind: 'limit', title: `${held.utilization === undefined ? 'Most' : pctLabel(held.utilization)} of the ${named(held.type === 'five_hour' ? '5-hour window' : 'weekly window')} used`,
    sub: `Turns in progress finish. New work waits until ${untilPhrase(held.resetsAt, now)}.`,
    actions: notify ? [{ id: 'notify', label: 'Notify me' }] : usageAction, blocks: false, limit: held.type, dismissKey: limitBannerKey('nearLimit', held.resetsAt)
  }

  const week = usage.find((l) => l.type === 'seven_day' && l.resetsAt !== undefined && l.resetsAt * 1000 > now && (l.utilization ?? 0) >= WEEKLY_WARN)
  if (week?.resetsAt && i.usageSettings?.warnBeforeWeekly !== false && !closed('weeklyWarn', week.resetsAt) && !closed('nearLimit', week.resetsAt)) return {
    id: 'weeklyWarn', kind: 'limit', title: `${pctLabel(week.utilization ?? WEEKLY_WARN)} of this week's ${named('limit')} used`,
    sub: `It resets ${resetPhrase(week.resetsAt, now)}.`, actions: usageAction, blocks: false, dismissKey: limitBannerKey('weeklyWarn', week.resetsAt)
  }

  if (i.retry) {
    const secs = Math.max(0, Math.ceil((i.retry.nextAt - now) / 1000))
    const vendor = provider === 'codex' ? 'OpenAI' : 'Anthropic'
    const left = (n: number) => `${n} second${n === 1 ? '' : 's'}`
    return {
      id: 'overloaded', kind: 'retry', title: `${vendor} is overloaded`,
      sub: `${secs > 0 ? `Retrying in ${secs}s` : 'Retrying now'}, attempt ${i.retry.attempt} of ${i.retry.of}. Your message is safe.`,
      actions: [{ id: 'switchModel', label: 'Switch model' }, { id: 'retryNow', label: 'Retry now', primary: true }], blocks: false, as: 'toast',
      placeholder: secs > 0 ? `Kernel retries in ${left(secs)}` : 'Kernel retries now',
      toast: { key: `overloaded:${chat?.id ?? ''}`, title: `${vendor} is overloaded`, sub: `Kernel retries ${name}'s turn ${secs > 0 ? `in ${left(secs)}` : 'now'}.`, actions: chat ? [{ label: 'Retry now', retryNow: chat.id, primary: true }] : [] }
    }
  }

  if (chat && (chat.context ?? 0) >= CONTEXT_WARN) return {
    id: 'context', kind: 'context', title: `This chat's context is ${(chat.context ?? 0) >= 100 ? 'full' : 'almost full'}`, sub: `Compact it to keep going. ${name} keeps a summary of what happened.`,
    actions: [{ id: 'compact', label: 'Compact now', primary: true }], blocks: false
  }

  // Out-of-date hooks Kernel couldn't rewrite at start get a 401, so outside sessions are as cut off as with the server down.
  if (i.hooks && (!i.hooks.listening || i.hooks.needsInstall)) return {
    id: 'hooks', kind: 'hooks', title: "Kernel can't hear from agents", sub: "Hooks stopped. Statuses stop updating until they're back.",
    actions: [{ id: 'checkHooks', label: 'Check hooks' }, { id: 'reconnect', label: 'Reconnect', primary: true }], blocks: false, as: 'toast',
    toast: { key: 'hooks', title: "Kernel can't hear from agents", sub: "Hooks stopped. Statuses stop updating until they're back.", actions: [{ label: 'Check hooks', modal: { name: 'checkHooks' }, primary: true }] }
  }

  return null
}
