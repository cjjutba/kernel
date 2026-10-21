import type { MergeMethod, PrInfo, ReviewVerdict, Workspace } from '@shared/types'
import { headBlockers, kindStates, mergeBlock, mergeableState, reviewVerdicts } from '@shared/merge'
import type { IconName } from '../../../icons'
import type { Stage } from '../sessionStages'
import { busyLabel, hasChanges, overruleOn, openComments, type LocalStand, type PrAction, type Rules } from './model'

/**
 * The Session rail's Review stage (Pen 10.9): every state of a pull request, or of a branch that merges on the Mac, as one stage with a line that says where the work
 * stands and one or two buttons. This is pure: the rail draws what it returns, and the title bar reads its `title` when the rail is hidden. Every word comes from what
 * the workspace and its pull request record, never from a timer.
 */

/** What a stage's button does. The rail maps each id to the call it makes. */
export type PrButtonId = 'create' | 'ready' | 'fix' | 'review' | 'blockers' | 'anyway' | 'merge' | 'open' | 'resolve' | 'reopen' | 'update' | 'commit' | 'archive' | 'continue'

/** `ink` is the one white button of a stage, `merge` the green Merge and `outline` a quiet one. `menu` opens the menu beside it. `busy` is the work it started, in its word. */
export interface PrButton {
  id: PrButtonId
  label: string
  tone: 'ink' | 'merge' | 'outline'
  icon?: IconName
  menu?: 'create' | 'open'
  busy?: string
  /** Why it can't be pressed. It is shown but off, with the reason as its tooltip. */
  disabled?: string
  /** The tooltip of a button that needs a word of explanation. */
  tip?: string
}

/** What the title bar says while the rail is hidden: an icon, a few words and the one action that matters now. */
export interface PrTitle {
  words: string
  glyph: 'branch' | 'pr' | 'prReady' | 'prDraft' | 'prCifail' | 'prChanges' | 'prConflict' | 'prClosed' | 'merged' | 'close'
  tone: 'idle' | 'ready' | 'fail' | 'merged'
  /** Something runs: the loader stands where the icon is. */
  spin?: boolean
  button?: PrButton
}

/** What the stages need beyond the workspace. The rail and the title bar read them from the store with `usePrFacts`. */
export interface PrFacts {
  pr?: PrInfo | null
  rules: Rules
  /** An agent's name by id. */
  name: (agentId: string) => string
  /** The workspace's own agent, who fixes what is found. */
  agent: string
  /** The project's reviewer, for "Theo reviews the PR" before there is a review. */
  reviewer?: string
  /** A branch that merges on the Mac: how it stands and the branch it merges into. */
  local?: { stand: LocalStand; base: string }
  /** The action main runs on the pull request now, whoever started it. */
  pending?: PrAction
  method: MergeMethod
  /** The branch the pull request merges into, as a person says it: `main`. */
  base: string
}

/** The model that reviewed it, as a person says it. */
const PROVIDER_WORD = { claude: 'Claude', codex: 'Codex' } as const

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Squashed into", "Merged into", "Rebased onto" in lowercase for a sentence after the number. */
const LANDED: Record<MergeMethod, string> = { squash: 'squashed into', merge: 'merged into', rebase: 'rebased onto' }
/** The merge while it runs: "Squashing" and the number, then "into main". */
const LANDING: Record<MergeMethod, (n: string, base: string) => string> = { squash: (n, b) => `Squashing ${n} into ${b}`, merge: (n, b) => `Merging ${n} into ${b}`, rebase: (n, b) => `Rebasing ${n} onto ${b}` }

/** The button a running action leaves in place of the others: it spins, says its word and can't be pressed again. */
const BUSY_ID: Record<PrAction, PrButtonId> = { create: 'create', resolve: 'resolve', merge: 'merge', ready: 'ready', reopen: 'reopen', update: 'update' }
const BUSY_WORD: Record<PrAction, string> = { ...busyLabel, create: 'Creating' }
const busyButton = (a: PrAction): PrButton => ({ id: BUSY_ID[a], label: BUSY_WORD[a], tone: a === 'merge' ? 'merge' : 'ink', busy: BUSY_WORD[a] })

const OPEN_PR: PrButton = { id: 'open', label: 'Open PR', tone: 'outline', icon: 'ext', menu: 'open' }

