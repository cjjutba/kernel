import type { AccountProfile, BannerKind, Chat, ClaudeAccount, HookStatus, ModelId, Provider, RateLimit, ScriptLine, Workspace } from '@shared/types'
import { MODELS, PROVIDERS } from '@shared/types'
import { chatProvider, limitProvider } from '@shared/providers'
import { clock, nearLimit, resetPhrase, switchChoices, WEEKLY_WARN } from '@shared/usage'

export { clock, resetPhrase }

// Which failure banner a workspace shows, worked out from the store alone (KERNEL-28). Every input is a real signal
// main pushed: usage from rate_limit_event, the account, main's network check, api_retry, setup's exit, the hook server.

export type BannerAction =
  | 'queue' | 'notify' | 'usage' | 'wait' | 'switch'
  | 'newChat' | 'compact' | 'switchModel' | 'retryNow' | 'tryAgain'
  | 'terminal' | 'signIn' | 'editScript' | 'runAgain' | 'checkHooks' | 'reconnect' | 'review' | 'archive' | 'switchAccount' | 'providers'
  | 'switchBack' | 'models' | 'signInAccount'

export type BannerId = 'folder' | 'signedOut' | 'offline' | 'trust' | 'setup' | 'weekly' | 'session' | 'model' | 'accountNearLimit' | 'nearLimit' | 'weeklyWarn' | 'switchWarning' | 'overloaded' | 'context' | 'hooks'

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
  /** A Lead chat with nothing held for setup: setup waiting or failed doesn't hold it, so the composer stays open (KERNEL-490). */
  skipsSetup?: boolean
  /** The limit banners the user closed, by `limitBannerKey`. Only the near-limit, 80% and switch-account banners look here (KERNEL-595). */
  dismissed?: ReadonlySet<string>
  /** Settings, Providers: Kernel switches this chat's provider on its own at a limit, so the near-limit offer would only nag (KERNEL-569). */
  switchAtLimit?: boolean
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

