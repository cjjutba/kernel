import type { ChatPart } from './types'

/** A linked issue or workspace (+ > Link issue, Link workspaces) as the line the agent reads. */
export function linkText(p: Extract<ChatPart, { type: 'issue' | 'workspace' }>): string {
  if (p.type === 'issue') return `Linked issue ${p.name}: ${p.title}${p.url ? ` (${p.url})` : ''}`
  const pr = p.prNumber ? `, PR #${p.prNumber}${p.prUrl ? ` ${p.prUrl}` : ''}` : ''
  return `Linked workspace ${p.name}: branch ${p.branch}, worktree ${p.path}${pr}. Read its files there, or diff its branch.`
}
