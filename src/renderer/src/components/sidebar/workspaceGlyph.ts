import type { AgentStatus, Approval, Workspace } from '@shared/types'
import { headBlockers, kindStates } from '@shared/merge'
import type { IconName } from '../../icons'
import { STATUS_WORD } from '../../screens/agent/model'
import { isPlanApproval } from '../../screens/workspace/cards/steps'
import { BLOCKERS_STATUS, busyLabel, localStatus, PR_STATUS, type LocalStand, type PrAction, type PrTone } from '../../screens/workspace/pr/model'

/**
 * The colors a workspace's sidebar icon takes. Green, red and purple mean what they mean in a diff and on GitHub. Amber
 * (`needs`) is what waits on you, the same color as the hover card's "needs you" (KERNEL-274).
 */
export type GlyphTone = 'muted' | 'needs' | 'add' | 'del' | 'merged'

export interface WorkspaceGlyph {
  /** `spin` draws the spinner instead of an icon. */
  icon: IconName | 'spin'
  tone: GlyphTone
  /** Read out with the row's name, since the icon carries the state. */
  label: string
}

const spin = (label: string): WorkspaceGlyph => ({ icon: 'spin', tone: 'muted', label })

/**
 * The icon for approvals that wait on the user. A plan alone shows the clipboard, since it only asks for a review. A question
 * or a tool approval wins when one waits too, because it blocks the agent mid-turn. Pass the pending ones; empty means nothing waits.
 */
const waitingGlyph = (waiting: Approval[]): WorkspaceGlyph =>
  waiting.every(isPlanApproval)
    ? { icon: 'plan', tone: 'needs', label: 'Plan to review' }
    : { icon: 'question', tone: 'needs', label: 'Needs you' }

/** A worktree deleted outside Kernel (KERNEL-291). It waits on you to archive it. */
const FOLDER_GONE: WorkspaceGlyph = { icon: 'warning', tone: 'del', label: 'Folder missing' }

const PR_OPEN: WorkspaceGlyph = { icon: 'pr', tone: 'add', label: 'PR open' }

/**
 * The PR's last review round was the last one Kernel runs, and it left blockers on that round's head, so Kernel reviews the PR
 * no more by itself (KERNEL-552). The same reading as the Team update's "Still blocked after 3 review rounds" (KERNEL-608).
 */
const roundsRanOut = (ws: Workspace): boolean => {
  const r = ws.reviewRound
  return !!r && r.prNumber === ws.prNumber && r.n >= r.rounds && kindStates({ ...ws, prHead: r.head }).blocking.length > 0
}

/**
 * The icon in front of a workspace in the sidebar: what waits on you first (a plan to review, or something that needs you), then what is running, then the pull request.
 * Every input is a real signal: a pending approval, the workspace's status, a running chat, the PR state from GitHub.
 */
const TONE: Record<PrTone, GlyphTone> = { idle: 'muted', ready: 'add', fail: 'del', merged: 'merged' }

/**
 * `local` is set for a branch that merges on the Mac, with where it stands and the branch it merges into (KERNEL-478). `pending` is
 * the PR action main runs on the workspace, from whichever button or tool started it: the icon spins in its word, as the PR band
 * does, until the action ends (KERNEL-520).
 */
export function workspaceGlyph(ws: Workspace, o: { waiting: Approval[]; running: boolean; local?: { stand: LocalStand; base: string }; pending?: PrAction }): WorkspaceGlyph {
  if (o.waiting.length) return waitingGlyph(o.waiting)
  // Nothing can run in a worktree deleted outside Kernel (KERNEL-291).
  if (ws.folderGone) return FOLDER_GONE
  if (ws.status === 'failed') return { icon: 'warning', tone: 'del', label: 'Setup failed' }
  if (ws.status === 'setup') return spin('Setting up')
  if (o.running) return spin('Working')
  return prGlyph(ws, { local: o.local, pending: o.pending }) ?? { icon: 'branch', tone: 'muted', label: ws.stat?.files ? 'No PR yet' : 'No changes yet' }
}

/**
 * The part of a row's icon that comes from the pull request: an action in flight, a branch merging on the Mac, then the PR's own state. It is
 * shared by a workspace row and a chat row (KERNEL-993). Undefined means there is no PR yet, so each row keeps its own icon for that.
 */