/** "Theo", "Theo and Noor", "Theo, Noor and Kai". */
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
  const usage = windowsOf(active)
  const named = (what: string) => (i.codexInUse ? `${providerName} ${what}` : what)
  // Where the provider can go: the same answer Kernel's own switch at a limit uses (`switchChoices`, KERNEL-618). The other signed-in accounts with no rejected
  // window take over with one click, a subscription before an API key, which a switch starts paying for (KERNEL-524), and the one with the most 5-hour headroom first
  // (KERNEL-569). One waiting on a Keychain prompt never is, and one in the active account's organization only when its own windows say it has headroom.
  const choices = switchChoices(provider, accounts, i.usage, now)
  const subscriptions = choices.headroom.filter((a) => a.auth !== 'apiKey')
  const alt = choices.headroom[0]
  const switchAccount = alt ? { provider, accountId: alt.id, label: alt.label } : undefined
  const switchAction = alt ? [{ id: 'switchAccount' as const, label: `Switch to ${alt.label}`, primary: true }] : []
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
    actions: [{ id: 'archive', label: 'Archive', primary: true }], blocks: true
  }

  const codexOut = provider === 'codex' && accounts.find((a) => a.active && !a.signedIn)
  if (codexOut) return {
    id: 'signedOut', kind: 'auth', title: 'Codex is signed out', sub: 'Agents on Codex cannot run until you sign in. Workspaces and chats are safe.',
    actions: [{ id: 'providers', label: 'Sign in', primary: true }], blocks: true
  }

  if (provider === 'claude' && i.account && !i.account.signedIn) return {
    id: 'signedOut', kind: 'auth', title: 'Claude Code is signed out', sub: 'Agents cannot run until you sign in. Workspaces and chats are safe.',
    actions: [{ id: 'terminal', label: 'Open terminal' }, { id: 'signIn', label: 'Sign in', primary: true }], blocks: true
  }

  if (!i.online) return {
    id: 'offline', kind: 'offline', title: "You're offline", sub: 'Messages send when you reconnect. Agents finish their step, then wait.',
    actions: [{ id: 'tryAgain', label: 'Try again' }], blocks: false
  }

  // A Lead chat that isn't held keeps answering while setup waits or after it failed (KERNEL-490).
  const without = `${name} keeps answering without it.`

  // KERNEL-209 holds the workspace until the user trusts the project's scripts. Its brief waits in the queue, so the composer stays open.
  if (ws.status === 'trust') return {
    id: 'trust', kind: 'trust', title: "Waiting for you to trust this repo's scripts", sub: `Setup has not run yet. ${i.skipsSetup ? without : `${name} starts once you trust them.`}`,
    actions: [{ id: 'review', label: 'Review', primary: true }], blocks: false
  }

  if (ws.status === 'failed') {
    const cmd = setupCommand(i.scripts)
    const what = cmd ? `${cmd} exited` : 'The setup script exited'
    const code = i.setupCode
    return {
      id: 'setup', kind: 'setup', title: 'Setup script failed',
      sub: `${code === null || code === undefined ? `${cmd ?? 'The setup script'} did not finish` : `${what} with code ${code}`}. ${i.skipsSetup ? without : `${name} waits until setup passes.`}`,
      actions: [{ id: 'editScript', label: 'Edit script' }, { id: 'runAgain', label: 'Run again', primary: true }], blocks: !i.skipsSetup
    }
  }

  // Fable's own weekly limit (`seven_day_overage_included`) is a model limit, shown below.
  // "Notify me" knows the Claude login's windows, so a Codex window or an added account's offers its other actions.
  const notify = provider === 'claude' && active === 'cli'
  const weekly = usage.find((l) => l.type === 'seven_day' && rejected(l, now))
  if (weekly) {
    const held = i.codexInUse ? `Agents on ${providerName} wait until it resets.` : 'Every project is paused.'
    return {
      id: 'weekly', kind: 'limit', title: `You've used your ${named('weekly limit')}`,
      sub: `${weekly.resetsAt ? `Resets ${resetPhrase(weekly.resetsAt, now)}. ${held}${keepGoing}` : i.codexInUse ? `${held}${keepGoing}` : 'Every project is paused until it resets.'}${billed}${signedOutNote}`,
      actions: [...(provider === 'claude' ? [{ id: 'usage' as const, label: 'View usage' }] : []), ...(notify ? [{ id: 'notify' as const, label: 'Notify me', primary: !alt && !signedOut }] : []), ...switchAction, ...signInAction],
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
        ? [...(notify ? [{ id: 'notify' as const, label: 'Notify me' }] : [{ id: 'queue' as const, label: 'Queue message' }]), ...switchAction, ...signInAction]
        : [{ id: 'queue', label: 'Queue message' }, ...(notify ? [{ id: 'notify' as const, label: 'Notify me', primary: true }] : [])],
      blocks: false, limit: 'five_hour', switchAccount, signIn
    }
  }

  const own = chat && usage.find((l) => l.model === chat.model && rejected(l, now))
  if (chat && own) {
    const to = fallbackModel(chat.model, usage, now)
    const when = own.resetsAt ? `It resets ${resetPhrase(own.resetsAt, now)}.` : 'It resets on its own.'
    return {
      id: 'model', kind: 'limit', title: `You've reached your ${modelLabel(chat.model)} limit`,
      sub: to ? `${when} ${modelLabel(to)} can pick up where this left off.` : when,
      actions: to ? [{ id: 'wait', label: 'Wait' }, { id: 'switch', label: `Switch to ${modelLabel(to)}`, primary: true }] : [],
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
      title: `${current.label} is ${near.utilization === undefined ? 'close to' : `at ${Math.round(near.utilization * 100)}% of`} its ${named(near.type === 'five_hour' ? '5-hour limit' : 'weekly limit')}`,
      sub: `${roomy.label} has usage left.`,
      actions: [{ id: 'switchAccount', label: `Switch to ${roomy.label}`, primary: true }],
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
      id: 'switchWarning', kind: 'warn', title: `${current.label}\u2019s plan doesn\u2019t include ${names(lacks.map((m) => m.label))}`,
      sub: `${names(agents)} ${agents.length === 1 ? 'uses' : 'use'} ${lacks.length === 1 ? 'it' : 'them'}.`,
      actions: [...(back ? [{ id: 'switchBack' as const, label: `Switch back to ${back.label}` }] : []), { id: 'models', label: 'Models and effort', primary: true }],
      blocks: false, switchAccount: back ? { provider, accountId: back.id, label: back.label } : undefined, dismissKey: key
    }
  }

  // A window close to its limit holds teammates' new work (KERNEL-220). Nothing is blocked: turns that run go on, and the Lead can still answer.
  // Only this chat's provider counts, as in the engine (KERNEL-406).
  const usageAction = provider === 'claude' ? [{ id: 'usage' as const, label: 'View usage' }] : []
  // Closing one is remembered for its window (KERNEL-595). The next banner in line shows in its place, and so does the 80% one when
  // the week that holds teammates is the one the user closed: it would say the same thing about the same window.
  const closed = (id: BannerId, resetsAt: number) => !!i.dismissed?.has(limitBannerKey(id, resetsAt))
  const held = !i.isLead && i.usageSettings?.pauseNearLimit !== false ? near : undefined
  if (held?.resetsAt && !closed('nearLimit', held.resetsAt)) return {
    id: 'nearLimit', kind: 'limit', title: `Close to your ${named(held.type === 'five_hour' ? '5-hour limit' : 'weekly limit')}`,
    sub: `New work from teammates waits until ${untilPhrase(held.resetsAt, now)}. ${i.leadName ?? 'Kernel'} can still answer you.`,
    actions: usageAction, blocks: false, dismissKey: limitBannerKey('nearLimit', held.resetsAt)
  }

  const week = usage.find((l) => l.type === 'seven_day' && l.resetsAt !== undefined && l.resetsAt * 1000 > now && (l.utilization ?? 0) >= WEEKLY_WARN)
  if (week?.resetsAt && i.usageSettings?.warnBeforeWeekly !== false && !closed('weeklyWarn', week.resetsAt) && !closed('nearLimit', week.resetsAt)) return {
    id: 'weeklyWarn', kind: 'limit', title: `You've used ${Math.round((week.utilization ?? WEEKLY_WARN) * 100)}% of this week's ${named('limit')}`,
    sub: `It resets ${resetPhrase(week.resetsAt, now)}.`, actions: usageAction, blocks: false, dismissKey: limitBannerKey('weeklyWarn', week.resetsAt)
  }

  if (i.retry) {
    const secs = Math.max(0, Math.ceil((i.retry.nextAt - now) / 1000))
    return {
      id: 'overloaded', kind: 'retry', title: 'Claude is overloaded',
      sub: `${secs > 0 ? `Retrying in ${secs}s` : 'Retrying now'}, attempt ${i.retry.attempt} of ${i.retry.of}. Your message is safe.`,
      actions: [{ id: 'switchModel', label: 'Switch model' }, { id: 'retryNow', label: 'Retry now', primary: true }], blocks: false
    }
  }

  if (chat && (chat.context ?? 0) >= CONTEXT_WARN) return {
    id: 'context', kind: 'context', title: 'Context is almost full', sub: 'Compacting keeps a summary and frees space. A new tab starts clean in this chat.',
    actions: [{ id: 'newChat', label: 'New tab' }, { id: 'compact', label: 'Compact now', primary: true }], blocks: false
  }

  // Out-of-date hooks Kernel couldn't rewrite at start get a 401, so outside sessions are as cut off as with the server down.
  if (i.hooks && (!i.hooks.listening || i.hooks.needsInstall)) return {
    id: 'hooks', kind: 'hooks', title: 'Hooks are disconnected', sub: 'Agent statuses stop updating. Agents keep working, approvals fall back to the terminal.',
    actions: [{ id: 'checkHooks', label: 'Check hooks' }, { id: 'reconnect', label: 'Reconnect', primary: true }], blocks: false
  }

  return null
}
