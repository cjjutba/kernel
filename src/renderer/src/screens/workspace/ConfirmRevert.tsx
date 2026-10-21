import { useEffect, useState } from 'react'
import type { ChangedFile, CheckpointPreview } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { FileIcon } from '../../components/FileIcon'
import { ConfirmDialog, useBusy } from '../../ui'
import { refreshChanges } from './changesBus'
import './confirm.css'

const SHOWN = 8
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const names = (paths: string[]) => paths.slice(0, 3).map((p) => p.slice(p.lastIndexOf('/') + 1)).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '')

/**
 * What the dialog says a revert does (Pen 8.14), in the order a person weighs it: where the worktree goes, then what happens to the commits since, a merged PR and files main changed too. A revert
 * rewrites files only. Commits stay in the branch's history and their changes come back as edits that undo them, so the words never say a commit is made.
 */
export function revertWords(o: { agent?: string; start?: boolean; commitsAhead: number; pushed: boolean; merged?: number | boolean; conflicts: string[] }): string {
  const to = o.start ? 'the start of this chat' : 'this reply'
  const who = o.agent ?? 'The agent'
  const back = o.conflicts.length ? ` main also changed ${names(o.conflicts)} since, so ${o.conflicts.length === 1 ? 'that file goes' : 'those files go'} back too.` : ''
  if (o.merged) return `${typeof o.merged === 'number' ? `PR #${o.merged}` : 'The PR'} is merged, so main keeps its commits. This worktree's files go back to ${to}.${back}`
  if (o.commitsAhead > 0) return `${count(o.commitsAhead, 'commit', 'commits')} since ${to} stay in the branch's history${o.pushed ? ', on your PR too' : ''}. The files go back as changes you haven't committed yet.${back}`
  return `${o.agent ? `${who}'s` : "The agent's"} worktree goes back to how it was ${o.start ? 'when this chat started' : 'after this reply'}. The chat keeps everything said since, and ${who} reads that its files changed.${back}`
}

/** The line under the files: how many change, and where what is there now is kept. */
export function revertNote(files: number, commitsAhead: number): string {
  return `${count(files, 'file changes', 'files change')}.${commitsAhead > 0 ? '' : ' Nothing is committed yet, so no commits move.'} Kernel saves what is there now on a backup branch first.`
}

/** A file's row: its folder quiet and its name in ink, and what the revert does to it at the end. */
function Row({ file }: { file: ChangedFile }) {
  const cut = file.path.lastIndexOf('/') + 1
  return (
    <li className="wsc-file">
      <FileIcon path={file.path} size={16} />
      <span className="wsc-path mono"><span className="wsc-dir">{file.path.slice(0, cut)}</span>{file.path.slice(cut)}</span>
      <span className="wsc-counts">{file.status === 'D' ? 'Deleted' : 'Restored'}</span>
    </li>
  )
}

/** Revert the files to a turn's checkpoint, from the "..." menu in the transcript (KERNEL-766). The chat stays and later changes move to a backup branch. */
export function ConfirmRevert({ workspaceId, checkpointId, start }: { workspaceId: string; checkpointId: string; start?: boolean }) {
  const [preview, setPreview] = useState<CheckpointPreview | null>(null)
  const [busy, run] = useBusy()
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const merged = ws?.prState === 'merged'
  const agent = useStore((s) => (ws ? s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name : undefined))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void call('checkpoints.preview', { workspaceId, checkpointId }).then(setPreview).catch((e) => setError(cleanError(e)))
  }, [workspaceId, checkpointId])

  const revert = () => run('revert', async () => {
    setError(null)
    try {
      await call('checkpoints.revert', { workspaceId, checkpointId })
      refreshChanges(workspaceId)
      actions.ui.closeModal()
    } catch (e) { setError(cleanError(e)) }
  })
  const files = preview?.files ?? []

  return (
    <ConfirmDialog
      title={start ? 'Revert files to the start of this chat?' : 'Revert files to this reply?'} busy={!!busy} busyLabel="Reverting" disabled={!preview} confirmLabel="Revert files"
      body={revertWords({ agent, start, commitsAhead: preview?.commitsAhead ?? 0, pushed: !!preview?.pushed, merged: merged ? ws?.prNumber ?? true : false, conflicts: preview?.conflicts ?? [] })}
      onConfirm={() => void revert()} onCancel={actions.ui.closeModal}
    >
      {preview && (files.length > 0
        ? (
          <>
            <ul className="wsc-facts wsc-files" data-edge="" aria-label="Files that change">
              {files.slice(0, SHOWN).map((f) => <Row key={f.path} file={f} />)}
              {files.length > SHOWN && <li className="wsc-more">and {files.length - SHOWN} more</li>}
            </ul>
            <p className="wsc-foot">{revertNote(preview.stat.files, preview.commitsAhead)}</p>
          </>
        )
        : <p className="wsc-foot">No files change.</p>)}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
