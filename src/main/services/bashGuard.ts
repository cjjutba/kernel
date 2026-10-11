import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

// The Bash guard: what Kernel says about a command before Claude Code runs it (D-016). Never allow, the room's Always allow
// rules, then Always ask, plus the protected-branch and network checks. Moved out of sessions.ts and approvals.ts (KERNEL-230).

export type BashVerdict = 'deny' | 'allow' | 'ask' | undefined

/**
 * Kernel's say on one Bash command: Never allow, then the room's Always allow rules, then Always ask.
 * Undefined leaves it to Claude Code's own settings, so the user's allow list still covers everyday commands.
 */
export function bashVerdict(command: string, p: { neverAllow: string[]; alwaysAsk: string[]; protectedBranches?: string[]; network?: boolean }, roomAllow: string[]): BashVerdict {
  if (matchesRule(command, p.neverAllow) || pushesTo(command, p.protectedBranches ?? []) || (p.network === false && usesNetwork(command))) return 'deny'
  if (roomAllow.some((r) => matchesRoomRule(command, r))) return 'allow'
  if (matchesRule(command, p.alwaysAsk)) return 'ask'
  return undefined
}

/** The subcommand of a git call, skipping options such as `-C dir`. Returns its index in `t`, or -1. */
function gitSub(t: string[], sub: string): number {
  const g = t.indexOf('git')
  if (g < 0) return -1
  let j = g + 1
  while (j < t.length && t[j].startsWith('-')) j += ['-C', '-c', '--git-dir', '--work-tree'].includes(t[j]) ? 2 : 1
  return t[j] === sub ? j : -1
}

/** A `git push` that names a protected branch (`origin main`, `origin HEAD:main`, `origin HEAD:refs/heads/main`, `git -C dir push ...`). A bare `git push` names none, so it is left alone. */
export function pushesTo(command: string, branches: string[]): boolean {
  if (!branches.length) return false
  return command.split(/&&|\|\||[;|\n]/).some((part) => {
    const t = part.trim().split(/\s+/)
    const at = gitSub(t, 'push')
    if (at < 0) return false
    return t.slice(at + 1).filter((w) => !w.startsWith('-')).some((w) => branches.includes((w.replace(/^\+/, '').split(':').pop() ?? '').replace(/^refs\/heads\//, '')))
  })
}

export const NETWORK_OFF = 'Network access is off in Kernel (Settings, Permissions).'
const NET_PROGRAMS = /^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:curl|wget|nc|ncat|ssh|scp|rsync|ftp|sftp|telnet|gh)\b/
const NET_PACKAGE = /^(?:\w+=\S+\s+)*(?:npm|pnpm|yarn|bun|pip|pip3|brew)\s+(?:install|i|add|update|upgrade|publish)\b/
const NET_GIT = ['push', 'pull', 'fetch', 'clone', 'ls-remote']

/** Commands that reach the network: downloads, remote shells, package installs and git calls to a remote. Matched per command in a chain, so it is a guard for obvious cases, not a sandbox. */
export function usesNetwork(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((part) => {
    const c = part.trim()
    if (NET_PROGRAMS.test(c) || NET_PACKAGE.test(c)) return true
    const t = c.split(/\s+/)
    return NET_GIT.some((sub) => gitSub(t, sub) >= 0)
  })
}

/**
 * Room rules use Claude Code's Bash rule shape: `prefix:*` covers the prefix with any arguments, otherwise the exact command.
 * A prefix rule never covers a chained command, so `npm run build:*` can't wave through `npm run build && pnpm db:reset`.
 */
export function matchesRoomRule(command: string, rule: string): boolean {
  const c = command.trim()
  if (!rule.endsWith(':*')) return c === rule.trim()
  const prefix = rule.slice(0, -2).trim()
  return (c === prefix || c.startsWith(prefix + ' ')) && !/[;&|\n`]|\$\(/.test(c)
}

/**
 * The rule "Always allow in this room" saves: Claude Code's own suggestion when it is a single Bash rule and may be saved,
 * else the exact command.
 */
export function roomRule(command: string, suggestions?: PermissionUpdate[], suppressAlwaysAllowRule?: boolean): string {
  const rules = suppressAlwaysAllowRule ? [] : (suggestions ?? []).flatMap((s) => (s.type === 'addRules' && s.behavior === 'allow' ? s.rules : []))
  return rules.length === 1 && rules[0].toolName === 'Bash' && rules[0].ruleContent ? rules[0].ruleContent : command.trim()
}

/** Match a Bash command against Settings > Permissions lists (simple substring and * wildcard). */
export function matchesRule(command: string, rules: string[]): string | undefined {
  const c = command.trim()
  return rules.find((r) => {
    if (r.includes('*')) return new RegExp('^' + r.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(c)
    return c === r || c.startsWith(r + ' ') || c.includes(r)
  })
}
