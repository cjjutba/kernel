import type { AppSettings, ChatItem, ChatPart, Overrule, PrInfo, PrPending, PrState, ReviewComment, ReviewKind, Toast, Workspace } from '@shared/types'
import { headBlockers, kindStates, kindsText, lensOf, mergeBlock, mergeableState, reviewVerdicts } from '@shared/merge'
import { stripRemote } from '../../settings/remote'

/** The rules a PR's merge reads (Settings, Pull requests). */
export type Rules = Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>

/** What the merge buttons read before the settings arrive: no rule holds a merge. */
export const NO_RULES: Rules = { requireGreen: false, requireReviewer: false }

/** What the header shows for each PR state, in the canvas order (WorkspacePRMenu, DraftPR, CIFailed, ChangesRequested, Merged, PRClosed). */
export interface PrHeaderView {
  /** The `#42` link to GitHub. */
  link: boolean
  /** A branch that merges on the Mac has no number to link, so a plain `→ main` pill stands in, with the base branch's name (KERNEL-478). */
  pill?: string
  /** Where the PR stands, beside the link: its word, icon and the header band's tone (KERNEL-274). The icon never spins. */
  state: { label: string; tone: PrTone; glyph: PrGlyph }
  /** The main button. `busy` shows a spinner and is disabled, whoever started what runs (KERNEL-417). `override` asks first, as Merge anyway does (KERNEL-501). */
  button?: { label: string; kind: 'primary' | 'secondary' | 'strong' | 'busy'; action?: PrAction; override?: boolean }
  /** Create PR's caret menu (squared right edge on the button). */
  caret: boolean
  merged: boolean
  /** Closed PRs offer Archive next to Reopen. */
  archive: boolean
}

/** The header band: grey while nothing needs doing, green when it can merge, red when something needs fixing, violet once merged. */
export type PrTone = 'idle' | 'ready' | 'fail' | 'merged'

/** A PR button's action: the same names main announces while one runs (`PrPending`, KERNEL-520). */
export type PrAction = PrPending

/** The icons a PR state is drawn with, in the band and in a Team update row. */
export type PrGlyph = 'branch' | 'pr' | 'prReady' | 'prDraft' | 'prCifail' | 'prChanges' | 'prConflict' | 'prClosed' | 'merged'

/** An open PR's state in its word, icon and the band's tone. `spin` means something runs: every place draws a spinner with the word, in place of the icon. */
export interface PrStatus { label: string; tone: PrTone; glyph: PrGlyph; spin: boolean }

/**
 * The states of an open PR that can't merge yet, or is merging, as every place showing the PR says them: the PR band, the PRs
 * tab, a Team update row and the sidebar icon (KERNEL-417). One table, so no place can say it another way.
 */
export const PR_STATUS = {
  creating: { label: 'Creating PR', tone: 'idle', glyph: 'pr', spin: true },
  checks: { label: 'Checks running', tone: 'idle', glyph: 'pr', spin: true },
  resolving: { label: 'Resolving', tone: 'fail', glyph: 'prConflict', spin: true },
  merging: { label: 'Merging', tone: 'ready', glyph: 'pr', spin: true },
  conflict: { label: 'Merge conflicts', tone: 'fail', glyph: 'prConflict', spin: false },
  cifail: { label: 'Checks failed', tone: 'fail', glyph: 'prCifail', spin: false },
  changes: { label: 'Changes requested', tone: 'fail', glyph: 'prChanges', spin: false },
  draft: { label: 'Draft', tone: 'idle', glyph: 'prDraft', spin: false }
} as const satisfies Partial<Record<PrState, PrStatus>>

/** The state's entry in `PR_STATUS`, or nothing for a state without one (none, ready, open, merged, closed). */
export const prStatus = (state: PrState): PrStatus | undefined => (PR_STATUS as Partial<Record<PrState, PrStatus>>)[state]

/** A PR GitHub calls open whose latest commit has blockers: never ready, in the band's red, in every place showing it (KERNEL-501). */
export const BLOCKERS_STATUS: PrStatus = { label: 'Blockers found', tone: 'fail', glyph: 'prChanges', spin: false }

