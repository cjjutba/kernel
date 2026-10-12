import { REVIEW_KINDS, type AppSettings, type AutoMerge, type PrBlocked, type PrCheck, type PrInfo, type PrState, type ReviewKind, type ReviewVerdict, type Workspace } from './types'

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

/** A verdict's kind of review. One from before review kinds counts as the code review's (KERNEL-549). */
export const lensOf = (v: Pick<ReviewVerdict, 'lens'>): ReviewKind => v.lens ?? 'code'

/** Kinds in a sentence, in REVIEW_KINDS' order: "Code", "Security and UX", "Code, security and UX". */
export function kindsText(kinds: readonly ReviewKind[]): string {
  const words = REVIEW_KINDS.filter((k) => kinds.includes(k.id)).map((k) => (k.id === 'ux' ? k.label : k.label.toLowerCase()))
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? ''
  return list.charAt(0).toUpperCase() + list.slice(1)
}

/** "The code review", "The code and security reviews". */
export function reviewsText(kinds: readonly ReviewKind[]): string {
  const list = kindsText(kinds)
  return `The ${list.startsWith('UX') ? list : list.charAt(0).toLowerCase() + list.slice(1)} ${kinds.length === 1 ? 'review' : 'reviews'}`
}

/** Where each kind of review stands on the PR's head commit (KERNEL-549). Kinds come in REVIEW_KINDS' order. */
export interface KindStates {
  /** Kinds with a verdict on this PR, on any commit. */
  ran: ReviewKind[]
  /** Kinds whose verdict on the head commit found blockers. */
  blocking: ReviewKind[]
  /** How many blockers they found: the latest blocking verdict of each kind, added up. */
  count: number
  /** The agent behind the latest of those verdicts. */
  agentId?: string
  /** Kinds that approved the head commit, where no verdict of the same kind found blockers on it. */
  approved: ReviewKind[]
  /** Required kinds that ran and haven't approved the head commit. A kind is required unless its latest verdict says optional. */
  waiting: ReviewKind[]
}

/**
 * The PR's verdicts read kind by kind (KERNEL-549). Verdicts of two kinds both count. Within a kind, blockers on the head
 * commit from any review hold it, and an approval of the head commit stands only without them.
 */
export function kindStates(ws: Pick<Workspace, 'reviews' | 'prNumber' | 'prHead'>): KindStates {
  const { verdicts, current } = reviewVerdicts(ws)
  const latest = <T extends { ts: number }>(vs: T[]) => vs.reduce((a, b) => (b.ts > a.ts ? b : a))
  const kinds = REVIEW_KINDS.map((k) => k.id)
  const ran = kinds.filter((k) => verdicts.some((v) => lensOf(v) === k))
  const blockingOf = (k: ReviewKind) => current.filter((v) => lensOf(v) === k && v.verdict === 'blockers')
  const blocking = ran.filter((k) => blockingOf(k).length)
  const all = current.filter((v) => v.verdict === 'blockers')
  const approved = ran.filter((k) => !blocking.includes(k) && current.some((v) => lensOf(v) === k && v.verdict === 'approved'))
  const required = (k: ReviewKind) => !latest(verdicts.filter((v) => lensOf(v) === k)).optional
  return {
    ran, blocking, count: blocking.reduce((n, k) => n + (latest(blockingOf(k)).blockers?.length || 1), 0),
    ...(all.length ? { agentId: latest(all).agentId } : {}),
    approved, waiting: ran.filter((k) => required(k) && !approved.includes(k))
  }
}

/**
 * The reviews that found blockers on the PR's head commit, how many they found, and the agent behind the latest of them, or
 * nothing (KERNEL-497, read per kind since KERNEL-549). Pass GitHub's head as `prHead` when there is a fresh read.
 */
