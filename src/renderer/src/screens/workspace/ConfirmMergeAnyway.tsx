import type { Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { failTitle } from './pr/model'

/**
 * Merge a PR whose latest commit has blockers, on purpose (KERNEL-501). It skips the reviewer's blockers and nothing else: failing
 * checks, conflicts and GitHub's own rules still hold the merge, and the failure toasts as a plain Merge does. Opened by every
 * Merge anyway button, from the PRs tab, the Team update and the PR band. `reviewer` is the name of who found `count` blockers.
 */
export function ConfirmMergeAnyway({ ws, reviewer, count, onClose }: { ws: Pick<Workspace, 'id' | 'prNumber'>; reviewer: string; count: number; onClose: () => void }) {
  const [busy, run] = useBusy()
  const pr = ws.prNumber ? `#${ws.prNumber}` : 'this pull request'
  const merge = () => run('merge', async () => {
    try { await call('pr.merge', { workspaceId: ws.id, override: true }) } catch (e) { actions.ui.toast({ title: failTitle.merge, sub: cleanError(e) }) }
    onClose()
  })

  return (
    <ConfirmDialog
      title={`Merge ${pr} anyway?`} body={`${reviewer} found ${count} ${count === 1 ? 'blocker' : 'blockers'} on the latest commit of ${pr}.`}
      confirmLabel="Merge anyway" busy={!!busy} busyLabel="Merging"
      onConfirm={() => void merge()} onCancel={onClose}
    />
  )
}
