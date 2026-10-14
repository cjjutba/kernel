import type { ReactNode } from 'react'
import type { Room, WorkspaceMode } from '@shared/types'
import { RoomIcon } from '../../../components/RoomIcon'
import { Icon } from '../../../ui'

/**
 * Where the chat works, in a quiet row under the box: the room, Worktree or Local, and the branch. A chat shows its branch as text. New chat
 * passes `branch` as a picker. Every item is as tall as that picker's button, so the row is the same height in both.
 */
export function WhereRow({ room, mode, branch }: { room: Pick<Room, 'id' | 'name' | 'icon'> | undefined; mode: WorkspaceMode; branch: ReactNode }) {
  return (
    <div className="cmp-where" role="group" aria-label="Where this chat works">
      <span className="cmp-where-item"><RoomIcon room={room} size={16} /><span className="ellipsis">{room?.name}</span></span>
      <span className="cmp-where-item"><Icon name={mode === 'current' ? 'computer' : 'fork'} size={14} />{mode === 'current' ? 'Local' : 'Worktree'}</span>
      {branch}
    </div>
  )
}

/** A chat's branch, read only. */
export function WhereBranch({ branch }: { branch: string }) {
  return <span className="cmp-where-item cmp-where-branch"><Icon name="branch" size={14} /><span className="mono ellipsis">{branch}</span></span>
}