export function headBlockers(ws: Pick<Workspace, 'reviews' | 'prNumber' | 'prHead'>): { agentId: string; count: number; lenses: ReviewKind[] } | undefined {
  const s = kindStates(ws)
  return s.blocking.length && s.agentId ? { agentId: s.agentId, count: s.count, lenses: s.blocking } : undefined
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
 * over the one the last poll saw. Blockers on the head commit, from any kind of review, hold the merge whatever the settings
 * say (KERNEL-497, KERNEL-549). With "require Reviewer approval" on, every required kind of review that looked at the PR
 * needs to have approved its head commit; a PR nobody reviewed merges as before. `override` is a person's Merge anyway: it
 * skips the review, and only the review. `name` is no longer read: the reasons name the kinds of review since KERNEL-549.
 */
export function mergeBlock(ws: Workspace, pr: PrInfo | null | undefined, rules: Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>, _name: (agentId: string) => string = (id) => id, o: { override?: boolean } = {}): string | undefined {
  if (!mergeableState(ws.prState)) return 'This pull request is not ready to merge.'
  if (mergeNeedsPr(ws, rules) && !pr) return 'Could not read the pull request from GitHub.'
  if (rules.requireGreen && pr && !allGreen(gatingChecks(pr.checks))) return 'Checks have not passed yet. Merging needs green checks (Settings, Pull requests).'
  // GitHub's own rules hold the merge even when Kernel's would let it through. With no read, the last poll's word (KERNEL-388).
  const blocked = pr ? pr.blocked : ws.prBlocked
  if (blocked) return blockedText(blocked, pr?.baseRef ?? '')
  if (pr && (pr.conflictsUnknown || !mergeableState(pr.state))) return 'This pull request is not ready to merge.'
  if (o.override) return undefined
  const s = kindStates({ ...ws, prHead: pr?.head ?? ws.prHead })
  if (s.blocking.length) return `${reviewsText(s.blocking)} found ${s.count} ${s.count === 1 ? 'blocker' : 'blockers'} on the latest commit. Merge anyway to go ahead.`
  if (!rules.requireReviewer || !s.waiting.length) return undefined
  return `${reviewsText(s.waiting)} ${s.waiting.length === 1 ? "hasn't" : "haven't"} approved the latest commit. Merging waits for every required review (Settings, Pull requests).`
}

/** Where a PR's review stands, in the words of the PRs tab and the Team update card. `tone` is the color both draw it in. */
export interface ReviewPhrase { text: string; tone: 'good' | 'bad' | 'faint' }

/**
 * One wording for a PR's review wherever it shows (KERNEL-411), by kind of review (KERNEL-549): "Security found 2 blockers",
 * "Code and security reviews are running", "Review is starting", "Code and security approved", "Reviewed an earlier commit" or
 * "Not reviewed".
 * Blockers on the head commit win, then reviews still running, then approvals of it, then a review of an earlier commit.
 */
export function reviewPhrase(r: { reviewing?: ReviewKind[]; blockers?: { lenses: ReviewKind[]; count?: number }; approved?: ReviewKind[]; stale?: boolean }): ReviewPhrase {
  if (r.blockers?.lenses.length) {
    const n = r.blockers.count
    return { text: `${kindsText(r.blockers.lenses)} found ${n ? `${n} ${n === 1 ? 'blocker' : 'blockers'}` : 'blockers'}`, tone: 'bad' }
  }
  // No kinds yet: Kernel is still working out which reviews the PR gets.
  if (r.reviewing) return { text: r.reviewing.length ? `${kindsText(r.reviewing)} ${r.reviewing.length === 1 ? 'review is' : 'reviews are'} running` : 'Review is starting', tone: 'faint' }
  if (r.approved?.length) return { text: `${kindsText(r.approved)} approved`, tone: 'good' }
  if (r.stale) return { text: 'Reviewed an earlier commit', tone: 'faint' }
  return { text: 'Not reviewed', tone: 'faint' }
}

/** The PR's review in those words from its verdicts alone, for the PRs tab, which doesn't know what is running. */
export function verdictPhrase(ws: Pick<Workspace, 'reviews' | 'prNumber' | 'prHead'>): ReviewPhrase {
  const s = kindStates(ws)
  if (!s.ran.length) return reviewPhrase({})
  if (s.blocking.length) return reviewPhrase({ blockers: { lenses: s.blocking, count: s.count } })
  if (s.approved.length) return reviewPhrase({ approved: s.approved })
  return reviewPhrase({ stale: true })
}

/**
 * Paths a PR never merges by itself through, whatever any settings file says (KERNEL-556): Kernel's settings, the agents'
 * files and instructions, and CI. The base branch's `[merge] always_review` and the user's own list add to them. Kernel
 * matches them without case, as the Mac's disk does. The agents' files and instructions count in any folder, since Claude Code
 * reads nested ones in a monorepo (KERNEL-632).
 */
export const ALWAYS_REVIEW: readonly string[] = ['.kernel/**', '**/.claude/agents/**', '**/CLAUDE.md', '**/AGENTS.md', '.github/workflows/**']

/**
 * What Kernel weighs before it merges a PR by itself (KERNEL-556). Main gathers it, and `autoMergeBlock` decides. `rules` is the
 * user's own `pr.autoMerge` for the room. `pr` is GitHub's read of the PR now, null when there was none. `reviews`: the kinds
 * of review its base branch's `[review]` requires of it, the kinds that approved its head commit or found blockers on it, and
 * whether a review of it is still running. `diff`: the lines it adds and removes together, and the always-review paths among
 * its files. Either one is missing when Kernel couldn't read it.
 */
export interface AutoMergeFacts {
  rules: AutoMerge
  /** The room merges on this Mac (KERNEL-467). */
  local: boolean
  /** Settings, Pull requests' "Require green checks to merge". */
  requireGreen: boolean
  pr?: PrInfo | null
  reviews?: { required: ReviewKind[]; approved: ReviewKind[]; blocking: ReviewKind[]; running: boolean }
  diff?: { lines: number; touched: string[] }
}

/**
 * Why Kernel won't merge a PR by itself, or undefined when it may (KERNEL-556). Every condition has to hold: auto-merge on, a
 * PR on GitHub rather than a local merge, green checks required and at least one check that decides the PR, all of them
 * green, nothing GitHub blocks, every required kind of review approved the head commit and none found blockers on it, no
 * review still running, under the line limit, and no always-review path changed. A fact Kernel couldn't read refuses too.
 * A PR with no checks fails here though `allGreen([])` is true: nothing tested it.
 */
export function autoMergeBlock(f: AutoMergeFacts): string | undefined {
  if (!f.rules.on) return 'Auto-merge is off.'
  if (f.local) return 'This room merges on this Mac, and auto-merge only merges pull requests on GitHub.'
  const pr = f.pr
  if (!pr) return "Kernel couldn't read the pull request from GitHub."
  if (!f.requireGreen) return 'Require green checks to merge is off in Settings, Pull requests, and auto-merge needs it on.'
  const checks = gatingChecks(pr.checks)
  if (!checks.length) return 'It has no required checks, and auto-merge needs at least one to pass.'
  if (!allGreen(checks)) return 'Not every required check has passed.'
  if (pr.blocked) return blockedText(pr.blocked, pr.baseRef)
  if (pr.state !== 'ready' || pr.conflictsUnknown) return "GitHub doesn't read it as ready to merge."
  const r = f.reviews
  if (!r) return "Kernel couldn't tell which reviews it needs."
  if (r.blocking.length) return `${reviewsText(r.blocking)} found blockers on the latest commit.`
  if (!r.required.length) return 'None of its reviews is required, and auto-merge needs a required review to approve it.'
  const missing = r.required.filter((k) => !r.approved.includes(k))
  if (missing.length) return `${reviewsText(missing)} ${missing.length === 1 ? "hasn't" : "haven't"} approved the latest commit.`
  if (r.running) return 'A review of it is still running.'
  const d = f.diff
  if (!d) return "Kernel couldn't read what it changes."
  if (d.lines > f.rules.maxLines) return `It changes ${d.lines} lines, more than the ${f.rules.maxLines} auto-merge allows.`
  const [first, ...rest] = d.touched
  if (!first) return undefined
  return rest.length
    ? `It changes ${first} and ${rest.length} other ${rest.length === 1 ? 'file' : 'files'} that always need a person's review.`
    : `It changes ${first}, which always needs a person's review.`
}

/**
 * Why Kernel merged a PR by itself, for the Team update (KERNEL-556), or undefined when it may not. `why` follows "since" in the
 * Lead's text. `card` is the card's grey segment after "Merged automatically".
 */
export function autoMergeWhy(f: AutoMergeFacts): { why: string; card: string } | undefined {
  if (autoMergeBlock(f) || !f.pr || !f.reviews || !f.diff) return undefined
  const n = gatingChecks(f.pr.checks).length
  const lines = `${f.diff.lines} ${f.diff.lines === 1 ? 'line' : 'lines'}`
  const reviews = reviewsText(f.reviews.approved)
  return {
    why: `${reviews.charAt(0).toLowerCase()}${reviews.slice(1)} approved its latest commit, ${n === 1 ? 'its check' : `its ${n} required checks`} passed, it changes ${lines}, within the user's limit of ${f.rules.maxLines}, and it changes no path that always needs a person's review`,
    card: `${kindsText(f.reviews.approved)} approved, checks passed, ${lines}`
  }
}
