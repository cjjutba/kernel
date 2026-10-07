import type { ClaudeAccount } from '@shared/types'
import { exec } from './exec'
import { ghUser } from './github'
import { planName } from './preflight'

/** Reads the Claude login the CLI holds. Never throws: a missing CLI or an older one reads as signed out. */
export async function readAccount(): Promise<ClaudeAccount> {
  const a = await exec('claude', ['auth', 'status'], { timeoutMs: 15000 })
  let status: { loggedIn?: boolean; subscriptionType?: unknown; email?: unknown } = {}
  try { status = JSON.parse(a.stdout) } catch { /* not signed in, or an older CLI */ }
  if (!status.loggedIn) return { signedIn: false }
  const email = typeof status.email === 'string' ? status.email : undefined
  const login = (await ghUser().catch(() => null)) ?? email?.split('@')[0]
  const git = await exec('git', ['config', '--global', 'user.name'], { timeoutMs: 5000 })
  const name = git.code === 0 && git.stdout.trim() ? git.stdout.trim() : login
  return { signedIn: true, name, login, email, plan: planName(status.subscriptionType) }
}

export async function signOut(): Promise<ClaudeAccount> {
  await exec('claude', ['auth', 'logout'], { timeoutMs: 15000 })
  return readAccount()
}