/** The newest approving verdict on the PR's head commit, whoever gave it. */
function approval(ws: Workspace, pr: PrInfo | null | undefined): ReviewVerdict | undefined {
  const { current } = reviewVerdicts({ ...ws, prHead: pr?.head ?? ws.prHead })
  const kinds = kindStates({ ...ws, prHead: pr?.head ?? ws.prHead })
  if (!kinds.approved.length) return undefined
  return current.filter((v) => v.verdict === 'approved').reduce<ReviewVerdict | undefined>((a, b) => (!a || b.ts > a.ts ? b : a), undefined)
}

/** The first sentence of a reason, which is what the rail has room for. */
const firstSentence = (reason: string) => reason.split(/(?<=\.)\s/)[0].replace(/\.$/, '')

/** The merge as the stage says it once it is done: the review's clock and the merge's. */
function mergedStages(ws: Workspace, f: PrFacts): Stage[] {
  const n = ws.prNumber ? `#${ws.prNumber}` : 'The pull request'
  const ok = approval(ws, f.pr)
  const checks = f.pr?.checks ?? []
  const passed = checks.filter((c) => c.state === 'pass').length
  const who = ok ? f.name(ok.agentId) : undefined
  const reviewSub = f.local
    ? (who ? `${who} approved the branch` : 'Merged without review')
    : who ? `${who} approved${passed ? `, ${plural(passed, 'check')} passed` : ''}` : 'Merged without review'
  const landed = f.local ? `Merged into ${f.base} on this Mac` : `${n} ${LANDED[f.method]} ${f.base}`
  const stages: Stage[] = [
    { id: 'review', label: 'Reviewed', mark: 'done', sub: reviewSub, ...(ok ? { at: ok.ts } : {}) },
    { id: 'merged', label: 'Merged', mark: 'merged', sub: landed, ...(ws.mergedAt ? { at: ws.mergedAt } : {}) }
  ]
  // The branch and its port are freed by Archive, and Continue starts the next change on a new branch.
  stages.push({
    id: 'archive', label: 'Archive', mark: 'current',
    sub: `Frees the branch${ws.port ? ` and port ${ws.port}` : ''}. The chat stays searchable.`,
    buttons: [
      { id: 'archive', label: 'Archive', tone: 'outline', icon: 'archive' },
      { id: 'continue', label: 'Continue', tone: 'outline', icon: 'forward', tip: 'The next change starts a new branch from main.' }
    ]
  })
  return stages
}

const PENDING_MERGED: Stage = { id: 'merged', label: 'Merged', mark: 'pending' }

/** What the title bar says for a stage built here. */
const title = (words: string, glyph: PrTitle['glyph'], tone: PrTitle['tone'], button?: PrButton, spin?: boolean): PrTitle => ({ words, glyph, tone, ...(button ? { button } : {}), ...(spin ? { spin } : {}) })

/** One stage of the Review slot, and what the title bar says for it. */
interface Slot { stage: Stage; title: PrTitle }

