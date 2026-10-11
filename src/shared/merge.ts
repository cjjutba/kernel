import type { AppSettings, PrBlocked, PrCheck, PrInfo, PrState, ReviewVerdict, Workspace } from './types'

/**
 * Whether a PR may merge, one rule for every Merge button and the Lead's tools (KERNEL-115). Pure, so main and the
 * renderer agree on it.
 */

/** The PR states a merge can start from. Any other state, a merge already running included, offers no Merge (KERNEL-349). */
export const mergeableState = (state: PrState): state is 'ready' | 'open' => state === 'ready' || state === 'open'

/** Every check passed or was skipped. A PR with no checks counts as green. */
export const allGreen = (checks: PrCheck[]) => checks.every((c) => c.state === 'pass' || c.state === 'skipped')

/** The checks that decide a PR: all but the optional ones, which the repo doesn't require or the room lists (KERNEL-388). */
export const gatingChecks = (checks: PrCheck[]) => checks.filter((c) => !c.optional)

/** Why GitHub won't merge a ready PR, in a few words for a list or a card: "GitHub blocks the merge: {why}" (KERNEL-401). */
export const blockedWhy: Record<PrBlocked, string> = { review: 'it needs an approving review', behind: 'the branch is behind its base', rules: "the branch's rules" }

/** Why GitHub won't merge a PR whose checks passed, as Merge PR and the Lead say it. `base` is the branch it merges into. */
export function blockedText(blocked: PrBlocked, base: string): string {
  if (blocked === 'review') return 'GitHub needs an approving review before this pull request can merge.'
  if (blocked === 'behind') return `This branch is behind ${base || 'its base'}, and GitHub needs it up to date before it can merge.`
  return "GitHub's branch rules block this merge."
}

/** Verdicts on the workspace's PR, and those of them on its head commit, as far as either is known. */
export function reviewVerdicts(ws: Pick<Workspace, 'reviews' | 'prNumber' | 'prHead'>): { verdicts: ReviewVerdict[]; current: ReviewVerdict[] } {
  const verdicts = (ws.reviews ?? []).filter((v) => !v.prNumber || !ws.prNumber || v.prNumber === ws.prNumber)
  return { verdicts, current: verdicts.filter((v) => !v.sha || !ws.prHead || v.sha === ws.prHead) }
}

/**
 * Whether the merge can't go ahead without reading the PR from GitHub: for its checks, or for its head commit when a
 * reviewer looked at it. A merge always reads GitHub first (KERNEL-376); when that read fails and neither rule needs it,
 * the merge goes ahead on what Kernel already knows.
 */
export function mergeNeedsPr(ws: Pick<Workspace, 'reviews'>, rules: Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>): boolean {
  return rules.requireGreen || (rules.requireReviewer && !!ws.reviews?.length)
}

/**
 * Why the workspace's PR can't merge, or undefined when it can. `pr` is the PR as GitHub reports it now: it has to be
 * ready or open, and settled on whether it conflicts, which GitHub works out again each time the base moves (KERNEL-376).
 * Only the checks that decide the PR count, and GitHub's own branch rules hold it too (KERNEL-388). Its head commit wins
 * over the one the last poll saw. With "require Reviewer approval" on, a PR a reviewer looked at needs an approval of its
 * head commit and no blockers on it; one nobody reviewed merges as before. `name` turns an agent id into the reviewer's name.
 */
export function mergeBlock(ws: Workspace, pr: PrInfo | null | undefined, rules: Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>, name: (agentId: string) => string = (id) => id): string | undefined {
  if (!mergeableState(ws.prState)) return 'This pull request is not ready to merge.'
  if (mergeNeedsPr(ws, rules) && !pr) return 'Could not read the pull request from GitHub.'
  if (rules.requireGreen && pr && !allGreen(gatingChecks(pr.checks))) return 'Checks have not passed yet. Merging needs green checks (Settings, Pull requests).'
  // GitHub's own rules hold the merge even when Kernel's would let it through. With no read, the last poll's word (KERNEL-388).
  const blocked = pr ? pr.blocked : ws.prBlocked
  if (blocked) return blockedText(blocked, pr?.baseRef ?? '')
  if (pr && (pr.conflictsUnknown || !mergeableState(pr.state))) return 'This pull request is not ready to merge.'
  if (!rules.requireReviewer) return undefined
  const { verdicts, current } = reviewVerdicts({ ...ws, prHead: pr?.head ?? ws.prHead })
  const latest = (vs: ReviewVerdict[]) => vs.reduce((a, b) => (b.ts > a.ts ? b : a))
  // The reviewer who found blockers on the head commit, else whoever reviewed last when nobody approved the head commit.
  const blocking = current.filter((v) => v.verdict === 'blockers')
  const holder = blocking.length ? latest(blocking) : verdicts.length && !current.some((v) => v.verdict === 'approved') ? latest(verdicts) : undefined
  return holder && `${name(holder.agentId)} hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests).`
}
