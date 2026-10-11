import type { ClaudeAccount } from '@shared/types'
import { exec } from './exec'
import { ghUser } from './github'
import { planName } from './preflight'

/** The account, and the plan type as `claude auth status` says it, which the defaults follow (KERNEL-225). The window never sees the raw type. */
export type ReadAccount = ClaudeAccount & { subscriptionType?: string }

/** Reads the Claude login the CLI holds. Never throws: a missing CLI or an older one reads as signed out. */
export async function readAccount(): Promise<ReadAccount> {
  const a = await exec('claude', ['auth', 'status'], { timeoutMs: 15000 })
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
export async function claudeSignedIn(): Promise<boolean> {
  const a = await exec('claude', ['auth', 'status'], { timeoutMs: 15000 })
  try { return !!JSON.parse(a.stdout).loggedIn } catch { return false }
}

export async function signOut(): Promise<ReadAccount> {
  await exec('claude', ['auth', 'logout'], { timeoutMs: 15000 })
  return readAccount()
}
