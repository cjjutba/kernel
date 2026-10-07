import { useEffect, useState } from 'react'
import type { WorkspaceGitStatus } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Button, ConfirmDialog } from '../../ui'
import './confirm.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Archive a workspace (ConfirmArchive.png). With commits that never reached GitHub, the main button pushes first and
 * "Archive anyway" leaves them on the local branch. The worktree goes; the branch and chat stay for History.
 */
export function ConfirmArchive({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const deleteByDefault = useStore((s) => s.settings?.workspace.deleteBranchOnArchive ?? false)
  const [git, setGit] = useState<WorkspaceGitStatus | null>(null)
  const [deleteBranch, setDeleteBranch] = useState(deleteByDefault)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void call('workspaces.gitStatus', { workspaceId }).then(setGit).catch((e) => setError(clean(e)))
  }, [workspaceId])
  if (!ws) return null

  const unpushed = git?.ahead ?? 0
  const current = ws.mode === 'current'
  const archive = async (push: boolean) => {
    setBusy(true); setError(null)
    try {
      // Archive anyway keeps the branch: it holds the only copy of the unpushed commits. Main refuses to delete it too.
      await call('workspaces.archive', { workspaceId, deleteBranch: current || (!push && unpushed > 0) ? false : deleteBranch, push })
      actions.ui.closeModal()
      actions.ui.toast({ title: push ? `Pushed ${plural(unpushed, 'commit')} and archived ${ws.name}.` : unpushed ? 'Archived without pushing. The commits are on the local branch.' : `Archived ${ws.name}.` })
    } catch (e) { setError(clean(e)); setBusy(false) }
  }

  const removes = current ? 'This workspace is on your current branch, so no files are removed. The chat stays, and you can restore it from History.' : 'Archiving removes the worktree. The branch and chat stay, and you can restore it from History.'
  const dirty = git?.dirty.files ? `${plural(git.dirty.files, 'file')} with uncommitted changes · +${git.dirty.added} -${git.dirty.removed}` : null
  const body = [
    unpushed ? `This branch has ${plural(unpushed, 'commit')} that ${unpushed === 1 ? 'is' : 'are'} not on GitHub yet.` : '',
    removes,
    dirty && !current ? 'Uncommitted changes go with the worktree.' : ''
  ].filter(Boolean).join(' ')

  return (
    <ConfirmDialog
      title={`Archive ${ws.name}?`} body={body} busy={busy || !git}
      confirmLabel={unpushed ? 'Push and archive' : 'Archive'}
      extra={unpushed ? <Button variant="ghost" size="lg" className="wsc-anyway" disabled={busy} onClick={() => void archive(false)}>Archive anyway</Button> : undefined}
      onConfirm={() => void archive(unpushed > 0)} onCancel={actions.ui.closeModal}
    >
      <div className="wsc-facts mono">
        <span>{ws.branch}</span>
        {git && unpushed > 0 && <span>{plural(unpushed, 'commit')} ahead of origin</span>}
        {dirty && <span>{dirty}</span>}
      </div>
      {!current && <label className="wsc-check"><input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />Also delete the local branch</label>}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