/**
 * The reviewer's name and how many blockers they found, when blockers on the PR's latest commit are all that holds the merge, so
 * a person can still merge it on purpose with Merge anyway (KERNEL-501). Nothing for a PR that can merge, or one something else
 * holds back, such as failing checks or a conflict, which Merge anyway doesn't skip. Same rule as every Merge button (`mergeBlock`).
 */
export function blockersHold(ws: Workspace, pr: PrInfo | null | undefined, rules: Rules, name: (agentId: string) => string): { reviewer: string; count: number } | undefined {
  const found = headBlockers({ ...ws, prHead: pr?.head ?? ws.prHead })
  if (!found || mergeBlock(ws, pr, rules, name, { override: true })) return undefined
  // Named by kind of review: "Security found 2 blockers" (KERNEL-549).
  return { reviewer: kindsText(found.lenses), count: found.count }
}

export interface BlockerFacts { kinds: ReviewKind[]; count: number; items: { text: string; file?: string; line?: number }[] }

export function blockerFacts(ws: Workspace, pr: PrInfo | null | undefined): BlockerFacts | undefined {
  const at = { ...ws, prHead: pr?.head ?? ws.prHead }
  const found = headBlockers(at)
  if (!found) return undefined
  const { current } = reviewVerdicts(at)
  const items = current.filter((v) => v.verdict === 'blockers' && found.lenses.includes(lensOf(v))).flatMap((v) => v.blockers ?? [])
  return { kinds: found.lenses, count: found.count, items }
}

export function overruleOn(ws: Workspace, pr: PrInfo | null | undefined): Overrule | undefined {
  const at = { ...ws, prHead: pr?.head ?? ws.prHead }
  return ws.overruled && kindStates(at).overruled.length ? ws.overruled : undefined
}

export const overruleText = (o: Overrule) => `Blockers overruled by ${o.by === 'lead' ? 'the Lead' : 'you'}${o.note ? `: ${o.note}` : ''}`

/**
 * How a branch that merges on the Mac stands (KERNEL-478), read from the workspace's state and what git says in `PrInfo.local`.
 * `behind` and `dirty` are two ways a ready branch can't merge cleanly yet: main moved on (grey, nothing failed), or the folder
 * with main checked out has uncommitted changes, which Kernel never touches (red).
 */
export type LocalStand = 'none' | 'ready' | 'behind' | 'dirty' | 'conflict' | 'resolving' | 'merging' | 'merged'

/** Where a branch merging on the Mac stands. Without a read yet, a ready branch reads ready. */
export function localStand(state: PrState, info?: Pick<PrInfo, 'local'>): LocalStand {
  switch (state) {
    case 'merged': return 'merged'
    case 'merging': return 'merging'
    case 'resolving': return 'resolving'
    case 'conflict': return 'conflict'
    case 'ready': case 'open': {
      const local = info?.local
      if (local?.checkout?.dirty.length) return 'dirty'
      return local && local.behind > 0 ? 'behind' : 'ready'
    }
    default: return 'none'
  }
}

/**
 * A local merge's word and tone in every place it shows: the band, the sidebar icon, the chat row's glyph. Merge conflicts,
 * Resolving and Merging are `PR_STATUS`'s own entries, so a branch on the Mac reads like a PR on GitHub (KERNEL-417). `base` is the
 * branch it merges into. `changed` is whether the workspace has files changed, for a branch with nothing committed yet.
 */
export function localStatus(stand: LocalStand, base: string, changed = true): PrStatus {
  switch (stand) {
    case 'ready': return { label: 'Ready to merge', tone: 'ready', glyph: 'branch', spin: false }
    case 'behind': return { label: `Behind ${base}`, tone: 'idle', glyph: 'branch', spin: false }
    case 'dirty': return { label: "Can't merge", tone: 'fail', glyph: 'branch', spin: false }
    case 'conflict': return PR_STATUS.conflict
    case 'resolving': return PR_STATUS.resolving
    // Merging keeps the green band and its word, as a PR does.
    case 'merging': return { ...PR_STATUS.merging, label: 'Ready to merge', glyph: 'branch' }
    case 'merged': return { label: 'Merged', tone: 'merged', glyph: 'merged', spin: false }
    case 'none': return { label: changed ? 'Not committed yet' : 'No changes yet', tone: 'idle', glyph: 'branch', spin: false }
  }
}

