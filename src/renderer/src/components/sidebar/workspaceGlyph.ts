import type { AgentStatus, Approval, Workspace } from '@shared/types'
import type { IconName } from '../../icons'
import { STATUS_WORD } from '../../screens/team/model'
import { isPlanApproval } from '../../screens/workspace/cards/steps'
import { localStatus, PR_STATUS, type LocalStand, type PrTone } from '../../screens/workspace/pr/model'

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

/** A workspace held in `trust` waits on you as much as an approval does, until you trust the room's scripts (KERNEL-209, KERNEL-342). */
const TRUST_GLYPH: WorkspaceGlyph = { icon: 'question', tone: 'needs', label: 'Trust scripts' }

/**
 * The icon in front of a workspace in the sidebar: what waits on you first (a plan to review, something that needs you, or scripts to trust), then what is running, then the pull request.
 * Every input is a real signal: a pending approval, the workspace's status, a running chat, the PR state from GitHub.
 */
const TONE: Record<PrTone, GlyphTone> = { idle: 'muted', ready: 'add', fail: 'del', merged: 'merged' }

/** `local` is set for a branch that merges on the Mac, with where it stands and the branch it merges into (KERNEL-478). */
export function workspaceGlyph(ws: Workspace, o: { waiting: Approval[]; running: boolean; local?: { stand: LocalStand; base: string } }): WorkspaceGlyph {
  if (o.waiting.length) return waitingGlyph(o.waiting)
  // Nothing can run in a worktree deleted outside Kernel (KERNEL-291).
  if (ws.folderGone) return FOLDER_GONE
  if (ws.status === 'trust') return TRUST_GLYPH
  if (ws.status === 'failed') return { icon: 'warning', tone: 'del', label: 'Setup failed' }
  if (ws.status === 'setup') return spin('Setting up')
  if (o.running) return spin('Working')
  // A branch on the Mac takes the branch glyph in the band's tone, never the PR's. What runs and a merged branch read as a PR does (KERNEL-478).
  if (o.local && ['none', 'ready', 'behind', 'dirty', 'conflict'].includes(o.local.stand)) {
    const status = localStatus(o.local.stand, o.local.base, !!ws.stat?.files)
    return { icon: 'branch', tone: TONE[status.tone], label: status.label }
  }
  switch (ws.prState) {
    // What runs spins, and every state says the word the PR band, the PRs tab and a Team update row say (KERNEL-417).
    case 'creating': case 'checks': case 'resolving': case 'merging': return spin(PR_STATUS[ws.prState].label)
    // A ready PR GitHub won't merge yet reads open, as the header does (KERNEL-401).
    case 'ready': return ws.prBlocked ? { icon: 'pr', tone: 'add', label: 'PR open' } : { icon: 'pr', tone: 'add', label: 'Ready to merge' }
    case 'open': return { icon: 'pr', tone: 'add', label: 'PR open' }
    case 'conflict': case 'cifail': case 'changes': return { icon: 'pr', tone: 'del', label: PR_STATUS[ws.prState].label }
    case 'draft': return { icon: 'prDraft', tone: 'muted', label: PR_STATUS.draft.label }
    case 'merged': return { icon: 'merged', tone: 'merged', label: 'Merged' }
    case 'closed': return { icon: 'prClosed', tone: 'muted', label: 'PR closed' }
    case 'none': return { icon: 'branch', tone: 'muted', label: ws.stat?.files ? 'No PR yet' : 'No changes yet' }
  }
}

/**
 * The icon in front of the Lead in the sidebar: what waits on you first, like `workspaceGlyph`, then the Lead's floor status,
 * the same one the Lead's hover card shows, so the row and the card never disagree. Rowan's team plan arrives through
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
 * It reads the same signals as `workspaceGlyph`, per chat instead of per workspace, so a tab and its sidebar row agree. `trust` is set when a workspace
 * the chat started is held for script trust and the row stands in for it, as an approval on that workspace would.
 */
export function chatGlyph(o: { ws?: Workspace; waiting: Approval[]; running: boolean; trust?: boolean }): WorkspaceGlyph {
  if (o.waiting.length) return waitingGlyph(o.waiting)
  // The chat's own workspace sets up like a teammate's, and its row says so with the same icons (KERNEL-405).
  if (o.ws?.folderGone) return FOLDER_GONE
  if (o.ws?.status === 'trust' || o.trust) return TRUST_GLYPH
  if (o.ws?.status === 'failed') return { icon: 'warning', tone: 'del', label: 'Setup failed' }
  if (o.ws?.status === 'setup') return spin('Setting up')
  if (o.running) return spin('Working')
  return { icon: 'chat', tone: 'muted', label: '' }
}
