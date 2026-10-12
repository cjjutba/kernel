import type { AppSettings, PrBlocked, PrCheck, PrInfo, PrState, ReviewVerdict, Workspace } from './types'

/**
 * Whether a PR may merge, one rule for every Merge button and the Lead's tools (KERNEL-115). Pure, so main and the
 * renderer agree on it.
 */

/** The PR states a merge can start from. Any other state, a merge already running included, offers no Merge (KERNEL-349). */
export const mergeableState = (state: PrState): state is 'ready' | 'open' => state === 'ready' || state === 'open'

/**
 * Why a PR in this state can't merge, in a few lowercase words for a sentence: Rowan's merge_workspace and Merge all
 * (KERNEL-411) both say it. Nothing for the states a merge can start from, which `mergeBlock` checks.
 */
export const notMergeable: Partial<Record<PrState, string>> = {
  none: 'it has no pull request yet', creating: 'its pull request is still being opened', draft: 'it is still a draft',
  checks: 'checks are still running', cifail: 'checks failing', changes: 'a review asked for changes', conflict: 'it has merge conflicts',
  resolving: 'its conflicts are being resolved', merging: 'it is already merging', merged: 'it already merged', closed: 'it was closed'
}

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
 * The reviewer who found blockers on the PR's head commit, by agent id, and how many that review found, or nothing. With
 * blockers from more than one review, the latest names them. Pass GitHub's head as `prHead` when there is a fresh read.
 */
export function headBlockers(ws: Pick<Workspace, 'reviews' | 'prNumber' | 'prHead'>): { agentId: string; count: number } | undefined {
  const blocking = reviewVerdicts(ws).current.filter((v) => v.verdict === 'blockers')
  if (!blocking.length) return undefined
  const v = blocking.reduce((a, b) => (b.ts > a.ts ? b : a))
  return { agentId: v.agentId, count: v.blockers?.length || 1 }
}

/**
 * Whether the merge can't go ahead without reading the PR from GitHub: for its checks, or for its head commit when a
 * reviewer looked at it, since blockers on the head commit hold the merge whatever the reviewer rule says (KERNEL-497). A
 * merge always reads GitHub first (KERNEL-376); when that read fails and nothing needs it, the merge goes ahead on what
 * Kernel already knows.
 */
export function mergeNeedsPr(ws: Pick<Workspace, 'reviews'>, rules: Pick<AppSettings['pr'], 'requireGreen'>): boolean {
  return rules.requireGreen || !!ws.reviews?.length
}

/**
 * Why the workspace's PR can't merge, or undefined when it can. `pr` is the PR as GitHub reports it now: it has to be
 * ready or open, and settled on whether it conflicts, which GitHub works out again each time the base moves (KERNEL-376).
 * Only the checks that decide the PR count, and GitHub's own branch rules hold it too (KERNEL-388). Its head commit wins
 * over the one the last poll saw. Blockers on the head commit hold the merge whatever the settings say (KERNEL-497). With
 * "require Reviewer approval" on, a PR a reviewer looked at needs an approval of its head commit too; one nobody reviewed
 * merges as before. `override` is a person's Merge anyway: it skips the review, and only the review. `name` turns an agent
 * id into the reviewer's name.
 */
export function mergeBlock(ws: Workspace, pr: PrInfo | null | undefined, rules: Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>, name: (agentId: string) => string = (id) => id, o: { override?: boolean } = {}): string | undefined {
  if (!mergeableState(ws.prState)) return 'This pull request is not ready to merge.'
  if (mergeNeedsPr(ws, rules) && !pr) return 'Could not read the pull request from GitHub.'
  if (rules.requireGreen && pr && !allGreen(gatingChecks(pr.checks))) return 'Checks have not passed yet. Merging needs green checks (Settings, Pull requests).'
  // GitHub's own rules hold the merge even when Kernel's would let it through. With no read, the last poll's word (KERNEL-388).
  const blocked = pr ? pr.blocked : ws.prBlocked
  if (blocked) return blockedText(blocked, pr?.baseRef ?? '')
  if (pr && (pr.conflictsUnknown || !mergeableState(pr.state))) return 'This pull request is not ready to merge.'
  if (o.override) return undefined
  const at = { ...ws, prHead: pr?.head ?? ws.prHead }
  const found = headBlockers(at)
  if (found) return `${name(found.agentId)} found ${found.count} ${found.count === 1 ? 'blocker' : 'blockers'} on the latest commit. Merge anyway to go ahead.`
  if (!rules.requireReviewer) return undefined
  // Nobody approved the head commit of a PR a reviewer looked at: whoever reviewed last holds it.
  const { verdicts, current } = reviewVerdicts(at)
  if (!verdicts.length || current.some((v) => v.verdict === 'approved')) return undefined
  const holder = verdicts.reduce((a, b) => (b.ts > a.ts ? b : a))
  return `${name(holder.agentId)} hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests).`
}

/** Where a PR's review stands, in the words of the PRs tab and the Team update card. `tone` is the color both draw it in. */
export interface ReviewPhrase { text: string; tone: 'good' | 'bad' | 'faint' }

/**
 * One wording for a PR's review wherever it shows (KERNEL-411): "Theo is reviewing", "Theo found 2 blockers", "Theo approved",
 * "Lumi reviewed an earlier commit" or "Not reviewed". Names come resolved. A review in progress wins, then blockers on the
 * head commit, then approvals of it, then a review of an earlier commit.
 */
export function reviewPhrase(r: { reviewing?: string; blockers?: { name: string; count?: number }; approvedBy?: string[]; stale?: string | true }): ReviewPhrase {
  if (r.reviewing) return { text: `${r.reviewing} is reviewing`, tone: 'faint' }
  if (r.blockers) {
    const n = r.blockers.count
    return { text: `${r.blockers.name} found ${n ? `${n} ${n === 1 ? 'blocker' : 'blockers'}` : 'blockers'}`, tone: 'bad' }
  }
  if (r.approvedBy?.length) return { text: `${r.approvedBy.join(' and ')} approved`, tone: 'good' }
  if (r.stale) return { text: r.stale === true ? 'Reviewed an earlier commit' : `${r.stale} reviewed an earlier commit`, tone: 'faint' }
  return { text: 'Not reviewed', tone: 'faint' }
}