/** The project's merge method, as the merge line says it at the right. */
export const METHOD_WORD: Record<AppSettings['pr']['mergeMethod'], string> = { squash: 'Squash merge', merge: 'Merge commit', rebase: 'Rebase' }

/** The merge line and the chat row's wording for how a merge landed. Shared with the PR toast. */
export const LANDED: Record<AppSettings['pr']['mergeMethod'], string> = { squash: 'Squashed into', merge: 'Merged into', rebase: 'Rebased onto' }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The folder as a person reads it: `~/Projects/shop`, as Settings writes a path. */
export const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/**
 * The note under the merge line for a state that needs one, with the files it lists: Behind says how far, Merge conflicts names the
 * files and the action, and a refused merge says what is wrong, that nothing merged, and the fix. `who` is the agent Resolve conflicts asks.
 */
export interface LocalNote { title: string; body: (string | { code: string })[]; files: { letter: string; path: string; why?: string }[] }
export function localNote(stand: LocalStand, base: string, info: Pick<PrInfo, 'local' | 'conflicts'> | undefined, who = 'the agent'): LocalNote | undefined {
  switch (stand) {
    case 'behind': {
      const n = info?.local?.behind ?? 0
      return { title: `${base} has ${plural(n, 'new commit')}`, body: ["This branch doesn't have them yet. Update the branch, then merge."], files: [] }
    }
    case 'conflict': {
      const files = info?.conflicts ?? []
      return { title: `Merging into ${base} would conflict in ${plural(files.length, 'file')}`, body: [`Resolve conflicts asks ${who} to fix them on this branch.`], files: files.map((path) => ({ letter: 'C', path, why: 'both changed' })) }
    }
    case 'dirty': {
      const checkout = info?.local?.checkout
      const dirty = checkout?.dirty ?? []
      return {
        title: `Your ${base} checkout has uncommitted changes`,
        body: [`Kernel only moves ${base} when `, ...(checkout ? [{ code: tilde(checkout.path) }, ' is clean'] : ['it is clean']), ', so nothing was merged. Commit or stash these files there, then try again.'],
        files: dirty.map((f) => ({ letter: f.status === '??' ? 'U' : f.status, path: f.path }))
      }
    }
    default: return undefined
  }
}

/**
 * The row that ends the transcript, in the same words as the PR rows: what the branch can do and why not. A merged branch has the
 * engine's own note, "Squashed into main as 4e1b9c2.", and a branch that is working has no row.
 */
export function localRow(stand: LocalStand, base: string, info: Pick<PrInfo, 'local' | 'conflicts'> | undefined): string | undefined {
  const local = info?.local
  switch (stand) {
    case 'ready': case 'merging': return `Ready to merge into ${base}. ${local?.ahead ?? 0} ahead, no conflicts.`
    case 'behind': return `${base} has ${plural(local?.behind ?? 0, 'new commit')}. Update this branch before it merges.`
    case 'conflict': return `Merging into ${base} would conflict in ${plural(info?.conflicts.length ?? 0, 'file')}.`
    case 'dirty': return `Merge refused. ${local?.checkout ? tilde(local.checkout.path) : `The ${base} checkout`} has uncommitted changes.`
    default: return undefined
  }
}

/** Kernel saves a workspace's file count whenever it reads the changes. No files, or no count yet, means nothing to put in a PR. */
export const hasChanges = (ws: Workspace) => (ws.stat?.files ?? 0) > 0

