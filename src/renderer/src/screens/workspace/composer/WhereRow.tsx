import type { ReactNode } from 'react'
import type { Room, WorkspaceMode } from '@shared/types'
import { RoomIcon } from '../../../components/RoomIcon'
import { Icon } from '../../../ui'

/**
 * Where the chat works, in a quiet row under the box: the room, Worktree or Local, and the branch. A chat shows its branch as text. New chat
 * passes `branch` as a picker, `modePicker` for Worktree or Local, and `roomPicker={null}`, since its title names and picks the room. Every
 * item is as tall as that picker's button, so the row is the same height in both.
 */
export function WhereRow({ room, mode, branch, roomPicker, modePicker }: { room: Pick<Room, 'id' | 'name' | 'icon'> | undefined; mode: WorkspaceMode; branch: ReactNode; roomPicker?: ReactNode | null; modePicker?: ReactNode }) {
  return (
    <div className="cmp-where" role="group" aria-label="Where this chat works">
      {roomPicker !== undefined ? roomPicker : <span className="cmp-where-item"><RoomIcon room={room} size={16} /><span className="ellipsis">{room?.name}</span></span>}
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
