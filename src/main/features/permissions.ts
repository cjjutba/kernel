import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { Chat, ModeAvailability, Provider, Workspace } from '@shared/types'
import { chatProvider } from '@shared/providers'
import type { Handlers } from '../kernel'
import { claudePolicy, supportsAuto, type ClaudePolicy, type PolicyBlock } from '../services/claudeSettings'
import type { ChatAvailability, RunMode } from '../services/permissions'
import { Feature } from './feature'

/** How long Kernel waits after a failed read before it tries again, so a CLI that can't start isn't started at every step. */
export const RETRY_MS = 60_000

/** Why Auto runs as Accept edits on Codex: Always ask has no way to the user under `auto_review` yet (KERNEL-433). */
export const CODEX_AUTO = "Auto isn't available on Codex yet, so Codex chats in Auto run in Accept edits."

/** A value Kernel reads in the background: the last one read, the read under way, and when the last read failed. */
interface Read<T> { value?: T; pending?: Promise<T | undefined>; failedAt?: number }

/**
 * Which permission modes each provider can run (KERNEL-447): admin policy from Claude Code's settings, which turns Auto or
 * Bypass permissions off on both providers, and the models Claude Code runs in Auto. Reads start when a chat asks for Auto
 * or Bypass, or Settings asks, and live chats move when one lands. Until then a chat runs in the safer mode.
 */
export class Permissions extends Feature {
  /** Reads Claude Code's settings for a folder, or the app's without one. Tests swap it. */
  readPolicy: (cwd?: string) => Promise<ClaudePolicy> = (cwd) => claudePolicy(cwd)
  /** Asks Claude Code for its models on the active account. Tests swap it. */
  readModels: () => Promise<ModelInfo[]> = () => this.sessions.claudeModels(this.home)

  /** Policy by folder: a project's checkout, or '' for the app's. */
  private readonly policies = new Map<string, Read<ClaudePolicy>>()
  /** Claude Code's models by the account they were read on, '' for the CLI's own login. */
  private readonly models = new Map<string, Read<ModelInfo[]>>()

  /** Reads the app's policy and every open project's, so the chats that carry on at launch start in their own mode. */
  start() {
    void this.load(this.policies, '', () => this.readPolicy())
    for (const r of this.store.projects()) if (!r.archived) void this.load(this.policies, r.path, () => this.readPolicy(r.path))
  }

  /**
   * What a chat can run now, from what Kernel has read. A mode the chat doesn't ask for needs nothing read. Bypass needs the
   * project's policy. Auto on Claude needs Claude Code's models too, and the chat's model must run it.
   */
  forChat(chat: Chat, ws: Workspace, wants: RunMode): ChatAvailability {
    if (wants !== 'auto' && wants !== 'bypassPermissions') return { auto: false, bypass: false }
    const folder = this.store.project(ws.projectId)?.path ?? ws.path
    const policy = this.known(this.policies, folder, () => this.readPolicy(folder))
    if (!policy) return { auto: false, bypass: false }
    const bypass = !policy.bypass
    if (wants !== 'auto' || policy.auto || chatProvider(chat) !== 'claude') return { auto: false, bypass }
    const models = this.known(this.models, this.account(), () => this.readModels())
    return { auto: !!models && supportsAuto(models, chat.model) === true, bypass }
  }

  /** For Settings, Permissions, the composer and onboarding. Reads the app's policy and Claude Code's models again. */
  async availability(): Promise<Record<Provider, ModeAvailability>> {
    const [policy, models] = await Promise.all([this.load(this.policies, '', () => this.readPolicy()), this.load(this.models, this.account(), () => this.readModels())])
    const unread = "Kernel couldn't read Claude Code's settings, so it keeps Auto and Bypass permissions off."
    if (!policy) return { claude: { auto: false, bypass: false, reason: unread }, codex: { auto: false, bypass: false, reason: unread } }
    const bypassOff = policy.bypass ? turnedOff('Bypass permissions', policy.bypass) : undefined
    const claudeAuto = !policy.auto && !!models?.some((m) => m.supportsAutoMode)
    const autoOff = policy.auto ? turnedOff('Auto', policy.auto)
      : !models ? "Kernel couldn't ask Claude Code whether this account runs Auto."
        : !claudeAuto ? "Auto isn't available on this Claude account." : undefined
    return {
      claude: { auto: claudeAuto, bypass: !policy.bypass, ...reasons(autoOff, bypassOff) },
      codex: { auto: false, bypass: !policy.bypass, ...reasons(CODEX_AUTO, bypassOff) }
    }
  }

  handlers() {
    return {
      'permissions.availability': async () => this.availability()
    } satisfies Partial<Handlers>
  }

  /** The account Claude runs on now, '' for the CLI's own login. Its models are read again after a switch. */
  private account(): string { return this.k.providers.active('claude') ?? '' }

  /** The value read for `key`, starting a read when there is none yet and the last one didn't just fail. */
  private known<T>(reads: Map<string, Read<T>>, key: string, read: () => Promise<T>): T | undefined {
    const r = reads.get(key)
    if (r?.value !== undefined || r?.pending || (r?.failedAt && Date.now() - r.failedAt < RETRY_MS)) return r?.value
    void this.load(reads, key, read)
    return undefined
  }

  /**
   * Reads `key` again, or joins the read under way. The last value stays in use meanwhile, and a failed read keeps it. A value
   * that changed moves the live chats.
   */
  private load<T>(reads: Map<string, Read<T>>, key: string, read: () => Promise<T>): Promise<T | undefined> {
    const r = reads.get(key) ?? {}
    reads.set(key, r)
    r.pending ??= Promise.resolve().then(read).then(
      (value) => {
        const changed = JSON.stringify(value) !== JSON.stringify(r.value)
        Object.assign(r, { value, failedAt: undefined, pending: undefined })
        if (changed && !this.stopped) this.sessions.applyModes()
        return value
      },
      () => {
        Object.assign(r, { failedAt: Date.now(), pending: undefined })
        return r.value
      })
    return r.pending
  }
}

/** Why a mode is off, naming who turned it off: an admin through managed policy, or the user's own Claude Code settings. */
function turnedOff(mode: string, by: PolicyBlock): string {
  return `${mode} is turned off ${by.admin ? "by your organization's Claude Code policy" : 'in your Claude Code settings'}.`
}

const reasons = (...why: (string | undefined)[]) => {
  const reason = why.filter(Boolean).join(' ')
  return reason ? { reason } : {}
}
