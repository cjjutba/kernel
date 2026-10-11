import { useEffect, useState } from 'react'
import type { DeletePreview } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { sizeLabel } from './model'
import './history.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Delete from History (KERNEL-333). Kernel forgets archived workspaces for good: their rows, checkpoints, Claude Code
 * transcripts and, when merged or pushed, their branches. A branch with commits pushed nowhere stays unless the box is ticked.
 * The preview counts it all before the button is enabled.
 */
export function ConfirmDeleteHistory({ workspaceIds }: { workspaceIds: string[] }) {
  const first = useStore((s) => s.workspaces.find((w) => w.id === workspaceIds[0]))
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [unpushed, setUnpushed] = useState(false)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void call('workspaces.deletePreview', { workspaceIds }).then((p) => { if (live) setPreview(p) }, (e) => { if (live) setError(cleanError(e)) })
    return () => { live = false }
  }, [workspaceIds])

  const count = preview?.workspaces ?? workspaceIds.length
  const one = count === 1
  const skipped = preview?.skipped ?? []
  const waiting = skipped.every((s) => s.reason.includes('wait'))

  const remove = () => run('delete', async () => {
    setError(null)
    try {
      const r = await call('workspaces.delete', { workspaceIds, deleteUnpushed: unpushed })
      if (!r.deleted.length) { setError(r.skipped[0]?.reason ?? 'Nothing was deleted.'); return }
      const named = r.deleted.length === 1 ? getState().workspaces.find((w) => w.id === r.deleted[0])?.name : undefined
      actions.workspaces.remove(r.deleted)
      actions.ui.closeModal()
      actions.ui.toast({
        title: named ? `Deleted ${named}` : `Deleted ${plural(r.deleted.length, 'workspace')}`,
        sub: [
          r.freedBytes > 0 && `Freed ${sizeLabel(r.freedBytes)}.`,
          r.keptBranches > 0 && `Kept ${plural(r.keptBranches, 'branch')} with unpushed commits.`,
          r.skipped.length > 0 && `Skipped ${r.skipped.length}.`,
          'The database shrinks the next time Kernel starts.'
        ].filter(Boolean).join(' ')
      })
    } catch (e) { setError(cleanError(e)) }
  })

  const what = one ? 'it' : 'them'
  const body = !preview
    ? 'Counting'
    : `Kernel forgets ${what} for good, with ${one ? 'its' : 'their'} chats, checkpoints and Claude Code transcripts${preview.transcriptBytes > 0 ? ` (${sizeLabel(preview.transcriptBytes)})` : ''}. Restore can't bring ${what} back. ${one ? 'A branch that is merged or pushed is' : 'Branches that are merged or pushed are'} deleted.`

  return (
    <ConfirmDialog
      title={workspaceIds.length === 1 ? `Delete ${first?.name ?? 'workspace'}?` : `Delete ${plural(count, 'workspace')}?`} danger busy={!!busy} busyLabel="Deleting"
      confirmLabel={one ? 'Delete workspace' : 'Delete workspaces'} disabled={!preview || preview.workspaces === 0}
      onConfirm={() => void remove()} onCancel={actions.ui.closeModal} body={body}
    >
      {preview && preview.unpushedBranches > 0 && (
        <label className="hs-check"><input type="checkbox" checked={unpushed} onChange={(e) => setUnpushed(e.target.checked)} />Also delete {plural(preview.unpushedBranches, 'branch')} with commits that aren't pushed anywhere</label>
      )}
      {skipped.length > 0 && <p>{waiting ? `${skipped.length} ${skipped.length === 1 ? 'is' : 'are'} skipped because other work still waits on ${skipped.length === 1 ? 'it' : 'them'}.` : `${skipped.length} ${skipped.length === 1 ? 'is' : 'are'} skipped. ${skipped[0].reason}`}</p>}
      {error && <p role="alert" className="hs-error">{error}</p>}
    </ConfirmDialog>
  )
}
