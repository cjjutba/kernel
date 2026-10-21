import { useEffect, useState } from 'react'
import type { ChangedFile, WorkspaceGitStatus } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { FileIcon } from '../../components/FileIcon'
import { refreshChanges } from './changesBus'
import './confirm.css'


/** The files with their line counts, one row each: the folder faint and the name in ink, like the Changes list (Pen 12.2). */
function ChangedRow({ file }: { file: ChangedFile }) {
  const cut = file.path.lastIndexOf('/') + 1
  return (
    <li className="wsc-file">
      <FileIcon path={file.path} size={16} />
      <span className="wsc-path"><span className="wsc-dir">{file.path.slice(0, cut)}</span>{file.path.slice(cut)}</span>
      <span className="wsc-counts mono">{[file.added ? `+${file.added}` : '', file.removed ? `-${file.removed}` : ''].filter(Boolean).join(' ')}</span>
    </li>
  )
}

/** The files the box lists before it says how many more there are. */
const SHOWN = 6

/**
 * Throw away every uncommitted change in the worktree (Pen 12.2). Main takes a checkpoint first, so the words say what goes and what
 * the checkpoints keep. The worktree and its branch stay.
 */
export function ConfirmDiscard({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const [git, setGit] = useState<WorkspaceGitStatus | null>(null)
  const [busy, run] = useBusy()
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void call('workspaces.gitStatus', { workspaceId }).then(setGit).catch((e) => setError(cleanError(e)))
    // The list is a nicety. Without it the box falls back to the counts.
    void call('workspaces.changes', { workspaceId, target: { kind: 'uncommitted' } }).then(setFiles).catch(() => setFiles([]))
  }, [workspaceId])
  const agent = useStore((s) => (ws ? s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name : undefined))
  if (!ws) return null

  const discard = () => run('discard', async () => {
    setError(null)
    try {
      await call('workspaces.discard', { workspaceId })
      refreshChanges(workspaceId)
      actions.ui.closeModal()
    } catch (e) { setError(cleanError(e)) }
  })
  const d = git?.dirty
  const shown = files?.slice(0, SHOWN) ?? []
  const more = (files?.length ?? 0) - shown.length

  return (
    <ConfirmDialog
      title={agent ? `Discard ${agent}'s work?` : `Discard the work in ${ws.name}?`} danger busy={!!busy} busyPattern="ripple" busyLabel="Discarding" disabled={!git} confirmLabel="Discard work"
      body="This throws away every uncommitted change in the worktree. Checkpoints keep the last 20 turns if you change your mind."
      onConfirm={() => void discard()} onCancel={actions.ui.closeModal}
    >
      {shown.length > 0
        ? (
          <ul className="wsc-facts wsc-files" aria-label="Files that change">
            {shown.map((f) => <ChangedRow key={f.path} file={f} />)}
            {more > 0 && <li className="wsc-more">and {more} more</li>}
          </ul>
        )
        : d && <div className="wsc-facts mono"><span>{d.files} {d.files === 1 ? 'file' : 'files'} · +{d.added} -{d.removed}</span></div>}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
