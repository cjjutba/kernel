import type { AppSettings, ChatItem, ChatPart, PrInfo, PrState, ReviewComment, Toast, Workspace } from '@shared/types'
import { stripRemote } from '../../settings/remote'

/** What the header shows for each PR state, in the canvas order (WorkspacePRMenu, DraftPR, CIFailed, ChangesRequested, Merged, PRClosed). */
export interface PrHeaderView {
  /** The `#42` link to GitHub. */
  link: boolean
  /** The word beside the link: Draft, Checks failed, Changes requested, Closed. */
  status?: { text: string; tone: 'muted' | 'del' | 'ink2' }
  /** The main button. `busy` shows a spinner and is disabled. */
  button?: { label: string; kind: 'primary' | 'secondary' | 'strong' | 'busy'; action?: PrAction }
  /** Create PR's caret menu (squared right edge on the button). */
  caret: boolean
  merged: boolean
  /** Closed PRs offer Archive next to Reopen. */
  archive: boolean
}

export type PrAction = 'create' | 'resolve' | 'merge' | 'ready' | 'reopen'

/** Kernel saves a workspace's file count whenever it reads the changes. No files, or no count yet, means nothing to put in a PR. */
export const hasChanges = (ws: Workspace) => (ws.stat?.files ?? 0) > 0

/** `changed` is false when the workspace has nothing to put in a PR, which hides Create PR and its menu. */
export function headerView(state: PrState, changed = true): PrHeaderView {
  const base: PrHeaderView = { link: true, caret: false, merged: false, archive: false }
  switch (state) {
    case 'none':
      if (!changed) return { ...base, link: false }
      return { ...base, link: false, caret: true, button: { label: 'Create PR', kind: 'primary', action: 'create' } }
    case 'creating': return { ...base, link: false, button: { label: 'Creating PR', kind: 'busy' } }
    case 'checks': return { ...base, button: { label: 'Checks running', kind: 'busy' } }
    case 'conflict': return { ...base, button: { label: 'Resolve conflicts', kind: 'strong', action: 'resolve' } }
    case 'resolving': return { ...base, button: { label: 'Resolving', kind: 'busy' } }
    case 'ready': case 'open': return { ...base, button: { label: 'Merge PR', kind: 'primary', action: 'merge' } }
    case 'merging': return { ...base, button: { label: 'Merging', kind: 'busy' } }
    case 'merged': return { ...base, merged: true }
    case 'draft': return { ...base, status: { text: 'Draft', tone: 'muted' }, button: { label: 'Ready for review', kind: 'secondary', action: 'ready' } }
    case 'cifail': return { ...base, status: { text: 'Checks failed', tone: 'del' }, button: { label: 'Fix checks', kind: 'primary', action: 'resolve' } }
    case 'changes': return { ...base, status: { text: 'Changes requested', tone: 'ink2' }, button: { label: 'Address review', kind: 'primary', action: 'resolve' } }
    case 'closed': return { ...base, status: { text: 'Closed', tone: 'muted' }, button: { label: 'Reopen', kind: 'secondary', action: 'reopen' }, archive: true }
  }
}

/** The spinner label while an action's call is in flight. */
export const busyLabel: Record<PrAction, string> = { create: 'Creating PR', resolve: 'Sending', merge: 'Merging', ready: 'Marking ready', reopen: 'Reopening' }
/** The toast title when an action's call fails. */
export const failTitle: Record<PrAction, string> = { create: 'Could not create the PR', resolve: 'Could not send to the agent', merge: 'Could not merge', ready: 'Could not mark it ready', reopen: 'Could not reopen' }

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

/** The rows of the review card's code block, places padded so the comments line up. */
export function reviewLines(comments: ReviewComment[]): string[] {
  const width = Math.max(0, ...comments.map((c) => commentPlace(c).length)) + 3
  return comments.map((c) => `${commentPlace(c).padEnd(width)}${c.body.replace(/\s+/g, ' ')}`)
}

/** Unresolved review comments, for the "requested changes" card. */
export const openComments = (pr?: PrInfo) => (pr?.comments ?? []).filter((c) => !c.resolved)

const LANDED: Record<AppSettings['pr']['mergeMethod'], string> = { squash: 'Squashed into', merge: 'Merged into', rebase: 'Rebased onto' }

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
 * Where the workspace view goes once the open workspace is archived (KERNEL-132). Archive lands in History, except a
 * review workspace Kernel archived while it was on screen because the work it reviewed merged or closed: that one opens
 * the room's Lead chat, the first chat of the Lead's workspace, with a toast saying what happened. `seen` is false when the view
 * opened on a workspace that was already archived, and `byHand` is true when the user archived it.
 */
export function afterArchive(ws: Workspace, reviewed: Workspace | undefined, reviewer: string | undefined, how: { seen: boolean; byHand: boolean }): { to: 'history' } | { to: 'room'; toast: { title: string; sub: string } } {
  const done = reviewed && (reviewed.prState === 'merged' || reviewed.prState === 'closed')
  if (!ws.reviewOf || !done || !how.seen || how.byHand) return { to: 'history' }
  const whose = reviewer ? `${reviewer}'s` : 'the'
  const after = reviewed.prNumber ? ` after PR #${reviewed.prNumber} ${reviewed.prState === 'merged' ? 'merged' : 'was closed'}` : ''
  return { to: 'room', toast: { title: `Archived ${whose} review${after}`, sub: 'Restore it from History.' } }
}
