import { useEffect, useMemo, useRef } from 'react'
import type { AgentDef, PrInfo, Workspace } from '@shared/types'
import { mergeBlock, mergeNeedsPr, mergeableState, verdictPhrase } from '@shared/merge'
import { call } from '../../../api'
import { isLeadWorkspace, leadOf } from '../../../lead'
import { actions, useStore } from '../../../store'
import { workspaceGlyph, type GlyphTone } from '../../../components/sidebar/workspaceGlyph'
import { BLOCKERS_STATUS, NO_RULES, PR_STATUS, blockersHold, busyLabel, prStatus, type PrAction, type PrStatus, type Rules } from './model'

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
  /** Blockers on the latest commit are all that holds it back: who found them and how many. It offers Merge anyway, never Merge (KERNEL-501). */
  blockers?: { reviewer: string; count: number }
  review: { text: string; tone: 'good' | 'bad' | 'faint' }
  /** Which list it sits in. */
  group: PrGroup
}

/** A row that waits on nothing goes on its way; one in the fail tone, without anything running, needs a person. */
const GROUPS: PrGroup[] = ['ready', 'attention', 'progress']

const groupOf = (r: Omit<LeadPr, 'group'>): PrGroup => (r.ready ? 'ready' : !r.state?.spin && r.state?.tone === 'fail' ? 'attention' : 'progress')

/** A workspace with a PR that is not merged or closed. Reviews, the Lead's own and archived workspaces never count. */
export const listsPr = (ws: Workspace, leadId: string | undefined) =>
  !ws.reviewOf && ws.status !== 'archived' && !!ws.prNumber && !['none', 'merged', 'closed'].includes(ws.prState) && !isLeadWorkspace(ws, ws.roomId, leadId)

/**
 * "Code approved", "Security found 2 blockers" or "Not reviewed", from the verdicts on the PR's head commit (KERNEL-349), by
 * kind of review (KERNEL-549), in the words the Team update card uses too (`reviewPhrase`, KERNEL-411).
 */
export function reviewLine(ws: Workspace, pr: PrInfo | null | undefined): LeadPr['review'] {
  return verdictPhrase({ ...ws, prHead: pr?.head ?? ws.prHead })
}

/**
 * The room's open PRs in the tab's three lists, ready ones first, then what needs a person, then what is on its way, each in
 * the order the workspaces came in (KERNEL-757). Ready is the rule every Merge button uses (`mergeBlock`), so the tab never
 * offers a Merge the header would refuse.
 */
export function leadPrs(workspaces: Workspace[], o: { leadId: string | undefined; roomId: string; prs: Record<string, PrInfo>; rules: Rules; agents: AgentDef[] }): LeadPr[] {
  const name = (id: string) => o.agents.find((a) => a.id === id)?.name ?? id
  const rows = workspaces.filter((w) => w.roomId === o.roomId && listsPr(w, o.leadId)).map((ws): Omit<LeadPr, 'group'> => {
    const pr = o.prs[ws.id]
    const why = mergeBlock(ws, pr, o.rules, name)
    const base = { ws, name: name(ws.agentId), review: reviewLine(ws, pr) }
    // A PR merging stays where Merge was pressed, with the ready ones, until GitHub says it merged (KERNEL-411).
    if (!why || ws.prState === 'merging') return { ...base, ready: true }
    const status = prStatus(ws.prState)
    if (status) return { ...base, ready: false, state: status }
    // Blockers on the latest commit keep it from reading ready, though a person can still merge it on purpose (KERNEL-501).
    const blockers = blockersHold(ws, pr, o.rules, name)
    if (blockers) return { ...base, ready: false, state: { ...BLOCKERS_STATUS, why }, blockers }
    // A PR GitHub calls open, held back by a rule. Held back by the reviewer rule alone, it waits for the reviewer's approval.
    const approval = mergeBlock(ws, pr, { ...o.rules, requireReviewer: false }, name) === undefined
    const label = approval ? 'Waiting for approval' : workspaceGlyph(ws, { waiting: [], running: false }).label
    return { ...base, ready: false, state: { label, tone: 'idle', glyph: 'pr', spin: false, why } }
  }).map((r): LeadPr => ({ ...r, group: groupOf(r) }))
  return GROUPS.flatMap((g) => rows.filter((r) => r.group === g))
}

/** A row's icon (KERNEL-757): the pull request in the sidebar's tones, green to merge, red for a person, or the spinner while something runs. */
export interface RowGlyph { icon: 'pr' | 'prDraft' | 'spin'; tone: GlyphTone; label: string }

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
  if (row.group === 'attention') return { icon: 'pr', tone: 'del', label }
  return { icon: ws.prState === 'draft' ? 'prDraft' : 'pr', tone: 'muted', label }
}

/** What a row's second line says first (KERNEL-757). */
export interface RowState { text: string; tone: 'idle' | 'fail'; why?: string }

/**
 * A ready row says its review, since its list already says it can merge. Any other row says what it waits on, in the words and
 * tone every place uses (KERNEL-417), with the rule's reason as its tooltip.
 */
export function rowState(row: LeadPr): RowState {
  if (row.ready || !row.state) return { text: row.review.text, tone: 'idle' }
  return { text: row.state.label, tone: row.state.tone === 'fail' ? 'fail' : 'idle', ...(row.state.why ? { why: row.state.why } : {}) }
}

const NO_AGENTS: AgentDef[] = []

/**
 * The Lead's PRs for the room, redrawn when a workspace, a PR read, a rule or an agent changes. The rule may need a PR GitHub
 * hasn't been asked about yet, so each such PR is read once: until then it would count as blocked and never show Merge.
 */
export function useLeadPrs(roomId: string): LeadPr[] {
  const workspaces = useStore((s) => s.workspaces)
  const prs = useStore((s) => s.prs)
  const agents = useStore((s) => s.agents[roomId]) ?? NO_AGENTS
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const leadId = useStore((s) => leadOf(s.agents, roomId)?.id)
  const rows = useMemo(() => leadPrs(workspaces, { leadId, roomId, prs, rules, agents }), [workspaces, leadId, roomId, prs, rules, agents])
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