/**
 * `changed` is false when the workspace has nothing to put in a PR, which hides Create PR and its menu. Merge PR shows in
 * exactly the states `mergeBlock` lets through, so the header and every other Merge button agree (KERNEL-349). `blocked`
 * is a ready PR GitHub won't merge yet, which reads Open as PrOpen.png draws it; Merge PR then says why (KERNEL-388). `held` is
 * a PR whose only block is blockers on its latest commit: the band reads red, and a soft Merge anyway asks first (KERNEL-501).
 * `pending` is the action main runs on the PR, from whichever button or tool started it: the band keeps its state and its button
 * spins in the action's word, as the pressed button's own does, so nothing is left to press or to answer to a key (KERNEL-520).
 * A merged PR keeps Continue and Archive, since its merge is done and the pending clears a moment later.
 */
export function headerView(state: PrState, changed = true, blocked = false, local?: { base: string; stand: LocalStand }, held = false, pending?: PrAction): PrHeaderView {
  const view = stateView(state, changed, blocked, local, held)
  if (!pending || view.merged) return view
  return { ...view, caret: false, archive: false, button: { label: busyLabel[pending], kind: 'busy' } }
}

function stateView(state: PrState, changed: boolean, blocked: boolean, local: { base: string; stand: LocalStand } | undefined, held: boolean): PrHeaderView {
  if (local) return localHeaderView(local.stand, local.base, changed)
  const base = { link: true, caret: false, merged: false, archive: false }
  const noPr = { label: 'No PR yet', tone: 'idle', glyph: 'branch' } as const
  const conflicts = { label: PR_STATUS.conflict.label, tone: 'fail', glyph: PR_STATUS.conflict.glyph } as const
  const mergeable = { label: 'Ready to merge', tone: 'ready', glyph: 'prReady' } as const
  // What runs spins in its own word, as every other place showing the PR draws it (KERNEL-417).
  const running = (s: 'creating' | 'checks' | 'resolving' | 'merging') => ({ label: PR_STATUS[s].label, kind: 'busy' }) as const
  if (mergeableState(state)) {
    if (held) return { ...base, state: { label: BLOCKERS_STATUS.label, tone: BLOCKERS_STATUS.tone, glyph: BLOCKERS_STATUS.glyph }, button: { label: 'Merge anyway', kind: 'secondary', action: 'merge', override: true } }
    return { ...base, state: state === 'ready' && !blocked ? mergeable : { label: 'Open', tone: 'ready', glyph: 'pr' }, button: { label: 'Merge PR', kind: 'primary', action: 'merge' } }
  }
  switch (state) {
    case 'none':
      if (!changed) return { ...base, link: false, state: { label: 'No changes yet', tone: 'idle', glyph: 'branch' } }
      return { ...base, link: false, state: noPr, caret: true, button: { label: 'Create PR', kind: 'primary', action: 'create' } }
    case 'creating': return { ...base, link: false, state: noPr, button: running('creating') }
    case 'checks': return { ...base, state: { label: 'Open', tone: 'idle', glyph: 'pr' }, button: running('checks') }
    case 'conflict': return { ...base, state: conflicts, button: { label: 'Resolve conflicts', kind: 'strong', action: 'resolve' } }
    case 'resolving': return { ...base, state: conflicts, button: running('resolving') }
    case 'merging': return { ...base, state: mergeable, button: running('merging') }
    case 'merged': return { ...base, state: { label: 'Merged', tone: 'merged', glyph: 'merged' }, merged: true }
    case 'draft': return { ...base, state: { label: PR_STATUS.draft.label, tone: 'idle', glyph: PR_STATUS.draft.glyph }, button: { label: 'Ready for review', kind: 'secondary', action: 'ready' } }
    case 'cifail': return { ...base, state: { label: PR_STATUS.cifail.label, tone: 'fail', glyph: PR_STATUS.cifail.glyph }, button: { label: 'Fix checks', kind: 'primary', action: 'resolve' } }
    case 'changes': return { ...base, state: { label: PR_STATUS.changes.label, tone: 'fail', glyph: PR_STATUS.changes.glyph }, button: { label: 'Address review', kind: 'primary', action: 'resolve' } }
    case 'closed': return { ...base, state: { label: 'Closed', tone: 'idle', glyph: 'prClosed' }, button: { label: 'Reopen', kind: 'secondary', action: 'reopen' }, archive: true }
  }
}

