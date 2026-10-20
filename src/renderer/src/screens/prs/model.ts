import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitHubErrorKind, PrInfo, PrReads, Workspace } from '@shared/types'
import { mergeNeedsPr, mergeableState } from '@shared/merge'
import { call } from '../../api'
import { leadOf } from '../../lead'
import { actions, useStore } from '../../store'
import { splitScope } from '../../ui/dayGroups'
import { NO_RULES } from '../workspace/pr/model'
import { leadPrs, type LeadPr } from '../workspace/pr/leadPrList'

/** How many merged PRs the Merged filter lists: the most recent ones. */
export const MERGED_LIMIT = 50

/** A cell of a row: the words, and the tone they are drawn in. `good` is the green of what passed or was approved, `bad` is the red of what needs a person, `faint` is quiet. */
export interface Cell { text: string; tone: 'plain' | 'good' | 'bad' | 'faint'; spin?: boolean; /** A 12px mark before the words: a check for what passed or was approved, a cross for failing checks. */ icon?: 'check' | 'close' }

/**
 * Checks, from the PR's own checks when GitHub's read is in, else from the workspace's state. A required check failing reads Failed,
 * and an optional one never does (the PR can still merge).
 */
export function checksCell(ws: Workspace, pr: PrInfo | null | undefined): Cell {
  if (pr?.checks.length) {
    if (pr.checks.some((c) => c.state === 'fail' && !c.optional)) return { text: 'Failed', tone: 'bad', icon: 'close' }
    if (pr.checks.some((c) => c.state === 'running' || c.state === 'queued')) return { text: 'Running', tone: 'plain', spin: true }
    return { text: 'Passed', tone: 'good', icon: 'check' }
  }
  if (ws.prState === 'cifail') return { text: 'Failed', tone: 'bad', icon: 'close' }
  if (ws.prState === 'checks') return { text: 'Running', tone: 'plain', spin: true }
  if (['ready', 'changes', 'conflict', 'merging'].includes(ws.prState)) return { text: 'Passed', tone: 'good', icon: 'check' }
  return { text: 'None yet', tone: 'faint' }
}

/** Review, from what GitHub decided and what Kernel's reviewers found. Changes requested and blockers read red. */
export function reviewCell(row: LeadPr, pr: PrInfo | null | undefined): Cell {
  if (row.ws.prState === 'changes' || pr?.reviewDecision === 'changes') return { text: 'Changes requested', tone: 'bad' }
  if (row.blockers) return { text: row.review.text, tone: 'bad' }
  if (pr?.reviewDecision === 'approved' && row.review.tone !== 'bad') return { text: 'Approved', tone: 'good', icon: 'check' }
  return { text: row.review.text, tone: row.review.tone === 'bad' ? 'bad' : row.review.tone === 'good' ? 'good' : 'faint', ...(row.review.tone === 'good' ? { icon: 'check' as const } : {}) }
}

/** Conflicts: the files GitHub names, else the state. A draft or a PR still being made has nothing to say. */
export function conflictsCell(ws: Workspace, pr: PrInfo | null | undefined): Cell {
  if (ws.prState === 'resolving') return { text: 'Resolving', tone: 'plain', spin: true }
  if (pr?.conflicts.length) return { text: pr.conflicts.length === 1 ? '1 file' : `${pr.conflicts.length} files`, tone: 'bad' }
  if (ws.prState === 'conflict') return { text: 'Conflicts', tone: 'bad' }
  if (ws.prState === 'draft' || ws.prState === 'creating') return { text: 'None yet', tone: 'faint' }
  return { text: 'None', tone: 'faint' }
}

/** The Open list's groups, top to bottom: what can merge, what needs a person, and what is on its way. */
export type OpenGroup = 'ready' | 'needs' | 'progress'
export const OPEN_GROUPS: { id: OpenGroup; label: string }[] = [{ id: 'ready', label: 'Ready to merge' }, { id: 'needs', label: 'Needs you' }, { id: 'progress', label: 'In progress' }]

/**
 * The group a row sits in. A PR that can merge is ready. One with failing checks, changes requested or conflicts needs a person, as does
 * any the Lead's list already counts in its own needs-a-person list. The rest are in progress.
 */
export function openGroup(row: LeadPr, pr: PrInfo | null | undefined): OpenGroup {
  if (row.ready) return 'ready'
  const bad = row.group === 'attention' || [checksCell(row.ws, pr), reviewCell(row, pr), conflictsCell(row.ws, pr)].some((c) => c.tone === 'bad')
  return bad ? 'needs' : 'progress'
}

/** A project's open rows, as the page lists them under the project's name. */
export interface ProjectGroup<T> { id: string; label: string; rows: T[] }

/**
 * The open rows grouped by project, in the order the projects are given. Inside a project the rows keep the Lead's tab order, with what can merge first, then
 * what needs a person, then what is on its way. A project with no open PR is left out.
 */
export function groupOpen(rows: LeadPr[], prs: Record<string, PrInfo>, projects: { id: string; name: string }[]): ProjectGroup<LeadPr>[] {
  const rank = (r: LeadPr) => OPEN_GROUPS.findIndex((g) => g.id === openGroup(r, prs[r.ws.id]))
  return projects.flatMap((p) => {
    const mine = rows.filter((r) => r.ws.projectId === p.id).map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r)
    return mine.length ? [{ id: p.id, label: p.name, rows: mine }] : []
  })
}

/** The merged PRs grouped by project, in the order the projects are given, each project's newest first. */
export function groupMerged(list: Workspace[], projects: { id: string; name: string }[]): ProjectGroup<Workspace>[] {
  return projects.flatMap((p) => {
    const mine = list.filter((w) => w.projectId === p.id)
    return mine.length ? [{ id: p.id, label: p.name, rows: mine }] : []
  })
}

