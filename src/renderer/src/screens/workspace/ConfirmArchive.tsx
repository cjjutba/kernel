import { useEffect, useState } from 'react'
import type { WorkspaceGitStatus } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Button, ConfirmDialog, useBusy } from '../../ui'
import { archiveByHand } from './byHand'
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
  // The status couldn't be read: archiving still works, and the branch stays (KERNEL-70).
  const [unread, setUnread] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(deleteByDefault)
  const [busy, run] = useBusy<'main' | 'anyway'>()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void call('workspaces.gitStatus', { workspaceId }).then(setGit).catch(() => setUnread(true))
  }, [workspaceId])
  if (!ws) return null

  const unpushed = git?.ahead ?? 0
  const current = ws.mode === 'current'
  // The main button pushes first when there are unpushed commits. Archive anyway doesn't.
  const archive = (key: 'main' | 'anyway') => run(key, async () => {
    const push = key === 'main' && unpushed > 0
    setError(null)
    try {
      // Archive anyway keeps the branch: it holds the only copy of the unpushed commits. Main refuses to delete it too.
      await archiveByHand({ workspaceId, deleteBranch: current || unread || (!push && unpushed > 0) ? false : deleteBranch, push })
      actions.ui.closeModal()
      actions.ui.toast({ title: push ? `Pushed ${plural(unpushed, 'commit')} and archived ${ws.name}.` : unpushed ? 'Archived without pushing. The commits are on the local branch.' : `Archived ${ws.name}.` })
    } catch (e) { setError(clean(e)) }
  })

  const removes = current ? 'This workspace is on your current branch, so no files are removed. The chat stays, and you can restore it from History.' : 'Archiving removes the worktree. The branch and chat stay, and you can restore it from History.'
  const dirty = git?.dirty.files ? `${plural(git.dirty.files, 'file')} with uncommitted changes · +${git.dirty.added} -${git.dirty.removed}` : null
  const body = [
    unpushed ? `This branch has ${plural(unpushed, 'commit')} that ${unpushed === 1 ? 'is' : 'are'} not on GitHub yet.` : '',
    unread ? "Kernel couldn't read this branch's status, so the branch stays." : '',
    removes,
    dirty && !current ? 'Uncommitted changes go with the worktree.' : ''
  ].filter(Boolean).join(' ')

  return (
    <ConfirmDialog
      title={`Archive ${ws.name}?`} body={body} busy={busy === 'main'} disabled={busy !== null || (!git && !unread)}
      confirmLabel={unpushed ? 'Push and archive' : 'Archive'} busyLabel={unpushed ? 'Pushing and archiving' : 'Archiving'}
      extra={unpushed ? <Button variant="ghost" size="lg" className="wsc-anyway" busy={busy === 'anyway'} busyLabel="Archiving" disabled={busy !== null} onClick={() => void archive('anyway')}>Archive anyway</Button> : undefined}
      onConfirm={() => void archive('main')} onCancel={actions.ui.closeModal}
    >
      <div className="wsc-facts mono">
        <span>{ws.branch}</span>
        {git && unpushed > 0 && <span>{plural(unpushed, 'commit')} ahead of origin</span>}
        {dirty && <span>{dirty}</span>}
      </div>
      {!current && !unread && <label className="wsc-check"><input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />Also delete the local branch</label>}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
