import { useEffect, useRef, useState } from 'react'
import type { DeletePreview } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { Button, Checkbox, ConfirmDialog, Icon, useBusy } from '../../ui'
import { historyName, sizeLabel } from './model'
import './history.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Delete from History (KERNEL-333). Kernel forgets archived workspaces for good: their rows, checkpoints, Claude Code
 * transcripts and, when merged or pushed, their branches. A branch with commits pushed nowhere stays unless the box is ticked.
 * The preview counts it all before the button is enabled, and names the branches that hold commits pushed nowhere (Pen 12.6). When the count fails, the
 * dialog says so with Check again and keeps Delete off (Pen 12.7, HistoryConfirmDeleteFailed). A delete that fails closes the dialog and leaves the rows in
 * History, with a toast that carries the reason and a way to try again.
 */
export function ConfirmDeleteHistory({ workspaceIds }: { workspaceIds: string[] }) {
  const workspaces = useStore((s) => s.workspaces)
  const threads = useStore((s) => s.threads)
  const first = workspaces.find((w) => w.id === workspaceIds[0])
  const nameOf = (id: string) => { const w = workspaces.find((x) => x.id === id); return w ? historyName(w, threads) : id }
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [unpushed, setUnpushed] = useState(false)
  const [busy, run] = useBusy()
  const [reading, read] = useBusy<'preview'>()
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const settle = useRef<(() => void)[]>([])
  useEffect(() => {
    let live = true
    void call('workspaces.deletePreview', { workspaceIds }).then((p) => { if (live) { setPreview(p); setPreviewError(null) } }, (e) => { if (live) setPreviewError(cleanError(e)) }).finally(() => settle.current.splice(0).forEach((done) => done()))
    return () => { live = false }
  }, [workspaceIds, tries])
  const retry = () => read('preview', () => {
    setTries((n) => n + 1)
    return new Promise<void>((done) => settle.current.push(done))
  })

  const count = preview?.workspaces ?? workspaceIds.length
  const one = count === 1
  const skipped = preview?.skipped ?? []
  const waiting = skipped.every((s) => s.reason.includes('wait'))

  const again = { label: 'Try again', primary: true, modal: { name: 'confirm', kind: 'deleteHistory', workspaceIds } } as const
  const failed = (sub: string) => {
    actions.ui.closeModal()
    actions.ui.toast({ title: one ? `Could not delete ${nameOf(workspaceIds[0])}` : 'Could not delete the workspaces', sub, glyph: 'error', action: again })
  }
  const remove = () => run('delete', async () => {
    try {
      const r = await call('workspaces.delete', { workspaceIds, deleteUnpushed: unpushed })
      if (!r.deleted.length) return failed(r.skipped[0]?.reason ?? 'Nothing was deleted.')
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
    } catch (e) { failed(cleanError(e)) }
  })

  const what = one ? 'it' : 'them'
  const body = previewError
    ? "Kernel couldn't check which branches were pushed, so it can't say what would be lost."
    : !preview
    ? 'Counting'
    : `Kernel forgets ${what} for good, with ${one ? 'its' : 'their'} chats, checkpoints and Claude Code transcripts${preview.transcriptBytes > 0 ? ` (${sizeLabel(preview.transcriptBytes)})` : ''}. Restore can't bring ${what} back. ${one ? 'A branch that is merged or pushed is' : 'Branches that are merged or pushed are'} deleted.`

  return (
    <ConfirmDialog
      title={workspaceIds.length === 1 ? `Delete ${first ? historyName(first, threads) : 'workspace'}?` : `Delete ${plural(count, 'archived workspace')}?`} danger busy={!!busy} busyPattern="ripple" busyLabel="Deleting"
      confirmLabel={one ? 'Delete' : `Delete ${count}`} disabled={!preview || preview.workspaces === 0}
      onConfirm={() => void remove()} onCancel={actions.ui.closeModal} body={body}
    >
      {previewError && (
        <div className="hs-retry">
          <Button size="lg" busy={reading === 'preview'} busyLabel="Checking again" busyPattern="ripple" onClick={() => void retry()}>Check again</Button>
          <span className="hs-retry-why">{previewError}</span>
        </div>
      )}
      {preview && preview.unpushed.length > 0 && (
        <ul className="wsc-facts hs-lost" aria-label="Branches never pushed">
          {preview.unpushed.map((u) => <li key={u.id} className="hs-lost-row"><Icon name="branch" size={13} /><span className="mono ellipsis">{u.branch}</span><span className="hs-lost-for ellipsis">{nameOf(u.id)}</span></li>)}
        </ul>
      )}
      {preview && preview.unpushedBranches > 0 && (
        <Checkbox checked={unpushed} onChange={setUnpushed}>Also delete {plural(preview.unpushedBranches, 'branch')} with commits that aren't pushed anywhere</Checkbox>
      )}
      {skipped.length > 0 && <p>{waiting ? `${skipped.length} ${skipped.length === 1 ? 'is' : 'are'} skipped because other work still waits on ${skipped.length === 1 ? 'it' : 'them'}.` : `${skipped.length} ${skipped.length === 1 ? 'is' : 'are'} skipped. ${skipped[0].reason}`}</p>}
    </ConfirmDialog>
  )
}
