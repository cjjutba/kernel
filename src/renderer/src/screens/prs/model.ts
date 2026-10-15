import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitHubErrorKind, PrInfo, PrReads, Workspace } from '@shared/types'
import { mergeNeedsPr, mergeableState } from '@shared/merge'
import { call } from '../../api'
import { leadOf } from '../../lead'
import { actions, useStore } from '../../store'
import { NO_RULES } from '../workspace/pr/model'
import { leadPrs, type LeadPr } from '../workspace/pr/leadPrList'

/** How many merged PRs the Merged filter lists: the most recent ones. */
export const MERGED_LIMIT = 50

/** A cell of a row: the words, and the tone they are drawn in. `bad` is the red of what needs a person, `faint` is quiet. */
export interface Cell { text: string; tone: 'plain' | 'bad' | 'faint'; spin?: boolean }

/**
 * Checks, from the PR's own checks when GitHub's read is in, else from the workspace's state. A required check failing reads Failed,
 * and an optional one never does (the PR can still merge).
 */
export function checksCell(ws: Workspace, pr: PrInfo | null | undefined): Cell {
  if (pr?.checks.length) {
    if (pr.checks.some((c) => c.state === 'fail' && !c.optional)) return { text: 'Failed', tone: 'bad' }
    if (pr.checks.some((c) => c.state === 'running' || c.state === 'queued')) return { text: 'Running', tone: 'plain', spin: true }
    return { text: 'Passed', tone: 'plain' }
  }
  if (ws.prState === 'cifail') return { text: 'Failed', tone: 'bad' }
  if (ws.prState === 'checks') return { text: 'Running', tone: 'plain', spin: true }
  if (['ready', 'changes', 'conflict', 'merging'].includes(ws.prState)) return { text: 'Passed', tone: 'plain' }
  return { text: 'None yet', tone: 'faint' }
}

/** Review, from what GitHub decided and what Kernel's reviewers found. Changes requested and blockers read red. */
export function reviewCell(row: LeadPr, pr: PrInfo | null | undefined): Cell {
  if (row.ws.prState === 'changes' || pr?.reviewDecision === 'changes') return { text: 'Changes requested', tone: 'bad' }
  if (row.blockers) return { text: row.review.text, tone: 'bad' }
  if (pr?.reviewDecision === 'approved' && row.review.tone !== 'bad') return { text: 'Approved', tone: 'plain' }
  return { text: row.review.text, tone: row.review.tone === 'bad' ? 'bad' : row.review.tone === 'good' ? 'plain' : 'faint' }
}

/** Conflicts: the files GitHub names, else the state. A draft or a PR still being made has nothing to say. */
export function conflictsCell(ws: Workspace, pr: PrInfo | null | undefined): Cell {
  if (ws.prState === 'resolving') return { text: 'Resolving', tone: 'plain', spin: true }
  if (pr?.conflicts.length) return { text: pr.conflicts.length === 1 ? '1 file' : `${pr.conflicts.length} files`, tone: 'bad' }
  if (ws.prState === 'conflict') return { text: 'Conflicts', tone: 'bad' }
  if (ws.prState === 'draft' || ws.prState === 'creating') return { text: 'None yet', tone: 'faint' }
  return { text: 'None', tone: 'plain' }
}

/** A merged PR is one with a number, whose workspace may have been archived since. Review workspaces never carry the PR. */
export const isMerged = (ws: Workspace) => ws.prState === 'merged' && !ws.reviewOf && !!ws.prNumber

/**
 * The open PRs of every room that shows in the sidebar, in the Lead's PRs tab order (ready first, then what needs a person, then what is
 * on its way), and the merged ones, newest first. The merge rule may need a PR GitHub hasn't been asked about, so each such PR is read
 * once, as the Lead's tab does: until then it would count as blocked and never show Merge.
 */
export function usePullRequests(): { open: LeadPr[]; merged: Workspace[]; mergedTotal: number; reading: boolean; reads: PrReads[] } {
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces)
  const prs = useStore((s) => s.prs)
  const agents = useStore((s) => s.agents)
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const visible = useMemo(() => rooms.filter((r) => !r.archived && !r.hidden), [rooms])
  const open = useMemo(
    () => visible.flatMap((r) => leadPrs(workspaces, { leadId: leadOf(agents, r.id)?.id, roomId: r.id, prs, rules, agents: agents[r.id] ?? [] })),
    [visible, workspaces, agents, prs, rules]
  )
  const allMerged = useMemo(() => {
    const ids = new Set(visible.map((r) => r.id))
    return workspaces.filter((w) => ids.has(w.roomId) && isMerged(w)).sort((a, b) => (b.mergedAt ?? b.createdAt) - (a.mergedAt ?? a.createdAt))
  }, [visible, workspaces])
  const merged = useMemo(() => allMerged.slice(0, MERGED_LIMIT), [allMerged])
  const asked = useRef(new Set<string>())
  const [pending, setPending] = useState(0)
  useEffect(() => {
    for (const { ws } of open) {
      if (prs[ws.id] || asked.current.has(ws.id) || !mergeableState(ws.prState) || !mergeNeedsPr(ws, rules)) continue
      asked.current.add(ws.id)
      setPending((n) => n + 1)
      call('pr.get', { workspaceId: ws.id }).then((info) => { if (info) actions.prs.set(info) }).catch(() => undefined).finally(() => setPending((n) => n - 1))
    }
  }, [open, prs, rules])
  const readsByRoom = useStore((s) => s.system.github.reads)
  const reads = useMemo(() => visible.flatMap((r) => readsByRoom?.[r.id] ?? []), [visible, readsByRoom])
  return { open, merged, mergedTotal: allMerged.length, reading: pending > 0, reads }
}

/** The oldest good read among the rooms: the page is only as fresh as its stalest room. Undefined when none has been read. */
export function oldestRead(reads: PrReads[]): number | undefined {
  const times = reads.map((r) => r.at).filter((t): t is number => t !== undefined)
  return times.length ? Math.min(...times) : undefined
}

/** What a failed read means for a person, by the kind the last failed read had. */
export function readFailure(kind: GitHubErrorKind): string {
  switch (kind) {
    case 'signed-out': return 'The GitHub CLI is signed out.'
    case 'not-found': return 'GitHub can no longer find a repository, or this account can\'t see it.'
    case 'rate-limited': return 'GitHub\'s rate limit is used up.'
    case 'offline': return 'GitHub can\'t be reached.'
    case 'other': return 'GitHub answered with an error.'
  }
}