/**
 * A branch that merges on the Mac, in the header's own layout: the `→ main` pill where the PR number was, the state's word and
 * the band's button. There is no Create PR, because the branch is what merges (KERNEL-441). Behind main is grey with a soft Update
 * branch, not Merge, so the user never merges onto a base the branch hasn't seen. A refused merge takes a soft Try again.
 */
function localHeaderView(stand: LocalStand, base: string, changed: boolean): PrHeaderView {
  const status = localStatus(stand, base, changed)
  const view = { link: false, pill: base, caret: false, merged: false, archive: false, state: { label: status.label, tone: status.tone, glyph: stand === 'merged' ? 'merged' : 'branch' } } as const
  switch (stand) {
    case 'ready': return { ...view, button: { label: 'Merge', kind: 'primary', action: 'merge' } }
    case 'behind': return { ...view, button: { label: 'Update branch', kind: 'secondary', action: 'update' } }
    case 'dirty': return { ...view, button: { label: 'Try again', kind: 'secondary', action: 'merge' } }
    case 'conflict': return { ...view, button: { label: 'Resolve conflicts', kind: 'strong', action: 'resolve' } }
    case 'resolving': return { ...view, button: { label: PR_STATUS.resolving.label, kind: 'busy' } }
    case 'merging': return { ...view, button: { label: PR_STATUS.merging.label, kind: 'busy' } }
    case 'merged': return { ...view, merged: true }
    case 'none': return view
  }
}

/** The spinner label while an action runs, in the button that pressed it and in every place showing the PR (KERNEL-520). */
export const busyLabel: Record<PrAction, string> = { create: 'Creating PR', resolve: 'Sending', merge: 'Merging', ready: 'Marking ready', reopen: 'Reopening', update: 'Sending' }
/** The toast title when an action's call fails. */
export const failTitle: Record<PrAction, string> = { create: 'Could not create the PR', resolve: 'Could not send to the agent', merge: 'Could not merge', ready: 'Could not mark it ready', reopen: 'Could not reopen', update: 'Could not send to the agent' }
/** The letter that runs an action with ⌘⇧ while its button shows (KERNEL-341). Reopen has none. */
export const actionKey: Partial<Record<PrAction, string>> = { create: 'p', ready: 'p', merge: 'm', resolve: 'f' }

/** The PR instruction files Kernel sends (create, resolve conflicts, fix checks, address review). They show as a "sent" card. */
export const PR_FILES = ['create-pr.md', 'resolve-conflicts.md', 'fix-checks.md', 'address-review.md']

/** A user message that is only a PR instruction file, drawn as the "create-pr.md sent" card. */
export function instructionOf(item: ChatItem): Extract<ChatPart, { type: 'file' }> | undefined {
  if (item.kind !== 'user' || item.parts.length !== 1) return undefined
  const p = item.parts[0]
  return p.type === 'file' && p.text !== undefined && PR_FILES.includes(p.name) ? p : undefined
}

/** "table.tsx:42" for a review comment, or "review" for a review's own text. */
export const commentPlace = (c: ReviewComment) => (c.path ? `${c.path.split('/').pop()}${c.line ? `:${c.line}` : ''}` : 'review')

/** The meta of a comment from someone outside the repo, which Address review leaves out (KERNEL-222). */
export const OUTSIDE_THE_REPO = 'outside the repo'

/** The rows of the review card's code block, places padded so the comments line up. A comment from outside the repo says so. */
export function reviewLines(comments: ReviewComment[]): string[] {
  const width = Math.max(0, ...comments.map((c) => commentPlace(c).length)) + 3
  return comments.map((c) => `${commentPlace(c).padEnd(width)}${c.body.replace(/\s+/g, ' ')}${c.association === 'outside' ? ` (${OUTSIDE_THE_REPO})` : ''}`)
}

/** Unresolved review comments, for the "requested changes" card. */
export const openComments = (pr?: PrInfo) => (pr?.comments ?? []).filter((c) => !c.resolved)

