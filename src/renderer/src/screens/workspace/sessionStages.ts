import type { DiffStat, Workspace } from '@shared/types'
import type { SpinnerPattern } from '../../ui/dotPatterns'
import { reviewStages, type PrButton, type PrFacts, type PrTitle } from './pr/prStage'
import { clock } from './setupClock'

/**
 * Where an agent's session stands, as the stages the Session rail lists (KERNEL-1094): briefed, set up, building, reviewed, merged. Every stage comes from what the workspace
 * records, never from a timer: when it was made, how its setup run ended, whether the agent is working or waiting on you, and what became of its pull request.
 * `done` draws a plain green check, `failed` a plain red x, `current` a ring in ink and `pending` a faint one. The pull request's stages add a loader (`busy`), an hourglass for what
 * waits on someone else (`wait`), a closed pull request (`closed`) and the merge glyph in purple, which is for merged only (`merged`) (KERNEL-1097).
 */
export type StageMark = 'done' | 'current' | 'pending' | 'failed' | 'busy' | 'wait' | 'closed' | 'merged'

export type StageId = 'briefed' | 'setup' | 'building' | 'review' | 'reviewed' | 'merged' | 'archive'

export interface Stage {
  id: StageId
  label: string
  mark: StageMark
  /** The line under the label. */
  sub?: string
  /** When the stage finished, for the clock at the right of its label. */
  at?: number
  /** The stage waits on you, so its line is amber. */
  needs?: boolean
  /** The stage is running work that has a loader: the setup script. */
  busy?: boolean
  /** What the agent changed, once it has: drawn as "2 files +67 -1" under Built. */
  stat?: DiffStat
  /** The dot loader that leads the line under the label, for a pull request that checks or resolves. */
  loader?: SpinnerPattern
  /** The branch a local merge goes into, as a `→ main` pill at the right of the label. */
  pill?: string
  /** What the stage lets you do: one or two buttons under its line. */
  buttons?: PrButton[]
}

export interface StageInput {
  ws: Workspace
  /** A turn is running in one of the workspace's chats. */
  running: boolean
  /** What the turn waits on, when it does. */
  waiting?: 'answer' | 'approval'
  /** What the agent is doing now, as its step says it, such as "Capturing every screen". */
  doing?: string
  /** Whether the project has a setup script. A workspace without one is ready as soon as its worktree is. */
  hasSetup?: boolean
  /** What the pull request's stages need beyond the workspace. Without it the rail draws the quiet stages it drew before the pull request had any. */
  pr?: PrFacts
  /** A chat with Kernel's own work: the first stage reads as started by your message, and a stage that can't apply to the chat is left out. */
  lead?: boolean
}

/** The setup stage: the worktree being made, the script running, how it ended, or no script at all. */
function setupStage({ ws, hasSetup }: StageInput): Stage {
  const run = ws.setupRun
  if (ws.status === 'failed') return { id: 'setup', label: 'Set up', mark: 'failed', sub: 'The worktree was not made' }
  if (ws.status === 'setup' && !run) return { id: 'setup', label: 'Set up', mark: 'current', sub: 'Creating the worktree', busy: true }
  if (!run) return { id: 'setup', label: 'Set up', mark: 'done', sub: hasSetup === false ? 'Worktree ready, no setup script' : 'Worktree ready', at: ws.createdAt }
  if (run.endedAt === undefined) return { id: 'setup', label: 'Set up', mark: 'current', sub: 'Running the setup script', busy: true }
  const took = clock(run.endedAt - run.startedAt)
  if (run.end === 0) return { id: 'setup', label: 'Set up', mark: 'done', sub: `Setup script finished in ${took}`, at: run.endedAt }
  if (run.end === 'timeout') return { id: 'setup', label: 'Set up', mark: 'failed', sub: `Setup script timed out after ${took}`, at: run.endedAt }
  if (run.end === null) return { id: 'setup', label: 'Set up', mark: 'failed', sub: `Setup stopped after ${took}`, at: run.endedAt }
  return { id: 'setup', label: 'Set up', mark: 'failed', sub: `Setup script failed after ${took}`, at: run.endedAt }
}

/** What started the workspace: a task of the Lead's plan, an issue, a pull request or a branch, or you. */
function briefedSub(ws: Workspace): string {
  if (ws.taskId) return `Task ${ws.taskId} from the Lead's plan`
  const source = ws.source
  if (source?.kind === 'issue') return `Started from ${source.id}`
  if (source?.kind === 'pr') return `Started from PR #${source.number}`
  if (ws.leadChatId) return 'Handed off by Kernel'
  return 'You briefed it'
}

/**
 * The stages of a workspace, in order: briefed, set up, building or built, then the pull request's own (Review, Merged and once merged Archive). The work counts as built
 * once its pull request is open, or once the agent is idle with changes to open one with.
 */
export function sessionStages(input: StageInput): Stage[] {
  return sessionView(input).stages
}

/**
 * Whether a chat with Kernel has work of its own to show stages for: files changed in its folder, or a pull request open, being made or merged. A chat that only answered
 * questions has neither, so its rail lists what it handed off and nothing else.
 */
export function hasOwnWork(ws: Workspace, pr?: PrFacts): boolean {
  return (!!ws.stat && ws.stat.files > 0) || !!ws.prNumber || ws.prState !== 'none' || pr?.pending === 'create'
}

/** The stages, and what the title bar says about the pull request while the rail is hidden. */
export function sessionView(input: StageInput): { stages: Stage[]; title?: PrTitle } {
  const { ws, running, waiting, doing } = input
  const merged = ws.prState === 'merged'
  const hasPr = !!ws.prNumber || (ws.prState !== 'none' && ws.prState !== 'creating')
  const stat = ws.stat && ws.stat.files > 0 ? ws.stat : undefined
  // The agent finished a turn with changes in the tree: they are what a pull request opens with. A pull request being created is built already.
  const built = merged || hasPr || ws.prState === 'creating' || input.pr?.pending === 'create' || (!!input.pr && !running && !waiting && !!stat)
  const briefed: Stage = input.lead
    ? { id: 'briefed', label: 'Started', mark: 'done', sub: 'Started by your message', at: ws.createdAt }
    : { id: 'briefed', label: 'Briefed', mark: 'done', sub: briefedSub(ws), at: ws.createdAt }
  // A chat on the shared main folder has no worktree and no setup run.
  const setup = input.lead && ws.shared ? undefined : setupStage(input)
  // The agent works alongside setup, so the stage that follows is current whatever setup says, until a pull request is open.
  const building: Stage = built
    ? { id: 'building', label: 'Built', mark: 'done', ...(stat ? { stat } : { sub: 'Pull request opened' }) }
    : waiting
      ? { id: 'building', label: 'Building', mark: 'current', sub: `Waiting on your ${waiting}`, needs: true }
      : running
        ? { id: 'building', label: 'Building', mark: 'current', sub: doing ?? 'Working' }
        : { id: 'building', label: 'Building', mark: 'current', ...(stat ? { stat } : { sub: 'Waiting for a message' }) }
  const after = reviewStages(ws, input.pr, built, !running && !waiting)
  return { stages: [briefed, ...(setup ? [setup] : []), building, ...after.stages], ...(after.title ? { title: after.title } : {}) }
}
