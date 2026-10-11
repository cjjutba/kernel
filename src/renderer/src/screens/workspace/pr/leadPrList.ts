import { useEffect, useMemo, useRef } from 'react'
import type { AgentDef, AppSettings, PrInfo, Workspace } from '@shared/types'
import { mergeBlock, mergeNeedsPr, mergeableState, reviewPhrase, reviewVerdicts } from '@shared/merge'
import { call } from '../../../api'
import { isLeadWorkspace, leadOf } from '../../../lead'
import { actions, useStore } from '../../../store'
import { workspaceGlyph } from '../../../components/sidebar/workspaceGlyph'
import { prStatus, type PrStatus } from './model'

type Rules = Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>

/** One row of the Lead's PRs tab (KERNEL-354). */
export interface LeadPr {
  ws: Workspace
  /** The agent who owns the workspace. */
  name: string
  /** The issue the workspace started on, when it started on one. */
  key?: string
  /** It can merge, or its merge is running (KERNEL-411). */
  ready: boolean
  /**
   * What a PR that can't merge yet waits on, in the words, tone and spinner every place uses (KERNEL-417), and for one a rule holds
   * back, the rule's reason. Ready PRs have none.
   */
  state?: PrStatus & { why?: string }
  review: { text: string; tone: 'good' | 'bad' | 'faint' }
}

/** A workspace with a PR that is not merged or closed. Reviews, the Lead's own and archived workspaces never count. */
export const listsPr = (ws: Workspace, leadId: string | undefined) =>
  !ws.reviewOf && ws.status !== 'archived' && !!ws.prNumber && !['none', 'merged', 'closed'].includes(ws.prState) && !isLeadWorkspace(ws, ws.roomId, leadId)

/**
 * "Theo approved", "Theo found 2 blockers" or "Not reviewed", from the verdicts on the PR's head commit (KERNEL-349), in the
 * words the Team update card uses too (`reviewPhrase`, KERNEL-411).
 */
export function reviewLine(ws: Workspace, pr: PrInfo | null | undefined, name: (agentId: string) => string): LeadPr['review'] {
  const { verdicts, current } = reviewVerdicts({ ...ws, prHead: pr?.head ?? ws.prHead })
  if (!verdicts.length) return reviewPhrase({})
  const latest = <T extends { ts: number }>(vs: T[]) => vs.reduce((a, b) => (b.ts > a.ts ? b : a))
  const blocking = current.filter((v) => v.verdict === 'blockers')
  if (blocking.length) {
    const v = latest(blocking)
    return reviewPhrase({ blockers: { name: name(v.agentId), count: v.blockers?.length || 1 } })
  }
  const approved = current.filter((v) => v.verdict === 'approved')
  if (approved.length) return reviewPhrase({ approvedBy: [name(latest(approved).agentId)] })
  return reviewPhrase({ stale: name(latest(verdicts).agentId) })
}

/**
 * The room's open PRs, ready ones first, each group in the order the workspaces came in. Ready is the rule every Merge button
 * uses (`mergeBlock`), so the tab never offers a Merge the header would refuse.
 */
export function leadPrs(workspaces: Workspace[], o: { leadId: string | undefined; roomId: string; prs: Record<string, PrInfo>; rules: Rules; agents: AgentDef[] }): LeadPr[] {
  const name = (id: string) => o.agents.find((a) => a.id === id)?.name ?? id
  const rows = workspaces.filter((w) => w.roomId === o.roomId && listsPr(w, o.leadId)).map((ws): LeadPr => {
    const pr = o.prs[ws.id]
    const why = mergeBlock(ws, pr, o.rules, name)
    const base = { ws, name: name(ws.agentId), key: ws.source?.kind === 'issue' ? ws.source.id : undefined, review: reviewLine(ws, pr, name) }
    // A PR merging stays where Merge was pressed, with the ready ones, until GitHub says it merged (KERNEL-411).
    if (!why || ws.prState === 'merging') return { ...base, ready: true }
    const status = prStatus(ws.prState)
    if (status) return { ...base, ready: false, state: status }
    // A PR GitHub calls open, held back by a rule. Held back by the reviewer rule alone, it waits for the reviewer's approval.
    const approval = mergeBlock(ws, pr, { ...o.rules, requireReviewer: false }, name) === undefined
    const label = approval ? 'Waiting for approval' : workspaceGlyph(ws, { waiting: [], running: false }).label
    return { ...base, ready: false, state: { label, tone: 'idle', spin: false, why } }
  })
  return [...rows.filter((r) => r.ready), ...rows.filter((r) => !r.ready)]
}

const NO_AGENTS: AgentDef[] = []
const NO_RULES: Rules = { requireGreen: false, requireReviewer: false }

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
