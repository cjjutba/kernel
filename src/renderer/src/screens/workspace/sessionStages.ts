import type { DiffStat, Workspace } from '@shared/types'
import { clock } from './setupClock'

/**
 * Where an agent's session stands, as the stages the Session rail lists (KERNEL-1094): briefed, set up, building, reviewed, merged. Every stage comes from what the workspace
 * records, never from a timer: when it was made, how its setup run ended, whether the agent is working or waiting on you, and what became of its pull request.
 * `done` draws a plain green check, `failed` a plain red x, `current` a ring in ink and `pending` a faint one.
 */
export type StageMark = 'done' | 'current' | 'pending' | 'failed'

export type StageId = 'briefed' | 'setup' | 'building' | 'review' | 'merged'

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

/** The five stages of a workspace, in order. */
export function sessionStages(input: StageInput): Stage[] {
  const { ws, running, waiting, doing } = input
  const merged = ws.prState === 'merged'
  const hasPr = !!ws.prNumber || (ws.prState !== 'none' && ws.prState !== 'creating')
  const built = merged || hasPr
  const stat = ws.stat && ws.stat.files > 0 ? ws.stat : undefined
  const briefed: Stage = { id: 'briefed', label: 'Briefed', mark: 'done', sub: briefedSub(ws), at: ws.createdAt }
  const setup = setupStage(input)
  // The agent works alongside setup, so the stage that follows is current whatever setup says, until a pull request is open.
  const building: Stage = built
    ? { id: 'building', label: 'Built', mark: 'done', ...(stat ? { stat } : { sub: 'Pull request opened' }) }
    : waiting
      ? { id: 'building', label: 'Building', mark: 'current', sub: `Waiting on your ${waiting}`, needs: true }
      : running
        ? { id: 'building', label: 'Building', mark: 'current', sub: doing ?? 'Working' }
        : { id: 'building', label: 'Building', mark: 'current', ...(stat ? { stat } : { sub: 'Waiting for a message' }) }
  const review: Stage = merged
    ? { id: 'review', label: 'Reviewed', mark: 'done', sub: ws.prNumber ? `#${ws.prNumber} was reviewed` : 'The pull request was reviewed' }
    : hasPr
      ? { id: 'review', label: 'Review', mark: 'current', sub: ws.prNumber ? `#${ws.prNumber} is ${ws.prState === 'closed' ? 'closed' : 'open'}` : 'The pull request is open' }
      : { id: 'review', label: 'Reviewed', mark: 'pending', sub: 'A reviewer reads the pull request' }
  const last: Stage = merged ? { id: 'merged', label: 'Merged', mark: 'done', ...(ws.mergedAt ? { at: ws.mergedAt } : {}) } : { id: 'merged', label: 'Merged', mark: 'pending' }
  return [briefed, setup, building, review, last]
}