/** The Review stage of a pull request on GitHub. */
function githubSlot(ws: Workspace, f: PrFacts): Slot {
  const n = ws.prNumber ? `#${ws.prNumber}` : 'The pull request'
  const pr = f.pr
  const pending = f.pending
  const review = (s: Partial<Stage>): Stage => ({ id: 'review', label: 'Review', mark: 'current', ...s })
  const checks = pr?.checks ?? []
  switch (ws.prState) {
    case 'none': {
      if (pending === 'create') return { stage: review({ mark: 'busy', sub: 'Creating the pull request', buttons: [busyButton('create')] }), title: title('Creating PR', 'pr', 'idle', busyButton('create'), true) }
      if (!hasChanges(ws)) return { stage: review({ mark: 'pending', sub: 'No changes on this branch yet' }), title: title('No changes yet', 'branch', 'idle') }
      const create: PrButton = { id: 'create', label: 'Create PR', tone: 'ink', icon: 'pr', menu: 'create' }
      return { stage: review({ sub: 'No pull request yet', buttons: [create] }), title: title('No pull request yet', 'branch', 'idle', create) }
    }
    case 'creating': return { stage: review({ mark: 'busy', sub: 'Creating the pull request', buttons: [busyButton('create')] }), title: title('Creating PR', 'pr', 'idle', busyButton('create'), true) }
    case 'draft': {
      const ready: PrButton = { id: 'ready', label: 'Ready for review', tone: 'ink' }
      return { stage: review({ sub: `${n} is a draft`, buttons: pending === 'ready' ? [busyButton('ready')] : [ready, OPEN_PR] }), title: title('Draft', 'prDraft', 'idle', pending === 'ready' ? busyButton('ready') : ready) }
    }
    case 'checks': {
      const done = checks.filter((c) => c.state !== 'running' && c.state !== 'queued').length
      return { stage: review({ sub: checks.length ? `${n} is open. ${done} of ${checks.length} checks done` : `${n} is open. Checks are running`, loader: 'checker', buttons: [OPEN_PR] }), title: title('Checks running', 'pr', 'idle', undefined, true) }
    }
    case 'cifail': {
      const failed = checks.find((c) => c.state === 'fail' && !c.optional) ?? checks.find((c) => c.state === 'fail')
      const fix: PrButton = { id: 'fix', label: 'Fix checks', tone: 'ink' }
      return { stage: { id: 'review', label: 'Checks failed', mark: 'failed', sub: failed ? `${failed.name} failed on ${n}` : `Checks failed on ${n}`, buttons: pending === 'resolve' ? [busyButton('resolve')] : [fix, OPEN_PR] }, title: title('Checks failed', 'close', 'fail', pending === 'resolve' ? busyButton('resolve') : fix) }
    }
    case 'changes': {
      const open = openComments(pr ?? undefined)
      const who = open[0]?.author ?? f.reviewer ?? 'A reviewer'
      const address: PrButton = { id: 'review', label: 'Address review', tone: 'ink' }
      return { stage: review({ sub: `${who} requested ${open.length ? plural(open.length, 'change') : 'changes'}`, buttons: pending === 'resolve' ? [busyButton('resolve')] : [address, OPEN_PR] }), title: title('Changes requested', 'prChanges', 'fail', pending === 'resolve' ? busyButton('resolve') : address) }
    }
    case 'conflict': {
      const k = pr?.conflicts.length ?? 0
      const resolve: PrButton = { id: 'resolve', label: 'Resolve', tone: 'ink' }
      return { stage: { id: 'review', label: 'Conflicts', mark: 'failed', sub: `Conflicts with ${f.base}${k ? ` in ${plural(k, 'file')}` : ''}`, buttons: pending === 'resolve' ? [busyButton('resolve')] : [resolve] }, title: title('Merge conflicts', 'prConflict', 'fail', pending === 'resolve' ? busyButton('resolve') : resolve) }
    }
    case 'resolving': {
      const k = pr?.conflicts.length ?? 0
      return { stage: review({ mark: 'busy', sub: k ? `${f.agent} is resolving ${plural(k, 'file')}` : `${f.agent} is resolving the conflicts`, loader: 'checker' }), title: title('Resolving', 'prConflict', 'fail', undefined, true) }
    }
    case 'merging': return merging(ws, f, n)
    case 'merged': return { stage: review({ label: 'Reviewed', mark: 'done' }), title: title('Merged', 'merged', 'merged') }
    case 'closed': {
      const reopen: PrButton = { id: 'reopen', label: 'Reopen', tone: 'outline' }
      return { stage: { id: 'review', label: 'Closed', mark: 'closed', sub: `${n} was closed without merging`, buttons: pending === 'reopen' ? [busyButton('reopen')] : [reopen] }, title: title('Closed', 'prClosed', 'idle', pending === 'reopen' ? busyButton('reopen') : reopen) }
    }
    case 'ready': case 'open': break
  }
  if (pending === 'merge') return merging(ws, f, n)
  return mergeable(ws, f, n)
}

/** A merge that runs: the stage keeps its place and the green button says so. */
function merging(ws: Workspace, f: PrFacts, n: string): Slot {
  const merge = busyButton('merge')
  return { stage: { id: 'review', label: 'Review', mark: 'busy', sub: LANDING[f.method](n, f.base), buttons: [merge] }, title: title('Merging', 'prReady', 'ready', merge, true) }
}

