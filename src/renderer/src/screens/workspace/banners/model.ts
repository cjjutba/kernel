import type { BannerKind, Chat, ClaudeAccount, HookStatus, ModelId, RateLimit, ScriptLine, Workspace } from '@shared/types'
import { MODELS } from '@shared/types'
import { clock, nearLimit, resetPhrase, WEEKLY_WARN } from '@shared/usage'

export { clock, resetPhrase }

// Which failure banner a workspace shows, worked out from the store alone (KERNEL-28). Every input is a real signal
// main pushed: usage from rate_limit_event, the account, main's network check, api_retry, setup's exit, the hook server.

export type BannerAction =
  | 'queue' | 'notify' | 'usage' | 'wait' | 'switch'
  | 'newChat' | 'compact' | 'switchModel' | 'retryNow' | 'tryAgain'
  | 'terminal' | 'signIn' | 'editScript' | 'runAgain' | 'checkHooks' | 'reconnect' | 'review' | 'archive'

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
const modelLabel = (id: ModelId) => MODELS.find((m) => m.id === id)?.label ?? id
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
export function fallbackModel(current: ModelId, usage: RateLimit[], now: number): ModelId | undefined {
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

  // A worktree deleted outside Kernel has nowhere to run anything, so it says so first, like a failed setup (KERNEL-291).
  if (ws.folderGone) return {
    id: 'folder', kind: 'setup', title: "This workspace's folder is gone",
    sub: `${ws.path} was deleted outside Kernel. Archive it, then restore it from History to make the folder again.`,
    actions: [{ id: 'archive', label: 'Archive', primary: true }], blocks: true
  }

  if (i.account && !i.account.signedIn) return {
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
  const weekly = i.usage.find((l) => l.type === 'seven_day' && rejected(l, now))
  if (weekly) return {
    id: 'weekly', kind: 'limit', title: "You've used your weekly limit",
    sub: weekly.resetsAt ? `Resets ${resetPhrase(weekly.resetsAt, now)}. Every room is paused.` : 'Every room is paused until it resets.',
    actions: [{ id: 'usage', label: 'Open /usage' }, { id: 'notify', label: 'Notify me', primary: true }], blocks: true, limit: weekly.type
  }

  const session = i.usage.find((l) => l.type === 'five_hour' && rejected(l, now))
  if (session) {
    const after = i.running ? `${name} finishes this step, then waits.` : `${name} finished this turn and stopped.`
    return {
      id: 'session', kind: 'limit', title: "You've hit your 5-hour limit",
      sub: `${session.resetsAt ? `Resets ${resetPhrase(session.resetsAt, now)}. ` : ''}${after}`,
      actions: [{ id: 'queue', label: 'Queue message' }, { id: 'notify', label: 'Notify me', primary: true }], blocks: false, limit: 'five_hour'
    }
  }

  const own = chat && i.usage.find((l) => l.model === chat.model && rejected(l, now))
  if (chat && own) {
    const to = fallbackModel(chat.model, i.usage, now)
    const when = own.resetsAt ? `It resets ${resetIn(own.resetsAt, now)}.` : 'It resets on its own.'
    return {
      id: 'model', kind: 'limit', title: `You've reached your ${modelLabel(chat.model)} limit`,
      sub: to ? `${when} ${modelLabel(to)} can pick up where this left off.` : when,
      actions: to ? [{ id: 'wait', label: 'Wait' }, { id: 'switch', label: `Switch to ${modelLabel(to)}`, primary: true }] : [],
      blocks: false, limit: own.type, switchTo: to
    }
  }

  // A window close to its limit holds teammates' new work (KERNEL-220). Nothing is blocked: turns that run go on, and the Lead can still answer.
  const held = !i.isLead && i.usageSettings?.pauseNearLimit !== false ? nearLimit(i.usage, now) : undefined
  if (held?.resetsAt) return {
    id: 'nearLimit', kind: 'limit', title: `Close to your ${held.type === 'five_hour' ? '5-hour' : 'weekly'} limit`,
    sub: `New work from teammates waits until ${untilPhrase(held.resetsAt, now)}. ${i.leadName ?? 'Rowan'} can still answer you.`,
    actions: [{ id: 'usage', label: 'Open /usage' }], blocks: false
  }

  const week = i.usage.find((l) => l.type === 'seven_day' && l.resetsAt !== undefined && l.resetsAt * 1000 > now && (l.utilization ?? 0) >= WEEKLY_WARN)
  if (week?.resetsAt && i.usageSettings?.warnBeforeWeekly !== false) return {
    id: 'weeklyWarn', kind: 'limit', title: `You've used ${Math.round((week.utilization ?? WEEKLY_WARN) * 100)}% of this week's limit`,
    sub: `It resets ${resetPhrase(week.resetsAt, now)}.`, actions: [{ id: 'usage', label: 'Open /usage' }], blocks: false
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

  // Past 150k tokens a chat costs more with every turn, however empty the window still is (KERNEL-224).
  if (chat && (chat.contextUsage?.used ?? 0) >= CONTEXT_LONG) return {
    id: 'long', kind: 'context', title: 'This chat is long', sub: 'Starting a new chat keeps the next turns cheaper.',
    actions: [{ id: 'compact', label: 'Compact now' }, { id: 'newChat', label: 'New tab', primary: true }], blocks: false
  }

  // Out-of-date hooks Kernel couldn't rewrite at start get a 401, so outside sessions are as cut off as with the server down.
  if (i.hooks && (!i.hooks.listening || i.hooks.needsInstall)) return {
    id: 'hooks', kind: 'hooks', title: 'Hooks are disconnected', sub: 'Agent statuses stop updating. Agents keep working, approvals fall back to the terminal.',
    actions: [{ id: 'checkHooks', label: 'Check hooks' }, { id: 'reconnect', label: 'Reconnect', primary: true }], blocks: false
  }

  return null
}
