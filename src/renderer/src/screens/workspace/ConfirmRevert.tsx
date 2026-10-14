import { useEffect, useState } from 'react'
import type { CheckpointPreview } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { refreshChanges } from './changesBus'
import './confirm.css'

const SHOWN = 8
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What the revert does to commits: HEAD stays, and their changes come back as edits that undo them. */
export function commitsLine(commitsAhead: number, pushed: boolean): string {
  const undone = `This also undoes ${count(commitsAhead, 'commit', 'commits')} as uncommitted changes.`
  return pushed ? `${undone} Your PR keeps ${commitsAhead === 1 ? 'it' : 'them'}.` : `${undone} ${commitsAhead === 1 ? 'It is' : 'They are'} not pushed, so the backup branch keeps ${commitsAhead === 1 ? 'it' : 'them'}.`
}

/** Revert the files to a turn's checkpoint, from the "..." menu in the transcript (KERNEL-766). The chat stays and later changes move to a backup branch. */
export function ConfirmRevert({ workspaceId, checkpointId, start }: { workspaceId: string; checkpointId: string; start?: boolean }) {
  const [preview, setPreview] = useState<CheckpointPreview | null>(null)
  const [busy, run] = useBusy()
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
      title={start ? 'Revert files to the start of this chat?' : 'Revert files to here?'} busy={!!busy} busyLabel="Reverting" disabled={!preview} confirmLabel="Revert"
      body="Your files go back to how they were then. The chat stays, and later changes move to a backup branch."
      onConfirm={() => void revert()} onCancel={actions.ui.closeModal}
    >
      {preview && (files.length > 0
        ? (
          <div className="wsc-facts mono">
            <span>{count(preview.stat.files, 'file', 'files')} · +{preview.stat.added} -{preview.stat.removed}</span>
            <ul className="wsc-files">
              {files.slice(0, SHOWN).map((f) => <li key={f.path}><span className="wsc-path">{f.path}</span><span className="add">{f.added ? `+${f.added}` : ''}</span><span className="del">{f.removed ? `-${f.removed}` : ''}</span></li>)}
              {files.length > SHOWN && <li><span className="wsc-path">and {files.length - SHOWN} more</span></li>}
            </ul>
          </div>
        )
        : <p className="wsc-note">No files change.</p>)}
      {preview && preview.commitsAhead > 0 && <p className="wsc-note">{commitsLine(preview.commitsAhead, preview.pushed)}</p>}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