/** An open pull request GitHub calls ready: what holds the merge, or the Merge that may go ahead. */
function mergeable(ws: Workspace, f: PrFacts, n: string): Slot {
  const pr = f.pr
  const at = { ...ws, prHead: pr?.head ?? ws.prHead }
  const found = headBlockers(at)
  const mergeNow = mergeBlock(ws, pr, f.rules, f.name, { override: true })
  const overruled = overruleOn(ws, pr)
  const checks = pr?.checks ?? []
  const merge: PrButton = { id: 'merge', label: 'Merge PR', tone: 'merge' }
  // Blockers on the latest commit are all that holds the merge: a person can still go past them on purpose, and the agent can fix them (KERNEL-501).
  if (found && !mergeNow) {
    const anyway: PrButton = { id: 'anyway', label: 'Merge anyway', tone: 'outline' }
    const address: PrButton = { id: 'blockers', label: 'Address blockers', tone: 'ink' }
    return { stage: { id: 'review', label: 'Review', mark: 'current', sub: `${f.name(found.agentId)} found ${plural(found.count, 'blocker')}`, buttons: [address, anyway] }, title: title('Blockers found', 'prChanges', 'fail', anyway) }
  }
  const reason = mergeBlock(ws, pr, f.rules, f.name)
  if (reason) {
    // A required review, GitHub's own approval rule, or checks the project insists on: Merge stays off, and the line says why.
    const github = pr ? pr.blocked : ws.prBlocked
    const reviewOnly = mergeBlock(ws, pr, { ...f.rules, requireReviewer: false }, f.name) === undefined
    const words = github === 'review' ? 'GitHub needs an approval to merge' : github === 'behind' ? `The branch is behind ${f.base}` : github ? "GitHub's branch rules block the merge" : reviewOnly ? `Waiting for ${f.reviewer ?? 'the reviewer'}'s review` : firstSentence(reason)
    return { stage: { id: 'review', label: 'Review', mark: 'wait', sub: words, buttons: [OPEN_PR] }, title: title(reviewOnly && !github ? 'Waiting for review' : 'Waiting', 'pr', 'idle') }
  }
  const optionalFail = checks.find((c) => c.optional && c.state === 'fail')
  const ok = approval(ws, pr)
  const passed = checks.filter((c) => c.state === 'pass').length
  const sub = overruled
    ? `${overruled.by === 'lead' ? 'The Lead' : 'You'} overruled ${plural(found?.count ?? overruledCount(ws, pr), 'blocker')}`
    : optionalFail ? `${optionalFail.name} failed, but it's optional`
      : ok ? (ok.provider ? `${PROVIDER_WORD[ok.provider]} reviewed it: no blockers` : checks.length && passed === checks.length ? 'Approved, and every check passed' : 'Approved')
        : checks.length ? `${n} is open and its ${plural(checks.length, 'check')} passed` : `${n} is open`
  return { stage: { id: 'review', label: 'Review', mark: 'current', sub, buttons: [merge, OPEN_PR] }, title: title('Ready to merge', 'prReady', 'ready', { ...merge, label: 'Merge' }) }
}

/** The blockers an overrule covers, for "You overruled 2 blockers": the latest blocking verdicts on the head commit it names. */
function overruledCount(ws: Workspace, pr: PrInfo | null | undefined): number {
  const { current } = reviewVerdicts({ ...ws, prHead: pr?.head ?? ws.prHead })
  const found = current.filter((v) => v.verdict === 'blockers')
  return found.reduce((n, v) => n + (v.blockers?.length || 1), 0) || 1
}

/** The Review slot of a branch that merges on the Mac (KERNEL-478). Behind main and a main checkout with changes are two ways a ready branch can't merge cleanly yet. */
function localSlot(ws: Workspace, f: PrFacts): Slot {
  const { stand, base } = f.local as NonNullable<PrFacts['local']>
  const info = f.pr
  const git = info?.local
  const pending = f.pending
  const pill = { pill: base }
  const merge: PrButton = { id: 'merge', label: 'Merge', tone: 'merge' }
  const stage = (s: Partial<Stage>): Stage => ({ id: 'review', label: 'Ready to merge', mark: 'current', ...pill, ...s })
  switch (stand) {
    case 'none': {
      const changed = hasChanges(ws)
      return { stage: stage({ mark: 'pending', sub: changed ? 'Commit the work to merge it' : 'No changes on this branch yet' }), title: title(changed ? 'Not committed yet' : 'No changes yet', 'branch', 'idle') }
    }
    case 'behind': {
      const update: PrButton = { id: 'update', label: 'Update branch', tone: 'ink' }
      return { stage: stage({ sub: `${plural(git?.behind ?? 0, 'commit')} behind ${base}`, buttons: pending === 'update' ? [busyButton('update')] : [update] }), title: title(`Behind ${base}`, 'branch', 'idle', pending === 'update' ? busyButton('update') : update) }
    }
    case 'dirty': {
      const files = git?.checkout?.dirty.length ?? 0
      const commit: PrButton = { id: 'commit', label: `Ask ${f.agent} to commit`, tone: 'ink' }
      return { stage: stage({ sub: `${plural(files, 'file')} ${files === 1 ? 'has' : 'have'} uncommitted changes`, buttons: [commit] }), title: title("Can't merge", 'branch', 'fail', commit) }
    }
    case 'conflict': {
      const k = info?.conflicts.length ?? 0
      const resolve: PrButton = { id: 'resolve', label: 'Resolve', tone: 'ink' }
      return { stage: { id: 'review', label: 'Conflicts', mark: 'failed', sub: `Conflicts with ${base}${k ? ` in ${plural(k, 'file')}` : ''}`, buttons: pending === 'resolve' ? [busyButton('resolve')] : [resolve] }, title: title('Merge conflicts', 'prConflict', 'fail', pending === 'resolve' ? busyButton('resolve') : resolve) }
    }
    case 'resolving': {
      const k = info?.conflicts.length ?? 0
      return { stage: { id: 'review', label: 'Conflicts', mark: 'busy', sub: k ? `${f.agent} is resolving ${plural(k, 'file')}` : `${f.agent} is resolving the conflicts`, loader: 'checker' }, title: title('Resolving', 'prConflict', 'fail', undefined, true) }
    }
    case 'merging': return { stage: { id: 'review', label: 'Merging', mark: 'busy', sub: `Merging into ${base} on this Mac`, loader: 'checker' }, title: title('Merging', 'branch', 'ready', undefined, true) }
    case 'merged': return { stage: stage({ label: 'Merged', mark: 'merged' }), title: title('Merged', 'merged', 'merged') }
    case 'ready': {
      const sub = 'No GitHub, so the branch merges on this Mac'
      return { stage: stage({ sub, buttons: pending === 'merge' ? [busyButton('merge')] : [merge] }), title: title('Ready to merge', 'branch', 'ready', pending === 'merge' ? busyButton('merge') : merge) }
    }
  }
}

