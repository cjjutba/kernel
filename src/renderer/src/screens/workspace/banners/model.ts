import type { BannerKind, Chat, ClaudeAccount, HookStatus, ModelId, RateLimit, ScriptLine, Workspace } from '@shared/types'
import { MODELS } from '@shared/types'

// Which failure banner a workspace shows, worked out from the store alone (KERNEL-28). Every input is a real signal
// main pushed: usage from rate_limit_event, the account, main's network check, api_retry, setup's exit, the hook server.

export type BannerAction =
  | 'queue' | 'notify' | 'usage' | 'wait' | 'switch'
  | 'newChat' | 'compact' | 'switchModel' | 'retryNow' | 'tryAgain'
  | 'terminal' | 'signIn' | 'editScript' | 'runAgain' | 'checkHooks' | 'reconnect'

export type BannerId = 'signedOut' | 'offline' | 'setup' | 'weekly' | 'session' | 'model' | 'overloaded' | 'context' | 'hooks'

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
  now: number
}

/** From this much context use the chat offers to compact. */
export const CONTEXT_WARN = 90

const WEEKLY: RateLimit['type'][] = ['seven_day', 'seven_day_overage_included']
const DAY = 24 * 3600_000

/** `resetsAt` is epoch seconds. A rejection whose reset has passed no longer counts. */
const rejected = (l: RateLimit, now: number) => l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt * 1000 > now)
const modelLabel = (id: ModelId) => MODELS.find((m) => m.id === id)?.label ?? id
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** "at 3:40 PM" within a day, else "Monday at 9:00 AM". */
export function resetPhrase(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000
  return ms - now < DAY ? `at ${clock(ms)}` : `${new Date(ms).toLocaleDateString('en-US', { weekday: 'long' })} at ${clock(ms)}`
}

/** "in 3 days", or "at 3:40 PM" within a day. */
export function resetIn(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000
  if (ms - now < DAY) return `at ${clock(ms)}`
  const days = Math.ceil((ms - now) / DAY)
  return `in ${days} days`
}

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

  if (i.account && !i.account.signedIn) return {
    id: 'signedOut', kind: 'auth', title: 'Claude Code is signed out', sub: 'Agents cannot run until you sign in. Workspaces and chats are safe.',
    actions: [{ id: 'terminal', label: 'Open terminal' }, { id: 'signIn', label: 'Sign in', primary: true }], blocks: true
  }

  if (!i.online) return {
    id: 'offline', kind: 'offline', title: "You're offline", sub: 'Messages send when you reconnect. Agents finish their step, then wait.',
    actions: [{ id: 'tryAgain', label: 'Try again' }], blocks: false
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

  const weekly = i.usage.filter((l) => WEEKLY.includes(l.type) && rejected(l, now)).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]
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

  if (i.retry) {
    const secs = Math.max(0, Math.ceil((i.retry.nextAt - now) / 1000))
    return {
      id: 'overloaded', kind: 'retry', title: 'Claude is overloaded',
      sub: `${secs > 0 ? `Retrying in ${secs}s` : 'Retrying now'}, attempt ${i.retry.attempt} of ${i.retry.of}. Your message is safe.`,
      actions: [{ id: 'switchModel', label: 'Switch model' }, { id: 'retryNow', label: 'Retry now', primary: true }], blocks: false
    }
  }

  if (chat && (chat.context ?? 0) >= CONTEXT_WARN) return {
    id: 'context', kind: 'context', title: 'Context is almost full', sub: 'Compacting keeps a summary and frees space. A new chat starts clean on this branch.',
    actions: [{ id: 'newChat', label: 'New chat' }, { id: 'compact', label: 'Compact now', primary: true }], blocks: false
  }

  if (i.hooks && !i.hooks.listening) return {
    id: 'hooks', kind: 'hooks', title: 'Hooks are disconnected', sub: 'The floor and logs stop updating. Agents keep working, approvals fall back to the terminal.',
    actions: [{ id: 'checkHooks', label: 'Check hooks' }, { id: 'reconnect', label: 'Reconnect', primary: true }], blocks: false
  }

  return null
}
