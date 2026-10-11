import type { AccountProfile, BannerKind, Chat, ClaudeAccount, HookStatus, ModelId, Provider, RateLimit, ScriptLine, Workspace } from '@shared/types'
import { MODELS, PROVIDERS } from '@shared/types'
import { chatProvider, limitProvider } from '@shared/providers'
import { clock, nearLimit, resetPhrase, WEEKLY_WARN } from '@shared/usage'
import { formatTokens } from '../composer/formatTokens'

export { clock, resetPhrase }

// Which failure banner a workspace shows, worked out from the store alone (KERNEL-28). Every input is a real signal
// main pushed: usage from rate_limit_event, the account, main's network check, api_retry, setup's exit, the hook server.

export type BannerAction =
  | 'queue' | 'notify' | 'usage' | 'wait' | 'switch'
  | 'newChat' | 'compact' | 'switchModel' | 'retryNow' | 'tryAgain'
  | 'terminal' | 'signIn' | 'editScript' | 'runAgain' | 'checkHooks' | 'reconnect' | 'review' | 'archive' | 'switchAccount' | 'providers' | 'dismiss'

export type BannerId = 'folder' | 'signedOut' | 'offline' | 'trust' | 'setup' | 'weekly' | 'session' | 'model' | 'nearLimit' | 'weeklyWarn' | 'overloaded' | 'context' | 'long' | 'hooks'

export interface BannerView {
  id: BannerId
  kind: BannerKind
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
}

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
  /** The Lead's name, for "Rowan can still answer you". */
  leadName?: string
  /** Settings, Account. A switch left out counts as on, which is the default. */
  usageSettings?: { pauseNearLimit?: boolean; warnBeforeWeekly?: boolean }
  /** Both providers' accounts (KERNEL-406). Without them every limit counts as the Claude login's, as before. */
  accounts?: AccountProfile[]
  /** A role or this chat runs on Codex, so the banners name the provider (KERNEL-406). */
  codexInUse?: boolean
  /** The user dismissed this chat's long-chat banner (KERNEL-426). It skips only that banner: the next one still shows, and "Context is almost full" cannot be dismissed. */
  longDismissed?: boolean
  now: number
}

/** From this much context use the chat offers to compact. */
export const CONTEXT_WARN = 90

/**
 * From this many tokens in the context, whatever the window's size, the chat offers a new one: every turn re-reads all of it,
 * and a 1M window reaches 90% far too late for that to be cheap. It comes before `CONTEXT_WARN` on a big window and
 * after it on a small one (KERNEL-224, which amends KERNEL-334's one percent threshold for the banner; the ring keeps its levels).
 */
export const CONTEXT_LONG = 150_000

const DAY = 24 * 3600_000

/** `resetsAt` is epoch seconds. A rejection whose reset has passed no longer counts. */
const rejected = (l: RateLimit, now: number) => l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt * 1000 > now)
const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id
/** "in 3 days", or "at 3:40 PM" within a day. */
export function resetIn(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000
  if (ms - now < DAY) return `at ${clock(ms)}`
  const days = Math.ceil((ms - now) / DAY)
  return `in ${days} days`
}

/** "3:40 PM" within a day, else "Monday at 9:00 AM": the time something waits until. */
const untilPhrase = (resetsAt: number, now: number) => resetPhrase(resetsAt, now).replace(/^at /, '')