/**
 * The toast a PR state change earns: created, merged, or a create that ended without a PR. Failed calls toast where they are made.
 * `before` is undefined the first time a workspace is seen, which never toasts.
 */
export function prToast(before: PrState | undefined, ws: Workspace, o: { method?: AppSettings['pr']['mergeMethod']; agent?: string; remote?: string } = {}): Omit<Toast, 'id'> | undefined {
  if (!before || before === ws.prState) return undefined
  const n = ws.prNumber ? `PR #${ws.prNumber}` : 'PR'
  const view = ws.prUrl ? { action: { label: 'View', href: ws.prUrl } } : {}
  const base = stripRemote(ws.baseRef, o.remote ?? 'origin')
  if (before === 'creating' && ws.prState === 'none') return { title: 'Could not create the PR', sub: `${o.agent ?? 'The agent'} finished without opening one.` }
  if (before === 'creating') return { title: `${n} created`, sub: ws.prState === 'draft' ? 'Opened as a draft' : ws.prTitle || undefined, ...view }
  if (ws.prState === 'merged') return { title: `${n} merged`, sub: before === 'merging' && o.method ? `${LANDED[o.method]} ${base}` : 'Merged on GitHub', ...view }
  return undefined
}

/**
 * The toast for a workspace Kernel archived on its own while it was on screen (KERNEL-132, KERNEL-114): one whose PR merged, or a review
 * whose work merged or closed. The screen has already gone to the project's front door (KERNEL-596), so the toast says what happened. An archive
 * by hand has none (KERNEL-495), and neither has any other archive. `agent` is the workspace's agent and `reviewed` the work a review
 * looked at.
 */
export function archiveToast(ws: Workspace, reviewed: Workspace | undefined, agent: string | undefined): { title: string; sub: string } | undefined {
  const whose = agent ? `${agent}'s` : 'the'
  if (!ws.reviewOf) {
    if (ws.prState !== 'merged') return undefined
    return { title: `Archived ${whose} workspace${ws.prNumber ? ` after PR #${ws.prNumber} merged` : ''}`, sub: 'Restore it from History.' }
  }
  if (!reviewed || (reviewed.prState !== 'merged' && reviewed.prState !== 'closed')) return undefined
  const after = reviewed.prNumber ? ` after PR #${reviewed.prNumber} ${reviewed.prState === 'merged' ? 'merged' : 'was closed'}` : ''
  return { title: `Archived ${whose} review${after}`, sub: 'Restore it from History.' }
}

/**
 * A PR's title as the Team update and the PRs tab both show it (KERNEL-411): the workspace's own title, else the PR's without
 * a Conventional Commits prefix ("feat(workspace): ") or the issue key it ends on (" (KERNEL-395)"), which the row shows apart.
 */
export function prDisplayTitle(ws: Pick<Workspace, 'title' | 'prTitle' | 'name'>): string {
  if (ws.title) return ws.title
  if (!ws.prTitle) return ws.name
  const plain = ws.prTitle.replace(/^[a-z]+(\([^)]*\))?!?:\s+/i, '').replace(/\s+\([A-Z][A-Z0-9]+-\d+\)$/, '').trim()
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : ws.prTitle
}

/**
 * The icon that leads a PR action's button (KERNEL-528). The label picks it first, since Fix checks, Address
 * review and Resolve conflicts share one action. A label it doesn't know falls back to the action's icon, and to none.
 */
export function actionIcon(label: string, action?: PrAction): 'pr' | 'merged' | 'branch' | 'check' | 'refresh' | 'comment' | undefined {
  const byLabel: Record<string, ReturnType<typeof actionIcon>> = { 'Fix checks': 'refresh', 'Address review': 'comment', 'Resolve conflicts': 'branch', 'Update branch': 'refresh', 'Try again': 'refresh' }
  if (label in byLabel) return byLabel[label]
  const byAction: Partial<Record<PrAction, ReturnType<typeof actionIcon>>> = { create: 'pr', merge: 'merged', ready: 'check', reopen: 'pr', update: 'refresh', resolve: 'branch' }
  return action && byAction[action]
}
