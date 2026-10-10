import { exec, run } from './exec'
import type { IssueSummary, PrCheck, PrInfo, PrState, PrSummary, ReviewComment, Workspace } from '@shared/types'

// Pull requests go through the GitHub CLI, which already holds the user's auth (D-006).

/** One entry of `statusCheckRollup`: a CheckRun (name, status, conclusion) or a StatusContext (context, state). */
export interface RollupItem {
  name?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
  startedAt?: string
  completedAt?: string
  detailsUrl?: string
  targetUrl?: string
  description?: string
}

export interface PrView {
  number: number
  url: string
  title?: string
  baseRefName?: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '' | null
  statusCheckRollup: RollupItem[]
  /** The PR's head commit. A reviewer's verdict on another commit is stale (KERNEL-130). */
  headRefOid?: string
}

const FIELDS = 'number,url,title,baseRefName,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefOid'
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const SKIPPED = ['SKIPPED', 'NEUTRAL', 'STALE']
const QUEUED = ['QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']

const secs = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s` }

/** One check as the Checks tab lists it. A finished check carries its duration. */
export function checkOf(c: RollupItem): PrCheck {
  const conclusion = String(c.conclusion ?? '').toUpperCase()
  const state = String(c.state ?? '').toUpperCase()
  const status = String(c.status ?? '').toUpperCase()
  const name = c.name ?? c.context ?? 'check'
  const url = c.detailsUrl ?? c.targetUrl
  const took = c.startedAt && c.completedAt && !c.completedAt.startsWith('0001') ? secs(Date.parse(c.completedAt) - Date.parse(c.startedAt)) : undefined
  const done = (s: PrCheck['state']): PrCheck => ({ name, state: s, ...(took ? { meta: took } : {}), ...(url ? { url } : {}) })
  if (FAILED.includes(conclusion) || FAILED.includes(state)) return done('fail')
  if (SKIPPED.includes(conclusion)) return done('skipped')
  if (conclusion === 'SUCCESS' || state === 'SUCCESS') return done('pass')
  if (QUEUED.includes(status) || (state && QUEUED.includes(state) && state !== 'PENDING')) return { name, state: 'queued', ...(url ? { url } : {}) }
  return { name, state: 'running', ...(url ? { url } : {}) }
}

/** Collapse GitHub's PR fields into the one state the workspace header shows. */
export function prStateOf(pr: PrView | null): PrState {
  if (!pr) return 'none'
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.isDraft) return 'draft'
  if (pr.mergeable === 'CONFLICTING') return 'conflict'
  const checks = (pr.statusCheckRollup ?? []).map(checkOf)
  if (checks.some((c) => c.state === 'fail')) return 'cifail'
  if (checks.some((c) => c.state === 'running' || c.state === 'queued')) return 'checks'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  return 'ready'
}

/** Every check passed or was skipped. A PR without checks counts as green. */
export const allGreen = (checks: PrCheck[]) => checks.every((c) => c.state === 'pass' || c.state === 'skipped')

/** The query behind `prReviews`: review threads (inline comments) and each reviewer's latest review. */
export const REVIEWS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){'
  + 'reviewThreads(first:100){nodes{isResolved path line originalLine comments(first:1){nodes{id body author{login}}}}}'
  + 'latestReviews(first:20){nodes{id state body author{login}}}}}}'

/** Review comments from the GraphQL reply: one per thread, plus the body of each "changes requested" review. */
export function parseReviews(json: string): ReviewComment[] {
  try {
    const pr = JSON.parse(json)?.data?.repository?.pullRequest
    if (!pr) return []
    type Thread = { isResolved: boolean; path?: string; line?: number | null; originalLine?: number | null; comments?: { nodes?: { id: string; body: string; author?: { login?: string } | null }[] } }
    type Review = { id: string; state: string; body?: string; author?: { login?: string } | null }
    const threads = ((pr.reviewThreads?.nodes ?? []) as Thread[]).flatMap((t): ReviewComment[] => {
      const c = t.comments?.nodes?.[0]
      if (!c) return []
      const line = t.line ?? t.originalLine ?? undefined
      return [{ id: c.id, author: c.author?.login ?? '', ...(t.path ? { path: t.path } : {}), ...(line ? { line } : {}), body: c.body.trim(), resolved: t.isResolved }]
    })
    const reviews = ((pr.latestReviews?.nodes ?? []) as Review[])
      .filter((r) => r.state === 'CHANGES_REQUESTED' && r.body?.trim())
      .map((r): ReviewComment => ({ id: r.id, author: r.author?.login ?? '', body: r.body!.trim(), resolved: false }))
    return [...reviews, ...threads]
  } catch { return [] }
}

export async function prView(cwd: string, ref?: string): Promise<PrView | null> {
  const r = await exec('gh', ['pr', 'view', ...(ref ? [ref] : []), '--json', FIELDS], { cwd, timeoutMs: 20000 })
  if (r.code !== 0) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

/** Review comments for the "Changes requested" card and the address-review instructions. Empty when gh fails. */
export async function prReviews(cwd: string, number: number): Promise<ReviewComment[]> {
  const r = await exec('gh', ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${number}`, '-f', `query=${REVIEWS_QUERY}`], { cwd, timeoutMs: 20000 })
  return r.code === 0 ? parseReviews(r.stdout) : []
}