/** The blockers a local branch's review found, held like a pull request's: the stage reads Review and offers to address them or merge anyway. */
function localHeld(ws: Workspace, f: PrFacts): Slot | undefined {
  if (!f.local || !mergeableState(ws.prState)) return undefined
  const found = headBlockers({ ...ws, prHead: f.pr?.head ?? ws.prHead })
  if (!found || mergeBlock(ws, f.pr, f.rules, f.name, { override: true })) return undefined
  return mergeable(ws, f, 'The branch')
}

/**
 * The stages after Built: Review (its label and line move with the pull request), Merged, and once merged, Archive. `built` is whether the work is far enough along to
 * review. Before it, Review waits as a quiet row that says who reviews, or that there is nothing to review yet when the agent is idle with no changes. The title is the
 * same either way, so the title bar offers Create PR while the agent still works.
 */
export function reviewStages(ws: Workspace, f: PrFacts | undefined, built: boolean, idle = false): { stages: Stage[]; title?: PrTitle } {
  const merged = ws.prState === 'merged'
  if (!f) {
    // Without the facts of a pull request there is a ring and a word, as the rail drew before it read one.
    const hasPr = !!ws.prNumber || (ws.prState !== 'none' && ws.prState !== 'creating')
    if (merged) return { stages: [{ id: 'review', label: 'Reviewed', mark: 'done', sub: ws.prNumber ? `#${ws.prNumber} was reviewed` : 'The pull request was reviewed' }, { id: 'merged', label: 'Merged', mark: 'done', ...(ws.mergedAt ? { at: ws.mergedAt } : {}) }] }
    const review: Stage = hasPr ? { id: 'review', label: 'Review', mark: 'current', sub: ws.prNumber ? `#${ws.prNumber} is ${ws.prState === 'closed' ? 'closed' : 'open'}` : 'The pull request is open' } : { id: 'review', label: 'Reviewed', mark: 'pending', sub: 'A reviewer reads the pull request' }
    return { stages: [review, PENDING_MERGED] }
  }
  if (merged) return { stages: mergedStages(ws, f), title: title('Merged', 'merged', 'merged') }
  const held = f.local ? localHeld(ws, f) : undefined
  const slot = held ?? (f.local ? localSlot(ws, f) : githubSlot(ws, f))
  if (!built) {
    const none = idle && !ws.prNumber && !hasChanges(ws)
    return { stages: [none ? { id: 'review', label: 'Review', mark: 'pending', sub: 'No changes on this branch yet' } : { id: 'review', label: 'Reviewed', mark: 'pending', sub: f.reviewer ? `${f.reviewer} reviews the PR` : 'A reviewer reads the pull request' }, PENDING_MERGED], title: slot.title }
  }
  // A branch whose review approved it reads Reviewed first, then Ready to merge.
  const ok = f.local ? approval(ws, f.pr) : undefined
  const reviewed: Stage[] = ok && !held && f.local && f.local.stand !== 'none' ? [{ id: 'reviewed', label: 'Reviewed', mark: 'done', sub: `${f.name(ok.agentId)} approved the branch`, at: ok.ts }] : []
  return { stages: [...reviewed, slot.stage, PENDING_MERGED], title: slot.title }
}
