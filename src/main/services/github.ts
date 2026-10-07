import { exec, run } from './exec'
import type { PrState, PrSummary } from '@shared/types'

// Pull requests go through the GitHub CLI, which already holds CJ's auth.

export interface PrView {
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '' | null
  statusCheckRollup: { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string }[]
}

const FIELDS = 'number,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup'

/** Collapse GitHub's PR fields into the one state the workspace header shows. */
export function prStateOf(pr: PrView | null): PrState {
  if (!pr) return 'none'
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.isDraft) return 'draft'
  if (pr.mergeable === 'CONFLICTING') return 'conflict'
  const checks = pr.statusCheckRollup ?? []
  const failed = checks.some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(String(c.conclusion ?? c.state ?? '').toUpperCase()))
  if (failed) return 'cifail'
  const pending = checks.some((c) => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(String(c.state ?? '').toUpperCase()))
  if (pending) return 'checks'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  return 'ready'
}

export function checksOf(pr: PrView | null) {
  return (pr?.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? 'check', status: String(c.conclusion ?? c.state ?? c.status ?? '').toLowerCase() }))
}

export async function prView(cwd: string, ref?: string): Promise<PrView | null> {
  const r = await exec('gh', ['pr', 'view', ...(ref ? [ref] : []), '--json', FIELDS], { cwd, timeoutMs: 20000 })
  if (r.code !== 0) return null
  return JSON.parse(r.stdout)
}

export async function prCreate(cwd: string, o: { title: string; body: string; base: string; draft?: boolean }): Promise<PrView | null> {
  await run('git', ['-C', cwd, 'push', '-u', 'origin', 'HEAD'])
  await run('gh', ['pr', 'create', '--title', o.title, '--body', o.body, '--base', o.base.replace(/^origin\//, ''), ...(o.draft ? ['--draft'] : [])], { cwd, timeoutMs: 60000 })
  return prView(cwd)
}

export async function prReady(cwd: string) { await run('gh', ['pr', 'ready'], { cwd }) }
export async function prReopen(cwd: string) { await run('gh', ['pr', 'reopen'], { cwd }) }

export async function prMerge(cwd: string, method: 'squash' | 'merge' | 'rebase', deleteBranch = false) {
  await run('gh', ['pr', 'merge', `--${method}`, ...(deleteBranch ? ['--delete-branch'] : [])], { cwd, timeoutMs: 60000 })
}

/** Review comments, so "Changes requested" can be sent straight to the agent. */
export async function prReviewComments(cwd: string, number: number, repo: string): Promise<{ path: string; line?: number; body: string; author: string }[]> {
  const r = await exec('gh', ['api', `repos/${repo}/pulls/${number}/comments`], { cwd })
  if (r.code !== 0) return []
  return (JSON.parse(r.stdout) as any[]).map((c) => ({ path: c.path, line: c.line ?? c.original_line, body: c.body, author: c.user?.login ?? '' }))
}

export async function ghUser(): Promise<string | null> {
  const r = await exec('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 10000 })
  return r.code === 0 ? r.stdout.trim() : null
}

/** `gh pr list --json number,title,headRefName,author` rows as the From popover shows them. */
export function parsePrList(json: string): PrSummary[] {
  try {
    return (JSON.parse(json) as { number: number; title: string; headRefName: string; author?: { login?: string } }[])
      .map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, author: p.author?.login }))
  } catch { return [] }
}

/** Open pull requests, newest first. `query` is a GitHub search (title, number or author). Empty when gh is missing or signed out. */
export async function openPrs(cwd: string, query?: string): Promise<PrSummary[]> {
  const q = query?.trim()
  const r = await exec('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,author', ...(q ? ['--search', q.replace(/^#/, '')] : [])], { cwd, timeoutMs: 20000 })
  return r.code === 0 ? parsePrList(r.stdout) : []
}
