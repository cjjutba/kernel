import { useEffect, useState } from 'react'
import type { WorkspaceGitStatus } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { ConfirmDialog } from '../../ui'
import { refreshChanges } from './changesBus'
import './confirm.css'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Throw away every uncommitted change in the worktree (ConfirmDiscard.png). Main takes a checkpoint first. */
export function ConfirmDiscard({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const [git, setGit] = useState<WorkspaceGitStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void call('workspaces.gitStatus', { workspaceId }).then(setGit).catch((e) => setError(clean(e)))
  }, [workspaceId])
  if (!ws) return null

  const discard = async () => {
    setBusy(true); setError(null)
    try {
      await call('workspaces.discard', { workspaceId })
      refreshChanges(workspaceId)
      actions.ui.closeModal()
      actions.ui.toast({ title: 'Discarded. The worktree matches the last commit.' })
    } catch (e) { setError(clean(e)); setBusy(false) }
  }
  const d = git?.dirty

  return (
    <ConfirmDialog
      title={`Discard changes in ${ws.name}?`} danger busy={busy || !git} confirmLabel="Discard changes"
      body="This throws away every uncommitted change in the worktree. Checkpoints keep the last 20 turns if you change your mind."
      onConfirm={() => void discard()} onCancel={actions.ui.closeModal}
    >
      {d && <div className="wsc-facts mono"><span>{d.files} {d.files === 1 ? 'file' : 'files'} · +{d.added} -{d.removed}</span></div>}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
