import type { ReactNode } from 'react'
import type { WorkspaceMode } from '@shared/types'
import { Icon } from '../../../ui'

/**
 * Where the chat works, in a quiet row under the box: Worktree or Local, and the branch. A chat shows both as text. New chat passes `modePicker`
 * for Worktree or Local and `branch` as a picker. Every item is as tall as that picker's button, so the row is the same height in both.
 */
export function WhereRow({ mode, branch, modePicker }: { mode: WorkspaceMode; branch: ReactNode; modePicker?: ReactNode }) {
  return (
    <div className="cmp-where" role="group" aria-label="Where this chat works">
      {modePicker ?? <span className="cmp-where-item"><Icon name={mode === 'current' ? 'computer' : 'fork'} size={14} />{mode === 'current' ? 'Local' : 'Worktree'}</span>}
      {branch}
    </div>
  )
}

/** A chat's branch, read only. */
export function WhereBranch({ branch }: { branch: string }) {
  return <span className="cmp-where-item cmp-where-branch"><Icon name="branch" size={14} /><span className="mono ellipsis">{branch}</span></span>
}

/**
 * New chat with Local picked: the checkout's branch as flat muted text, with no box and no chevron, since Local never cuts a branch. Its tooltip
 * opens beside the text, on hover and focus, so it never covers the box's toolbar above.
 */
export function WhereLocalBranch({ branch }: { branch: string }) {
  return (
    <span className="cmp-where-item cmp-where-branch cmp-where-local" tabIndex={0} aria-describedby="where-local-tip">
      <Icon name="branch" size={14} /><span className="mono ellipsis">{branch}</span>
      <span id="where-local-tip" role="tooltip" className="where-tip">Local works on your checkout's current branch</span>
    </span>
  )
}
