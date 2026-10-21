import { Button, Icon } from '../../../ui'
import { actions } from '../../../store'

/** Above the composer while the chat's worktree has edits that aren't committed (KERNEL-780). It blocks nothing. */
export function UncommittedNote({ files }: { files: string[] }) {
  const n = files.length
  const review = () => {
    actions.ui.setWorkspaceView({ right: 'changes' })
    actions.ui.setRightPanel(true)
  }
  return (
    <div className="note note-card" role="status">
      <Icon name="branch" size={14} />
      <span className="note-text grow">
        <span className="note-title">{n} file{n === 1 ? '' : 's'} with uncommitted changes</span>
        <span className="note-sub">Teammates start from the latest main, so they won't see {n === 1 ? 'this' : 'these'}. Commit first to hand it on.</span>
      </span>
      <Button variant="ghost" onClick={review}>Review changes</Button>
    </div>
  )
}
