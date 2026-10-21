import { useEffect, useMemo, useRef } from 'react'
import type { AgentDef, PrInfo, Workspace } from '@shared/types'
import { headBlockers, mergeBlock, mergeNeedsPr, mergeableState, plannedReviews, reviewVerdicts, verdictPhrase, type ReviewPhrase } from '@shared/merge'
import { isReviewer } from '@shared/team'
import { call } from '../../../api'
import { isLeadWorkspace, leadOf } from '../../../lead'
import { actions, useStore } from '../../../store'
import { workspaceGlyph, type GlyphTone } from '../../../components/sidebar/workspaceGlyph'
import { BLOCKERS_STATUS, NO_RULES, PR_STATUS, blockersHold, busyLabel, overruleOn, prStatus, type PrAction, type PrStatus, type Rules } from './model'

/**
 * The PRs tab's lists, in the order they show (KERNEL-757): what can merge, what needs a person (checks failed, conflicts,
 * changes requested, blockers), and what is still on its way (checks running, a draft, waiting for approval).
 */
export type PrGroup = 'ready' | 'attention' | 'progress'

/** One row of the Lead's PRs tab (KERNEL-354). */
export interface LeadPr {
  ws: Workspace
  /** The agent who owns the workspace. */
  name: string
  /** It can merge, or its merge is running (KERNEL-411). */
  ready: boolean
  /**
   * What a PR that can't merge yet waits on, in the words, tone and spinner every place uses (KERNEL-417), and for one a rule holds
   * back, the rule's reason. Ready PRs have none.
   */
  state?: PrStatus & { why?: string }
  /** Blockers on the latest commit are all that holds it back: who found them (`by` is the agent's name) and how many. It offers Merge anyway, never Merge (KERNEL-501). */
  blockers?: { reviewer: string; count: number; by: string }
  /** The user or the Lead overruled the blockers on the latest commit, so it merges as any other (KERNEL-732). */
  overruled?: { by: 'user' | 'lead'; count: number }
  /** The review of the latest commit is planned and has not run yet: who reviews it, and whether the checks come first. */
  planned?: { reviewer: string; afterChecks: boolean }
  /** Who approved the latest commit, when one reviewer did, for "Approved by Theo". */
  approvedBy?: string
  review: ReviewPhrase
  /** Which list it sits in. */
  group: PrGroup
}

/** A row that waits on nothing goes on its way; one in the fail tone, without anything running, needs a person. */
const GROUPS: PrGroup[] = ['ready', 'attention', 'progress']

const groupOf = (r: Omit<LeadPr, 'group'>): PrGroup => (r.ready ? 'ready' : !r.state?.spin && r.state?.tone === 'fail' ? 'attention' : 'progress')

/** What a PR waits on when only the reviewer rule holds it back (Pen 10.11, LeadPrsStateWords). */
const WAITING = 'Waiting for review'

/** A workspace with a PR that is not merged or closed. Reviews, the Lead's own and archived workspaces never count. */
export const listsPr = (ws: Workspace, leadId: string | undefined) =>
  !ws.reviewOf && ws.status !== 'archived' && !!ws.prNumber && !['none', 'merged', 'closed'].includes(ws.prState) && !isLeadWorkspace(ws, ws.projectId, leadId)

/**
 * "Code approved", "Security found 2 blockers" or "Not reviewed", from the verdicts on the PR's head commit (KERNEL-349), by
 * kind of review (KERNEL-549), in the words the Team update card uses too (`reviewPhrase`, KERNEL-411).
 */
export function reviewLine(ws: Workspace, pr: PrInfo | null | undefined): LeadPr['review'] {
  return verdictPhrase({ ...ws, prHead: pr?.head ?? ws.prHead })
}

/** What "Not reviewed" says on hover when automatic review is off, so Kernel doesn't repeat it in chat for every PR (KERNEL-1000). */
const NOT_REVIEWED_TIP = 'Automatic review is off. Turn it on in Settings, Pull requests.'

/** The tooltip for a review line: "Not reviewed" has one with automatic review off, and on a PR that already merged it says it merged without a review (Pen 10.10, TeamUpdateNotReviewedTip). */
export const notReviewedTip = (text: string, autoReview: boolean | undefined, merged?: boolean): string | undefined =>
  text !== 'Not reviewed' ? undefined : merged ? 'Merged without review. You merged it before the reviewer approved it.' : autoReview === false ? NOT_REVIEWED_TIP : undefined

/**
 * The project's open PRs in the tab's three lists, ready ones first, then what needs a person, then what is on its way, each in
 * the order the workspaces came in (KERNEL-757). Ready is the rule every Merge button uses (`mergeBlock`), so the tab never
 * offers a Merge the header would refuse.
 */
