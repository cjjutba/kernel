import type { ClaudeAccount } from '@shared/types'
import { exec } from './exec'
import { ghUser } from './github'
import { planName } from './preflight'

/** The account, and the plan type as `claude auth status` says it, which the defaults follow (KERNEL-225). The window never sees the raw type. */
export type ReadAccount = ClaudeAccount & { subscriptionType?: string }

/**
 * Reads the Claude login the CLI holds, through `bin`: Kernel's own copy, not whatever `claude` is on the PATH (KERNEL-277).
 * `env` adds the active account's token. Never throws: a missing CLI or an older one reads as signed out.
 */
export async function readAccount(bin = 'claude', env?: Record<string, string>): Promise<ReadAccount> {
  const a = await exec(bin, ['auth', 'status'], { timeoutMs: 15000, ...(env ? { env: { ...process.env, ...env } } : {}) })
  let status: { loggedIn?: boolean; subscriptionType?: unknown; email?: unknown } = {}
  try { status = JSON.parse(a.stdout) } catch { /* not signed in, or an older CLI */ }
  if (!status.loggedIn) return { signedIn: false }
  const email = typeof status.email === 'string' ? status.email : undefined
  const login = (await ghUser().catch(() => null)) ?? email?.split('@')[0]
  const git = await exec('git', ['config', '--global', 'user.name'], { timeoutMs: 5000 })
  const name = git.code === 0 && git.stdout.trim() ? git.stdout.trim() : login
  return { signedIn: true, name, login, email, plan: planName(status.subscriptionType), ...(typeof status.subscriptionType === 'string' ? { subscriptionType: status.subscriptionType } : {}) }
}

/**
 * Whether Claude Code is signed in, from `claude auth status` alone, with none of `readAccount`'s GitHub and git reads.
 * Kernel asks at launch before agents carry on (KERNEL-215), where only this answer matters.
 */
export async function claudeSignedIn(bin = 'claude', env?: Record<string, string>): Promise<boolean> {
  const a = await exec(bin, ['auth', 'status'], { timeoutMs: 15000, ...(env ? { env: { ...process.env, ...env } } : {}) })
  try { return !!JSON.parse(a.stdout).loggedIn } catch { return false }
}

export async function signOut(bin = 'claude'): Promise<ReadAccount> {
  await exec(bin, ['auth', 'logout'], { timeoutMs: 15000 })
  return readAccount(bin)
}
