import { Icon } from '../../../ui'

/** Joins names as "a", "a and b" or "a, b and 2 more". */
function names(files: string[]) {
  const base = files.map((f) => f.split('/').pop() ?? f)
  const shown = base.slice(0, 2).map((n, i) => <span key={i} className="mono">{n}</span>)
  const rest = base.length - 2
  if (base.length === 1) return shown
  if (rest <= 0) return <>{shown[0]} and {shown[1]}</>
  return <>{shown[0]}, {shown[1]} and {rest} more</>
}

/** Above the composer in Hand off while the chat's worktree has edits that aren't committed (KERNEL-780). It blocks nothing. */
export function UncommittedNote({ files }: { files: string[] }) {
  const n = files.length
  return (
    <div className="note" role="status">
      <Icon name="info" size={14} />
      <span className="note-text">{n} uncommitted file{n === 1 ? '' : 's'} in this chat: {names(files)}. {n === 1 ? 'It stays' : 'They stay'} here until you switch back to Build here.</span>
    </div>
  )
}
