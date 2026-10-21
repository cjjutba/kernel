import { FileIcon } from '../../components/FileIcon'
import { shortFile } from './model'

/** An agent's file as a path with its icon: the folder muted and the file's name in full ink, so the name is what the eye lands on. */
export function AgentFile({ file, plain }: { file: string; /** Only the path, all in the muted ink, with no icon: a file named beside something else. */ plain?: boolean }) {
  const path = shortFile(file)
  const at = path.lastIndexOf('/') + 1
  return (
    <span className="ag-file" data-plain={plain || undefined}>
      {!plain && <FileIcon path={path} size={14} />}
      <span className="ag-file-path mono"><span className="ag-file-dir">{path.slice(0, at)}</span>{path.slice(at)}</span>
    </span>
  )
}