export function leadPrs(workspaces: Workspace[], o: { leadId: string | undefined; projectId: string; prs: Record<string, PrInfo>; rules: Rules; agents: AgentDef[] }): LeadPr[] {
  const name = (id: string) => o.agents.find((a) => a.id === id)?.name ?? id
  const rows = workspaces.filter((w) => w.projectId === o.projectId && listsPr(w, o.leadId)).map((ws): Omit<LeadPr, 'group'> => {
    const pr = o.prs[ws.id]
    const why = mergeBlock(ws, pr, o.rules, name)
    const base = { ws, name: name(ws.agentId), review: reviewLine(ws, pr), ...approvedBy(ws, pr, name) }
    // A PR merging stays where Merge was pressed, with the ready ones, until GitHub says it merged (KERNEL-411).
    if (!why || ws.prState === 'merging') {
      const o2 = !why && mergeableState(ws.prState) ? overruleOn(ws, pr) : undefined
      return { ...base, ready: true, ...(o2 ? { overruled: { by: o2.by, count: blockerCount(ws, pr) } } : {}) }
    }
    const status = prStatus(ws.prState)
    if (status) return { ...base, ready: false, state: status }
    // Blockers on the latest commit keep it from reading ready, though a person can still merge it on purpose (KERNEL-501).
    const blockers = blockersHold(ws, pr, o.rules, name)
    if (blockers) return { ...base, ready: false, state: { ...BLOCKERS_STATUS, why }, blockers: { ...blockers, by: name(headBlockers({ ...ws, prHead: pr?.head ?? ws.prHead })?.agentId ?? ws.agentId) } }
    // A PR GitHub calls open, held back by a rule. Held back by the reviewer rule alone, it waits for the reviewer's approval.
    const approval = mergeBlock(ws, pr, { ...o.rules, requireReviewer: false }, name) === undefined
    const label = approval ? WAITING : workspaceGlyph(ws, { waiting: [], running: false }).label
    return { ...base, ready: false, state: { label, tone: 'idle', glyph: 'pr', spin: false, why } }
  }).map((r): LeadPr => {
    // A PR whose review is planned but hasn't run yet says who reviews it, and that the checks come first while they run.
    const planned = !r.ready && !r.blockers && !r.state?.tone.includes('fail') ? plannedFor(r.ws, o.prs[r.ws.id], o.agents.find(isReviewer)?.name ?? 'the reviewer') : undefined
    return { ...r, ...(planned ? { planned } : {}), group: groupOf(r) }
  })
  return GROUPS.flatMap((g) => rows.filter((r) => r.group === g))
}

/** How many blockers the review found on the head commit, for "You overruled 2 blockers": the kinds' latest verdicts, overruled or not. */
function blockerCount(ws: Workspace, pr: PrInfo | null | undefined): number {
  const n = (ws.reviews ?? []).filter((v) => v.verdict === 'blockers' && (!v.sha || v.sha === (pr?.head ?? ws.prHead))).reduce((sum, v) => sum + (v.blockers?.length || 1), 0)
  return n || 1
}

/** The review Kernel plans for the PR's latest commit, with the reviewer's name, or nothing when none is planned or the PR is past it. */
function plannedFor(ws: Workspace, pr: PrInfo | null | undefined, reviewer: string): { reviewer: string; afterChecks: boolean } | undefined {
  const planned = plannedReviews(ws, pr?.head ?? ws.prHead)
  if (!planned.length && planned !== 'pending') return undefined
  return { reviewer, afterChecks: ws.prState === 'checks' }
}

/** The one agent who approved the latest commit: with two reviewers or more the review line already says which kinds approved. */
function approvedBy(ws: Workspace, pr: PrInfo | null | undefined, name: (id: string) => string): { approvedBy?: string } {
  const { current } = reviewVerdicts({ ...ws, prHead: pr?.head ?? ws.prHead })
  const who = [...new Set(current.filter((v) => v.verdict === 'approved').map((v) => v.agentId))]
  return who.length === 1 ? { approvedBy: name(who[0]) } : {}
}

/** A row's icon (KERNEL-757): the pull request in the sidebar's tones, green to merge, red for a person, or the spinner while something runs. */
export interface RowGlyph { icon: 'pr' | 'prDraft' | 'xCircle' | 'spin'; tone: GlyphTone; label: string }

/**
 * The icon in front of a row. It spins while an action main announced runs on the PR (`pending`, KERNEL-520) and while its state
 * runs, as the sidebar's icon does. A merge spins in the row's Merge place instead, so the row shows one spinner and the icon stays
 * the ready one (KERNEL-417). Its label is the state, for a screen reader.
 */
export function rowGlyph(row: LeadPr, pending?: PrAction): RowGlyph {
  const { ws, state } = row
  if (ws.prState === 'merging' || pending === 'merge') return { icon: 'pr', tone: 'add', label: PR_STATUS.merging.label }
  if (pending) return { icon: 'spin', tone: 'muted', label: busyLabel[pending] }
  if (state?.spin) return { icon: 'spin', tone: 'muted', label: state.label }
  if (row.group === 'ready') return { icon: 'pr', tone: 'add', label: 'Ready to merge' }
  const label = state?.label ?? 'Open'
  // Blockers a person can merge past keep the PR's own mark, since nothing failed. What failed or conflicts takes the red circle (Pen 10.6).
  if (row.group === 'attention') return row.blockers ? { icon: 'pr', tone: 'add', label } : { icon: 'xCircle', tone: 'del', label }
  return { icon: ws.prState === 'draft' ? 'prDraft' : 'pr', tone: 'muted', label }
}