/** When a PR merged, in a few words: "Today, 14:21", "Yesterday", "Oct 16" and, from another year, "Oct 16, 2025". */
export function mergedWhen(at: number, now = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const gap = Math.round((day(n) - day(d)) / 86400000)
  if (gap <= 0) return `Today, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (gap === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) })
}

/** The review a merged PR had: the reviewers' verdicts Kernel kept. Blockers a person overruled still read as that. */
export function mergedReview(ws: Workspace): Cell {
  const v = ws.reviews ?? []
  if (v.length === 0) return { text: 'Merged without review', tone: 'faint' }
  if (v.some((x) => x.verdict === 'blockers')) return { text: ws.overruled ? 'Blockers overruled' : 'Merged with blockers', tone: 'bad' }
  return { text: 'Approved', tone: 'good', icon: 'check' }
}

/** The issue a workspace came from, for a row's sub line: "KERNEL-859". */
export const issueKey = (ws: Workspace): string | undefined => (ws.source?.kind === 'issue' ? ws.source.id : undefined)

/** A merged row's title taken apart: `feat(workspace): text (KERNEL-995)` is the text, the `feat(workspace)` scope and the key. */
export interface ParsedTitle { text: string; scope?: string; key?: string }

const TITLE_KEY = /\s*\(([A-Z][A-Z0-9]+-\d+)\)/

/**
 * The scope and the key come off a title that follows the convention. A title without it is returned exactly as written, with no scope, though a parenthesized key in it still fills the key. Of
 * two keys the first is the row's and the second stays in the text.
 */
export function parseTitle(title: string): ParsedTitle {
  const { scope, rest } = splitScope(title)
  const m = TITLE_KEY.exec(rest)
  if (!scope) return { text: title, ...(m ? { key: m[1] } : {}) }
  if (!m) return { text: rest, scope }
  const text = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim()
  return { text: text || rest, scope, key: m[1] }
}

/** The issue key a branch like `feat/kernel-995-one-chip` names: "KERNEL-995". */
export function branchKey(branch: string | undefined): string | undefined {
  const m = branch && /(?:^|\/)([a-z]{2,8})-(\d+)(?:-|$)/i.exec(branch)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : undefined
}

/** What a merged row shows: the parsed title, and the issue it closes from the title, else the workspace's own issue, else the branch. */
export function mergedRow(ws: Workspace): ParsedTitle & { full: string } {
  const full = ws.prTitle ?? ws.title ?? ws.name
  const p = parseTitle(full)
  return { ...p, full, key: p.key ?? issueKey(ws) ?? branchKey(ws.branch) }
}

/** Whether a merged row matches the search text (title, key, branch) and the agent chosen, if any. */
export function matchesMerged(ws: Workspace, query: string, agentId: string | undefined): boolean {
  if (agentId && ws.agentId !== agentId) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  const r = mergedRow(ws)
  return [r.full, r.key, ws.branch].some((t) => t?.toLowerCase().includes(q))
}

/** A merged PR is one with a number, whose workspace may have been archived since. Review workspaces never carry the PR. */
export const isMerged = (ws: Workspace) => ws.prState === 'merged' && !ws.reviewOf && !!ws.prNumber

/**
 * The open PRs of every project that shows in the sidebar, in the Lead's PRs tab order (ready first, then what needs a person, then what is
 * on its way), and the merged ones, newest first. The merge rule may need a PR GitHub hasn't been asked about, so each such PR is read
 * once, as the Lead's tab does: until then it would count as blocked and never show Merge.
 */
function useOpenPrs() {
  const projects = useStore((s) => s.projects)
  const workspaces = useStore((s) => s.workspaces)
  const prs = useStore((s) => s.prs)
  const agents = useStore((s) => s.agents)
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const visible = useMemo(() => projects.filter((r) => !r.archived && !r.hidden), [projects])
  const open = useMemo(
    () => visible.flatMap((r) => leadPrs(workspaces, { leadId: leadOf(agents, r.id)?.id, projectId: r.id, prs, rules, agents: agents[r.id] ?? [] })),
    [visible, workspaces, agents, prs, rules]
  )
  return { visible, workspaces, prs, rules, open }
}

/** How many pull requests are open across the projects: the count on the Work page's tab, with none of the status reads `usePullRequests` starts. */
export const useOpenPrCount = () => useOpenPrs().open.length

export function usePullRequests(): { open: LeadPr[]; mergedAll: Workspace[]; reading: boolean; reads: PrReads[]; refresh: () => Promise<void> } {
  const { visible, workspaces, prs, rules, open } = useOpenPrs()
  const allMerged = useMemo(() => {
    const ids = new Set(visible.map((r) => r.id))
    return workspaces.filter((w) => ids.has(w.projectId) && isMerged(w)).sort((a, b) => (b.mergedAt ?? b.createdAt) - (a.mergedAt ?? a.createdAt))
  }, [visible, workspaces])
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
  const readsByProject = useStore((s) => s.system.github.reads)
  const reads = useMemo(() => visible.flatMap((r) => readsByProject?.[r.id] ?? []), [visible, readsByProject])
  const refresh = async () => {
    await Promise.all(open.map(({ ws }) => call('pr.get', { workspaceId: ws.id }).then((info) => { if (info) actions.prs.set(info) }).catch(() => undefined)))
  }
  return { open, mergedAll: allMerged, reading: pending > 0, reads, refresh }
}

/** The oldest good read among the projects: the page is only as fresh as its stalest project. Undefined when none has been read. */
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
