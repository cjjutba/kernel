import type { GithubIssue, IssueSummary, PrSummary, WorkspaceSource } from '@shared/types'

export type FromTab = 'prs' | 'branches' | 'issues'

/** One row in the From popover. `id` is the number or issue key, empty for branches. */
export interface FromRow {
  key: string; id: string; title: string; source: WorkspaceSource; baseRef: string; prompt: string
  /** Whose it is, as the login or name the row's avatar draws: a GitHub issue's first assignee (NewWorkspaceFromGitHub.png). */
  who?: string
}

/** `remote` is the room's git remote (Settings > Git), and a PR's branch lives on it. */
export const prRow = (p: PrSummary, remote = 'origin'): FromRow => ({
  key: `pr-${p.number}`, id: `#${p.number}`, title: p.title,
  source: { kind: 'pr', number: p.number, title: p.title }, baseRef: `${remote}/${p.branch}`, prompt: `Continue PR #${p.number}: ${p.title}`
})

export const branchRow = (branch: string): FromRow => ({
  key: `branch-${branch}`, id: '', title: branch, source: { kind: 'branch', branch }, baseRef: branch, prompt: `Work on ${branch}: `
})

/** An issue of the room's tracker. The source says which tracker it came from, when the tracker did (KERNEL-462). */
export const issueRow = (i: IssueSummary): FromRow => ({
  key: `issue-${i.id}`, id: i.id, title: i.title, source: { kind: 'issue', id: i.id, title: i.title, url: i.url, ...(i.source ? { tracker: i.source } : {}) }, baseRef: '', prompt: `${i.id}: ${i.title}`
})

/** A GitHub issue from the Issues list, with its assignee. */
export const githubIssueRow = (i: GithubIssue): FromRow => ({
  key: `issue-${i.id}`, id: i.id, title: i.title, source: { kind: 'issue', id: i.id, title: i.title, url: i.url || undefined, tracker: 'github' }, baseRef: '', prompt: `${i.id}: ${i.title}`,
  ...(i.assignees[0] ? { who: i.assignees[0] } : {})
})

/** The button label and chip text for a picked source. */
export function sourceLabel(s: WorkspaceSource | null): { button: string; chip: string } {
  if (!s) return { button: 'New branch', chip: '' }
  if (s.kind === 'pr') return { button: `From #${s.number}`, chip: `#${s.number} ${s.title}` }
  if (s.kind === 'issue') return { button: `From ${s.id}`, chip: `${s.id} ${s.title}` }
  return { button: `From ${s.branch}`, chip: s.branch }
}

/** Branch names the From popover and the target menu offer, filtered by the search text. */
export const matches = (text: string, q: string) => !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase())

/** The room remote's branches for the Target branch menu. Falls back to the room's default branch. */
export function targetOptions(branches: string[], fallback: string, current: string, remote = 'origin'): string[] {
  const onRemote = branches.filter((b) => b.startsWith(`${remote}/`))
  const list = onRemote.length ? onRemote : [fallback]
  return list.includes(current) ? list : [current, ...list]
}
