import type { IssueTaken, IssueTakenFinding } from '@shared/types'
import { joinLabels } from '@shared/waits'
import { taskToken } from './worktrees'

// Before Kernel starts a workspace on an issue, it looks for signs that someone else is already on it: a branch on the remote,
// an open PR, another assignee (KERNEL-479). Each check has its own time limit, and one that fails or runs out adds a note
// instead of holding the start up.

/** How long each check may take. */
export const TAKEN_TIMEOUT_MS = 10_000

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a branch name holds the issue key, as Kernel and the trackers name branches: `feat/kernel-31-export-pdf` for
 * KERNEL-31, in any case. A GitHub number has to start a part of the name (`feat/41-crash`, `41-crash`), since a bare number
 * anywhere matches too much. KERNEL-31 never matches kernel-310.
 */
export function keyInBranch(key: string, branch: string): boolean {
  const token = taskToken(key)
  if (!token) return false
  const re = /^\d+$/.test(token) ? new RegExp(`(^|/)${token}(-|/|$)`) : new RegExp(`(^|[^a-z0-9])${escape(token)}(?![0-9])`, 'i')
  return re.test(branch)
}

/** Whether a PR's title or description names the key: "KERNEL-31" as a word in any case, or "#41" for a GitHub number. */
export function keyInText(key: string, text: string): boolean {
  const k = key.trim()
  if (!k) return false
  const n = /^#?(\d+)$/.exec(k)?.[1]
  const re = n ? new RegExp(`#${n}(?![0-9])`) : new RegExp(`(^|[^a-z0-9])${escape(k)}(?![0-9])`, 'i')
  return re.test(text)
}

/** An open PR as the check reads it. */
export interface OpenPr { number: number; title: string; url?: string; branch: string; body?: string }

export interface TakenChecks {
  /** The project's remote, which names the branches found: "origin". */
  remote: string
  /** The branch names on the remote. Nothing when the project has no such remote, which is no note. */
  branches: () => Promise<string[] | undefined>
  /** Open PRs that may name the key. Left out when the project's code host can't say: no GitHub repo, or it merges locally. */
  prs?: () => Promise<OpenPr[]>
  /** The issue's assignees. Left out when the project's tracker can't read this key. */
  assignees?: () => Promise<{ name: string; me?: boolean }[]>
  /** The tracker's name, for its note: "Linear". */
  tracker?: string
  /** The branches and PR numbers of the project's own workspaces. Those are the user's work, not someone else's. */
  own: { branches: Set<string>; prs: Set<number> }
  timeoutMs?: number
}

/** "no answer in 10 seconds", or the error's first line without its last period. */
function reason(e: unknown): string {
  const line = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0].trim()
  return line.replace(/\.$/, '') || 'it failed'
}

/** `p`, or a rejection once `ms` runs out. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const s = Math.max(1, Math.round(ms / 1000))
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${s} second${s === 1 ? '' : 's'}`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

type Read<T> = { ok: true; value: T } | { ok: false; note: string }

/**
 * Runs the checks at once, each within `timeoutMs`. Findings come in the order the notice lists them: branches, PRs, assignees.
 * A check that failed, ran out or couldn't tell adds a note in the same order. Never rejects.
 */
export async function issueTaken(key: string, c: TakenChecks): Promise<IssueTaken> {
  const ms = c.timeoutMs ?? TAKEN_TIMEOUT_MS
  const read = async <T>(run: () => Promise<T>, failed: (why: string) => string): Promise<Read<T>> => {
    try { return { ok: true, value: await within(Promise.resolve().then(run), ms) } } catch (e) { return { ok: false, note: failed(reason(e)) } }
  }
  const [branches, prs, assignees] = await Promise.all([
    read(c.branches, (why) => `Couldn't check ${c.remote} for a branch named after ${key}: ${why}.`),
    c.prs ? read(c.prs, (why) => `Couldn't check for an open pull request that names ${key}: ${why}.`) : undefined,
    c.assignees ? read(c.assignees, (why) => `Couldn't check who ${key} is assigned to in ${c.tracker ?? 'the issue tracker'}: ${why}.`) : undefined
  ])
  const findings: IssueTakenFinding[] = []
  const notes: string[] = []
  if (branches.ok) {
    for (const b of branches.value ?? []) if (keyInBranch(key, b) && !c.own.branches.has(b)) findings.push({ kind: 'branch', ref: `${c.remote}/${b}` })
  } else notes.push(branches.note)
  if (prs?.ok) {
    for (const p of prs.value) {
      if (c.own.prs.has(p.number) || c.own.branches.has(p.branch)) continue
      if (keyInText(key, `${p.title}\n${p.body ?? ''}`) || keyInBranch(key, p.branch)) findings.push({ kind: 'pr', number: p.number, title: p.title, ...(p.url ? { url: p.url } : {}) })
    }
  } else if (prs) notes.push(prs.note)
  if (assignees?.ok) {
    for (const a of assignees.value) if (a.me === false) findings.push({ kind: 'assignee', name: a.name })
    // A tracker that couldn't say who the user is: gh signed out, say. Calling the user someone else would hold them up for nothing.
    const unsure = assignees.value.filter((a) => a.me === undefined).map((a) => a.name)
    if (unsure.length) notes.push(`Couldn't tell whether ${joinLabels(unsure)}, assigned to ${key}, ${unsure.length > 1 ? 'are' : 'is'} you.`)
  } else if (assignees) notes.push(assignees.note)
  return { findings, notes }
}
