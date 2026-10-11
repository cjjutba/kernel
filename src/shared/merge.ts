import type { AppSettings, PrCheck, PrInfo, ReviewVerdict, Workspace } from './types'

/**
 * Whether a PR may merge, one rule for every Merge button and the Lead's tools (KERNEL-115). Pure, so main and the
 * renderer agree on it.
 */

/** Every check passed or was skipped. A PR with no checks counts as green. */
export const allGreen = (checks: PrCheck[]) => checks.every((c) => c.state === 'pass' || c.state === 'skipped')

/** Verdicts on the workspace's PR, and those of them on its head commit, as far as either is known. */
export function reviewVerdicts(ws: Pick<Workspace, 'reviews' | 'prNumber' | 'prHead'>): { verdicts: ReviewVerdict[]; current: ReviewVerdict[] } {
  const verdicts = (ws.reviews ?? []).filter((v) => !v.prNumber || !ws.prNumber || v.prNumber === ws.prNumber)
  return { verdicts, current: verdicts.filter((v) => !v.sha || !ws.prHead || v.sha === ws.prHead) }
}

/**
 * Whether the merge has to read the PR from GitHub first: for its checks, or for its head commit when a reviewer looked at
 * it. A PR nobody reviewed, with green checks not required, merges on what Kernel already knows.
 */
export function mergeNeedsPr(ws: Pick<Workspace, 'reviews'>, rules: Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>): boolean {
  return rules.requireGreen || (rules.requireReviewer && !!ws.reviews?.length)
}

/**
 * Why the workspace's PR can't merge, or undefined when it can. `pr` is the PR as GitHub reports it now, and its head
 * commit wins over the one the last poll saw. With "require Reviewer approval" on, a PR a reviewer looked at needs an
 * approval of its head commit and no blockers on it; one nobody reviewed merges as before. `name` turns an agent id into
 * the reviewer's name.
 */
export function mergeBlock(ws: Workspace, pr: PrInfo | null | undefined, rules: Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>, name: (agentId: string) => string = (id) => id): string | undefined {
  if (ws.prState !== 'ready' && ws.prState !== 'open') return 'This pull request is not ready to merge.'
  if (mergeNeedsPr(ws, rules) && !pr) return 'Could not read the pull request from GitHub.'
  if (rules.requireGreen && pr && !allGreen(pr.checks)) return 'Checks have not passed yet. Merging needs green checks (Settings, Pull requests).'
  if (!rules.requireReviewer) return undefined
  const { verdicts, current } = reviewVerdicts({ ...ws, prHead: pr?.head ?? ws.prHead })
  const latest = (vs: ReviewVerdict[]) => vs.reduce((a, b) => (b.ts > a.ts ? b : a))
  // The reviewer who found blockers on the head commit, else whoever reviewed last when nobody approved the head commit.
  const blocking = current.filter((v) => v.verdict === 'blockers')
  const holder = blocking.length ? latest(blocking) : verdicts.length && !current.some((v) => v.verdict === 'approved') ? latest(verdicts) : undefined
  return holder && `${name(holder.agentId)} hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests).`
}