/** Files that conflict with the base, from a merge that touches neither the index nor the worktree (git 2.38+). */
export async function conflictFiles(cwd: string, base: string): Promise<string[]> {
  await exec('git', ['-C', cwd, 'fetch', '--quiet', 'origin', base], { timeoutMs: 20000 })
  const r = await exec('git', ['-C', cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', `origin/${base}`])
  if (r.code !== 1) return []
  return r.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
}

const reviewDecision = (d: PrView['reviewDecision']): PrInfo['reviewDecision'] =>
  d === 'APPROVED' ? 'approved' : d === 'CHANGES_REQUESTED' ? 'changes' : d === 'REVIEW_REQUIRED' ? 'pending' : undefined

/** What the header, the Checks tab and the review card show. */
export function infoOf(workspaceId: string, view: PrView, comments: ReviewComment[], conflicts: string[]): PrInfo {
  const decision = reviewDecision(view.reviewDecision)
  return {
    workspaceId, number: view.number, url: view.url, title: view.title ?? '', state: prStateOf(view), baseRef: view.baseRefName ?? '',
    checks: (view.statusCheckRollup ?? []).map(checkOf), comments, conflicts, ...(decision ? { reviewDecision: decision } : {}),
    ...(view.headRefOid ? { head: view.headRefOid } : {})
  }
}

/**
 * The PR for `ref` with its checks, review comments and conflicting files. `conflicts: false` is for a cwd that isn't the
 * PR's checkout (the room, when the worktree is gone): `conflictFiles` merges against cwd's HEAD, which would be main.
 */
export async function prInfo(cwd: string, ref: string, workspaceId: string, o: { conflicts?: boolean } = {}): Promise<PrInfo | null> {
  const view = await prView(cwd, ref)
  if (!view) return null
  const open = view.state === 'OPEN'
  const [comments, conflicts] = await Promise.all([
    open ? prReviews(cwd, view.number) : Promise.resolve([]),
    open && o.conflicts !== false && view.mergeable === 'CONFLICTING' && view.baseRefName ? conflictFiles(cwd, view.baseRefName) : Promise.resolve([])
  ])
  return infoOf(workspaceId, view, comments, conflicts)
}

export async function prCreate(cwd: string, o: { title: string; body: string; base: string; draft?: boolean }): Promise<PrView | null> {
  await run('git', ['-C', cwd, 'push', '-u', 'origin', 'HEAD'])
  await run('gh', ['pr', 'create', '--title', o.title, '--body', o.body, '--base', o.base.replace(/^origin\//, ''), ...(o.draft ? ['--draft'] : [])], { cwd, timeoutMs: 60000 })
  return prView(cwd)
}

export async function prReady(cwd: string, ref?: string) { await run('gh', ['pr', 'ready', ...(ref ? [ref] : [])], { cwd, timeoutMs: 30000 }) }
export async function prReopen(cwd: string, ref?: string) { await run('gh', ['pr', 'reopen', ...(ref ? [ref] : [])], { cwd, timeoutMs: 30000 }) }

export async function prMerge(cwd: string, method: 'squash' | 'merge' | 'rebase', o: { ref?: string; deleteBranch?: boolean } = {}) {
  await run('gh', ['pr', 'merge', ...(o.ref ? [o.ref] : []), `--${method}`, ...(o.deleteBranch ? ['--delete-branch'] : [])], { cwd, timeoutMs: 60000 })
}

/** The GitHub calls Kernel makes for a workspace's PR. Tests swap it for a stub. */
export interface GitHub {
  info: (cwd: string, ref: string, workspaceId: string, o?: { conflicts?: boolean }) => Promise<PrInfo | null>
  merge: (cwd: string, ref: string, method: 'squash' | 'merge' | 'rebase') => Promise<void>
  ready: (cwd: string, ref: string) => Promise<void>
  reopen: (cwd: string, ref: string) => Promise<void>
}

export const gh: GitHub = {
  info: prInfo,
  merge: (cwd, ref, method) => prMerge(cwd, method, { ref }),
  ready: prReady,
  reopen: prReopen
}

// ---------- what Kernel tells the agent and the chat

const FIX_CHECKS = '# Fix failing checks\n1. Run `gh pr checks` and read every failure.\n2. Reproduce it locally and fix the cause, not the test.\n3. Run the full suite, push, and summarize the fix.'
const ADDRESS_REVIEW = '# Address review\n1. Make each requested change below. Ask if one is unclear.\n2. Run the tests and push.\n3. Reply to each comment with what changed.'

/** The instruction file the agent gets for a conflict, failing checks or a review, with what GitHub reported. */
export function resolveFile(state: 'conflict' | 'cifail' | 'changes', resolveInstructions: string, info: PrInfo | null): [string, string] {
  if (state === 'conflict') {
    const files = info?.conflicts ?? []
    return ['resolve-conflicts.md', resolveInstructions + (files.length ? `\n\nConflicting files:\n${files.map((f) => `- ${f}`).join('\n')}` : '')]
  }
  if (state === 'cifail') {
    const failed = (info?.checks ?? []).filter((c) => c.state === 'fail')
    return ['fix-checks.md', FIX_CHECKS + (failed.length ? `\n\nFailing checks:\n${failed.map((c) => `- ${c.name}${c.url ? ` ${c.url}` : ''}`).join('\n')}` : '')]
  }
  const open = (info?.comments ?? []).filter((c) => !c.resolved)
  return ['address-review.md', ADDRESS_REVIEW + (open.length ? `\n\nReview comments:\n${open.map((c) => `- ${c.path ? `${c.path}${c.line ? `:${c.line}` : ''}` : 'Review'} (${c.author}): ${c.body.replace(/\s+/g, ' ')}`).join('\n')}` : '')]
}

const LANDED: Record<'squash' | 'merge' | 'rebase', string> = { squash: 'squashed into', merge: 'merged into', rebase: 'rebased onto' }

/** The note a PR state change leaves in the chat, or nothing. `method` is set when Kernel ran the merge. */
export function prNote(ws: Workspace, info: PrInfo | null, method?: 'squash' | 'merge' | 'rebase'): string | undefined {
  const n = ws.prNumber ? `PR #${ws.prNumber}` : 'The PR'
  const base = (info?.baseRef || ws.baseRef).replace(/^origin\//, '')
  if (ws.prState === 'merged') return method ? `${n} was ${LANDED[method]} ${base}.` : `${n} was merged on GitHub.`
  if (ws.prState === 'closed') return `${n} was closed without merging on GitHub.`
  if (ws.prState === 'cifail') {
    const names = (info?.checks ?? []).filter((c) => c.state === 'fail').map((c) => c.name)
    if (!names.length) return 'Checks failed on the PR.'
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    return `${list} failed on the PR.`
  }
  return undefined
}

/** Where the GitHub CLI stands. `offline` means gh has an account but couldn't reach GitHub to check its token. */
export interface GhAuth { state: 'missing' | 'signed-out' | 'offline' | 'ok'; login?: string }

/** Reads `gh auth status --json hosts` for github.com's active account. Null when it isn't that JSON. */
export function parseGhAuth(json: string): GhAuth | null {
  let hosts: Record<string, { state?: string; error?: string; active?: boolean; login?: string }[]> | undefined
  try { hosts = (JSON.parse(json) as { hosts?: typeof hosts }).hosts } catch { return null }
  if (!hosts) return null
  const active = hosts['github.com']?.find((a) => a.active)
  if (!active) return { state: 'signed-out' }
  const login = active.login || undefined
  if (active.state === 'success') return { state: 'ok', login }
  // GitHub rejecting the token is a 401. Any other error (no network, a timeout, an outage) leaves the sign-in standing.
  if (active.state === 'error' && /\b401\b|Bad credentials/.test(active.error ?? '')) return { state: 'signed-out', login }
  return { state: 'offline', login }
}

/** `gh auth status`, which reads gh's own config and doesn't fail just because GitHub is out of reach. */
export async function ghAuth(cmd: typeof exec = exec): Promise<GhAuth> {
  const r = await cmd('gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], { timeoutMs: 15000 })
  if (r.code === 127) return { state: 'missing' }
  const parsed = r.code === 0 ? parseGhAuth(r.stdout) : null
  if (parsed) return parsed
  if (!/unknown flag/.test(r.stderr)) return { state: 'offline' }
  // gh before `--json` on auth status: exit 0 means signed in and checked.
  const t = await cmd('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15000 })
  const login = /Logged in to github\.com (?:account|as) (\S+)/.exec(t.stdout + t.stderr)?.[1]
  return t.code === 0 ? { state: 'ok', login } : { state: 'signed-out' }
}

/** The signed-in GitHub login, when gh could check it with GitHub. */
export async function ghUser(cmd: typeof exec = exec): Promise<string | null> {
  const a = await ghAuth(cmd)
  return a.state === 'ok' ? a.login ?? null : null
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

export function parseIssueList(json: string): IssueSummary[] {
  try {
    return (JSON.parse(json) as { number: number; title: string; url?: string }[]).map((i) => ({ id: `#${i.number}`, title: i.title, url: i.url, source: 'github' as const }))
  } catch { return [] }
}

/** Open issues for + > Link issue, newest first. `query` is a GitHub search. Empty when gh is missing or signed out. */
export async function openIssues(cwd: string, query?: string): Promise<IssueSummary[]> {
  const q = query?.trim()
  const r = await exec('gh', ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url', ...(q ? ['--search', q.replace(/^#/, '')] : [])], { cwd, timeoutMs: 20000 })
  return r.code === 0 ? parseIssueList(r.stdout) : []
}