/** The icon in front of a row's state word (KERNEL-897). */
export type RowStateIcon = 'shieldCheck' | 'check' | 'close' | 'alertCircle' | 'info' | 'comment' | 'prDraft' | 'hourglass' | 'spin'

/**
 * What a row's second line says first (KERNEL-757). `good` is an approved review, `fail` something broken, and `idle` all the rest,
 * which stay muted. `icon` is left out for a state with none.
 */
export interface RowState { text: string; tone: 'idle' | 'good' | 'fail'; icon?: RowStateIcon; why?: string }

/**
 * A ready row says its review, since its list already says it can merge: green with a shield when security approved too, green with a
 * check for code alone. Any other row says what it waits on, in the words and tone every place uses (KERNEL-417), with the rule's
 * reason as its tooltip. Only approved and failing rows take a color (KERNEL-897).
 */
export function rowState(row: LeadPr): RowState {
  if (row.ready || !row.state) {
    // A merge a person went past the blockers for says so, since the review line would only say "Blockers overruled".
    if (row.overruled) return { text: `${row.overruled.by === 'lead' ? 'The Lead' : 'You'} overruled ${row.overruled.count} ${row.overruled.count === 1 ? 'blocker' : 'blockers'}`, tone: 'idle', icon: 'info' }
    const { text, tone, approved } = row.review
    if (tone !== 'good') return { text, tone: 'idle' }
    // One reviewer's approval of the code reads "Approved by Theo". More than one kind keeps the kinds' words (Pen 10.6).
    const plain = approved?.length === 1 && approved[0] === 'code' && row.approvedBy
    return { text: plain ? `Approved by ${row.approvedBy}` : text, tone: 'good', icon: approved?.includes('security') ? 'shieldCheck' : 'check' }
  }
  const { label, tone, spin, why } = row.state
  const extra = why ? { why } : {}
  // A review planned for the latest commit says who reviews it, and that the checks come first while they run.
  if (row.planned) return { text: `Review planned: ${row.planned.reviewer}${row.planned.afterChecks ? ', after checks' : ''}`, tone: 'idle', icon: 'hourglass', ...extra }
  if (spin) return { text: label, tone: 'idle', icon: 'spin', ...extra }
  // What a person can still merge past says who found how many and takes the quiet info mark: nothing failed (Pen 10.11, LeadPrsBlockers).
  if (row.blockers) return { text: `${row.blockers.count} ${row.blockers.count === 1 ? 'blocker' : 'blockers'} from ${row.blockers.by}`, tone: 'idle', icon: 'info', ...extra }
  const ws = row.ws
  // Changes a reviewer asked for need a person but didn't fail anything, so the word stays quiet with a comment mark (Pen 10.11, LeadPrsStateWords).
  if (ws.prState === 'changes') return { text: label, tone: 'idle', icon: 'comment', ...extra }
  if (tone === 'fail') return { text: label, tone: 'fail', icon: ws.prState === 'conflict' ? 'alertCircle' : 'close', ...extra }
  if (ws.prState === 'draft') return { text: label, tone: 'idle', icon: 'prDraft', ...extra }
  return { text: label, tone: 'idle', ...(label === WAITING ? { icon: 'hourglass' as const } : {}), ...extra }
}

const NO_AGENTS: AgentDef[] = []

/**
 * The Lead's PRs for the project, redrawn when a workspace, a PR read, a rule or an agent changes. The rule may need a PR GitHub
 * hasn't been asked about yet, so each such PR is read once: until then it would count as blocked and never show Merge.
 */
export function useLeadPrs(projectId: string): LeadPr[] {
  const workspaces = useStore((s) => s.workspaces)
  const prs = useStore((s) => s.prs)
  const agents = useStore((s) => s.agents[projectId]) ?? NO_AGENTS
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const leadId = useStore((s) => leadOf(s.agents, projectId)?.id)
  const rows = useMemo(() => leadPrs(workspaces, { leadId, projectId, prs, rules, agents }), [workspaces, leadId, projectId, prs, rules, agents])
  const asked = useRef(new Set<string>())
  useEffect(() => {
    for (const { ws } of rows) {
      if (prs[ws.id] || asked.current.has(ws.id) || !mergeableState(ws.prState) || !mergeNeedsPr(ws, rules)) continue
      asked.current.add(ws.id)
      call('pr.get', { workspaceId: ws.id }).then((info) => { if (info) actions.prs.set(info) }).catch(() => undefined)
    }
  }, [rows, prs, rules])
  return rows
}