function prGlyph(ws: Workspace, o: { local?: { stand: LocalStand; base: string }; pending?: PrAction }): WorkspaceGlyph | undefined {
  // A merged PR is done, though its pending clears a moment later.
  if (o.pending && ws.prState !== 'merged') return spin(busyLabel[o.pending])
  // A branch on the Mac takes the branch glyph in the band's tone, never the PR's. What runs and a merged branch read as a PR does (KERNEL-478).
  if (o.local && ['none', 'ready', 'behind', 'dirty', 'conflict'].includes(o.local.stand)) {
    const status = localStatus(o.local.stand, o.local.base, !!ws.stat?.files)
    return { icon: 'branch', tone: TONE[status.tone], label: status.label }
  }
  switch (ws.prState) {
    // What runs spins, and every state says the word the PR band, the PRs tab and a Team update row say (KERNEL-417).
    case 'creating': case 'checks': case 'resolving': case 'merging': return spin(PR_STATUS[ws.prState].label)
    // A ready PR GitHub won't merge yet reads open, as the header does (KERNEL-401). Blockers on the head commit hold it as
    // they hold the header and the PRs tab, and a PR still blocked after the last review round isn't ready either (KERNEL-608).
    case 'ready': case 'open':
      if (ws.prBlocked) return PR_OPEN
      if (headBlockers(ws)) return { icon: 'prChanges', tone: 'del', label: BLOCKERS_STATUS.label }
      return ws.prState === 'ready' && !roundsRanOut(ws) ? { icon: 'prReady', tone: 'add', label: 'Ready to merge' } : PR_OPEN
    case 'conflict': return { icon: 'prConflict', tone: 'del', label: PR_STATUS.conflict.label }
    case 'cifail': return { icon: 'prCifail', tone: 'del', label: PR_STATUS.cifail.label }
    case 'changes': return { icon: 'prChanges', tone: 'del', label: PR_STATUS.changes.label }
    case 'draft': return { icon: 'prDraft', tone: 'muted', label: PR_STATUS.draft.label }
    case 'merged': return { icon: 'merged', tone: 'merged', label: 'Merged' }
    case 'closed': return { icon: 'prClosed', tone: 'muted', label: 'PR closed' }
    case 'none': return undefined
  }
}

/**
 * The icon in front of the Lead in the sidebar: what waits on you first, like `workspaceGlyph`, then the Lead's status,
 * the same one the Lead's hover card shows, so the row and the card never disagree. the Lead's team plan arrives through
 * `askUser`, which never sets the status to `needs`, so a waiting plan has to win over the status. Idle keeps the chat icon,
 * since the row opens the Lead's chat.
 */
export function leadGlyph(status: AgentStatus, waiting: Approval[]): WorkspaceGlyph {
  if (waiting.length) return waitingGlyph(waiting)
  const label = STATUS_WORD[status]
  switch (status) {
    case 'working': case 'planning': case 'walking': return spin(label)
    case 'needs': return { icon: 'question', tone: 'needs', label }
    case 'blocked': return { icon: 'warning', tone: 'del', label }
    case 'offline': return { icon: 'warning', tone: 'muted', label }
    case 'paused': return { icon: 'pause', tone: 'muted', label }
    case 'idle': return { icon: 'chat', tone: 'muted', label }
  }
}

/**
 * The icon in front of a chat's tab: what waits on the user first (a plan to review, or something that needs you), then a running turn, then the plain chat icon.
 * It reads the same signals as `workspaceGlyph`, per chat instead of per workspace, so a tab and its sidebar row agree.
 */
export function chatGlyph(o: { ws?: Workspace; waiting: Approval[]; running: boolean; local?: { stand: LocalStand; base: string }; pending?: PrAction }): WorkspaceGlyph {
  if (o.waiting.length) return waitingGlyph(o.waiting)
  // The chat's own workspace sets up like a teammate's, and its row says so with the same icons (KERNEL-405).
  if (o.ws?.folderGone) return FOLDER_GONE
  if (o.ws?.status === 'failed') return { icon: 'warning', tone: 'del', label: 'Setup failed' }
  if (o.ws?.status === 'setup') return spin('Setting up')
  if (o.running) return spin('Working')
  // A chat shows its own pull request once it has one. No PR is the chat icon, never the branch (KERNEL-993).
  const ws = o.ws
  if (ws) {
    const hasPr = !!ws.prNumber || ws.prState === 'creating'
    const local = o.local && (o.local.stand !== 'none' || !!ws.stat?.files) ? o.local : undefined
    const g = prGlyph(ws, { local, pending: o.pending })
    if (g && (hasPr || (o.pending && ws.prState !== 'merged') || (local && g.icon === 'branch'))) return g
  }
  return { icon: 'chat', tone: 'muted', label: '' }
}