/** The model to offer when `current` hits its own limit: the first one, in picker order, that is not limited. */
export function fallbackModel(current: string, usage: RateLimit[], now: number): ModelId | undefined {
  const limited = new Set(usage.filter((l) => rejected(l, now) && l.model).map((l) => l.model))
  return MODELS.map((m) => m.id).find((m) => m !== current && !limited.has(m))
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
  const active = accounts.find((a) => a.active)?.id ?? 'cli'
  const usage = i.usage.filter((l) => limitProvider(l) === provider && (l.accountId ?? 'cli') === active)
  const named = (what: string) => (i.codexInUse ? `${providerName} ${what}` : what)
  // Another signed-in account of this provider with no rejected window takes over with one click.
  const alt = accounts.find((a) => !a.active && a.signedIn && !i.usage.some((l) => limitProvider(l) === provider && (l.accountId ?? 'cli') === a.id && rejected(l, now) && (l.type === 'five_hour' || l.type === 'seven_day')))
  const switchAccount = alt ? { provider, accountId: alt.id, label: alt.label } : undefined
  const switchAction = alt ? [{ id: 'switchAccount' as const, label: `Switch to ${alt.label}`, primary: true }] : []
  const keepGoing = i.codexInUse ? ` Agents on ${otherName} keep working.` : ''

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

  // KERNEL-209 holds the workspace until the user trusts the room's scripts. Its brief waits in the queue, so the composer stays open.
  if (ws.status === 'trust') return {
    id: 'trust', kind: 'trust', title: "Waiting for you to trust this repo's scripts", sub: `Setup has not run yet. ${name} starts once you trust them.`,
    actions: [{ id: 'review', label: 'Review', primary: true }], blocks: false
  }

  if (ws.status === 'failed') {
    const cmd = setupCommand(i.scripts)
    const what = cmd ? `${cmd} exited` : 'The setup script exited'
    const code = i.setupCode
    return {
      id: 'setup', kind: 'setup', title: 'Setup script failed',
      sub: `${code === null || code === undefined ? `${cmd ?? 'The setup script'} did not finish` : `${what} with code ${code}`}. ${name} waits until setup passes.`,
      actions: [{ id: 'editScript', label: 'Edit script' }, { id: 'runAgain', label: 'Run again', primary: true }], blocks: true
    }
  }

  // Fable's own weekly limit (`seven_day_overage_included`) is a model limit, shown below.
  // "Notify me" knows the Claude login's windows, so a Codex window or an added account's offers its other actions.
  const notify = provider === 'claude' && active === 'cli'
  const weekly = usage.find((l) => l.type === 'seven_day' && rejected(l, now))
  if (weekly) {
    const held = i.codexInUse ? `Agents on ${providerName} wait until it resets.` : 'Every room is paused.'
    return {
      id: 'weekly', kind: 'limit', title: `You've used your ${named('weekly limit')}`,
      sub: weekly.resetsAt ? `Resets ${resetPhrase(weekly.resetsAt, now)}. ${held}${i.codexInUse ? keepGoing : ''}` : i.codexInUse ? `${held}${keepGoing}` : 'Every room is paused until it resets.',
      actions: [...(provider === 'claude' ? [{ id: 'usage' as const, label: 'Open /usage' }] : []), ...(notify ? [{ id: 'notify' as const, label: 'Notify me', primary: !alt }] : []), ...switchAction],
      blocks: !alt, limit: weekly.type, switchAccount
    }
  }

  const session = usage.find((l) => l.type === 'five_hour' && rejected(l, now))
  if (session) {
    const after = i.running ? `${name} finishes this step, then waits.` : `${name} finished this turn and stopped.`
    return {
      id: 'session', kind: 'limit', title: `You've hit your ${named('5-hour limit')}`,
      sub: `${session.resetsAt ? `Resets ${resetPhrase(session.resetsAt, now)}. ` : ''}${after}${keepGoing}`,
      actions: alt
        ? [...(notify ? [{ id: 'notify' as const, label: 'Notify me' }] : [{ id: 'queue' as const, label: 'Queue message' }]), ...switchAction]
        : [{ id: 'queue', label: 'Queue message' }, ...(notify ? [{ id: 'notify' as const, label: 'Notify me', primary: true }] : [])],
      blocks: false, limit: 'five_hour', switchAccount
    }
  }

  const own = chat && usage.find((l) => l.model === chat.model && rejected(l, now))
  if (chat && own) {
    const to = fallbackModel(chat.model, usage, now)
    const when = own.resetsAt ? `It resets ${resetIn(own.resetsAt, now)}.` : 'It resets on its own.'
    return {
      id: 'model', kind: 'limit', title: `You've reached your ${modelLabel(chat.model)} limit`,
      sub: to ? `${when} ${modelLabel(to)} can pick up where this left off.` : when,
      actions: to ? [{ id: 'wait', label: 'Wait' }, { id: 'switch', label: `Switch to ${modelLabel(to)}`, primary: true }] : [],
      blocks: false, limit: own.type, switchTo: to
    }
  }

  // A window close to its limit holds teammates' new work (KERNEL-220). Nothing is blocked: turns that run go on, and the Lead can still answer.
  // Only this chat's provider counts, as in the engine (KERNEL-406).
  const usageAction = provider === 'claude' ? [{ id: 'usage' as const, label: 'Open /usage' }] : []
  const held = !i.isLead && i.usageSettings?.pauseNearLimit !== false ? nearLimit(usage, now) : undefined
  if (held?.resetsAt) return {
    id: 'nearLimit', kind: 'limit', title: `Close to your ${named(held.type === 'five_hour' ? '5-hour limit' : 'weekly limit')}`,
    sub: `New work from teammates waits until ${untilPhrase(held.resetsAt, now)}. ${i.leadName ?? 'Rowan'} can still answer you.`,
    actions: usageAction, blocks: false
  }

  const week = usage.find((l) => l.type === 'seven_day' && l.resetsAt !== undefined && l.resetsAt * 1000 > now && (l.utilization ?? 0) >= WEEKLY_WARN)
  if (week?.resetsAt && i.usageSettings?.warnBeforeWeekly !== false) return {
    id: 'weeklyWarn', kind: 'limit', title: `You've used ${Math.round((week.utilization ?? WEEKLY_WARN) * 100)}% of this week's ${named('limit')}`,
    sub: `It resets ${resetPhrase(week.resetsAt, now)}.`, actions: usageAction, blocks: false
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

  // Past 150k tokens a chat costs more with every turn, however empty the window still is (KERNEL-224). It names the count and the
  // reason, since the context popover beside it can show most of the window free. Dismissed, it falls through to the next banner (KERNEL-426).
  const used = chat?.contextUsage?.used ?? 0
  if (chat && !i.longDismissed && used >= CONTEXT_LONG) return {
    id: 'long', kind: 'context', title: 'This chat is long', sub: `${formatTokens(used)} tokens. Each turn reads all of it again, so turns use more of your limit.`,
    actions: [{ id: 'dismiss', label: 'Dismiss' }, { id: 'compact', label: 'Compact now' }, { id: 'newChat', label: 'New tab', primary: true }], blocks: false
  }

  // Out-of-date hooks Kernel couldn't rewrite at start get a 401, so outside sessions are as cut off as with the server down.
  if (i.hooks && (!i.hooks.listening || i.hooks.needsInstall)) return {
    id: 'hooks', kind: 'hooks', title: 'Hooks are disconnected', sub: 'Agent statuses stop updating. Agents keep working, approvals fall back to the terminal.',
    actions: [{ id: 'checkHooks', label: 'Check hooks' }, { id: 'reconnect', label: 'Reconnect', primary: true }], blocks: false
  }

  return null
}
