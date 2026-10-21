import { headBlockers } from '@shared/merge'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { ConfirmDialog, Icon, useBusy } from '../../ui'
import { blockerFacts, failTitle } from './pr/model'
import './confirm.css'

/**
 * Merge a pull request whose latest commit has blockers, on purpose (Pen 10.2, KERNEL-501). It overrules the reviewer's blockers and merges, so the overrule is on record
 * and Kernel's team update says so. It skips the blockers and nothing else: failing checks, conflicts and GitHub's own rules still hold the merge, and the failure toasts as a plain Merge
 * does. Opened by every Merge anyway button, from the Session rail, the PRs tab and the Team update. The blockers it lists are the ones the reviewer found on the latest commit.
 */
export function ConfirmMergeAnyway({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const [busy, run] = useBusy()
  const onClose = () => actions.ui.closeModal()
  const pr = useStore((s) => s.prs[workspaceId])
  const agents = useStore((s) => (ws ? s.agents[ws.projectId] : undefined))
  if (!ws) return null
  const facts = blockerFacts(ws, pr)
  const found = headBlockers({ ...ws, prHead: pr?.head ?? ws.prHead })
  const count = facts?.count ?? found?.count ?? 0
  const reviewer = found ? agents?.find((a) => a.id === found.agentId)?.name ?? 'The reviewer' : 'The reviewer'
  const number = ws.prNumber ? `#${ws.prNumber}` : 'this pull request'
  const merge = () => run('merge', async () => {
    try {
      await call('reviews.overrule', { workspaceId: ws.id })
      await call('pr.merge', { workspaceId: ws.id, override: true })
    } catch (e) { actions.ui.toast({ title: failTitle.merge, sub: cleanError(e) }) }
    onClose()
  })

  return (
    <ConfirmDialog
      title={`Merge past ${count} ${count === 1 ? 'blocker' : 'blockers'}?`}
      body={`${reviewer} found ${count} ${count === 1 ? 'blocker' : 'blockers'} in ${number}. Merging records that you overruled ${count === 1 ? 'it' : 'them'}, and Kernel's team update says so.`}
      confirmLabel="Merge anyway" merge busy={!!busy} busyPattern="ripple" busyLabel="Merging"
      onConfirm={() => void merge()} onCancel={onClose}
    >
      {facts && facts.items.length > 0 && (
        <ul className="wsc-found" aria-label="Blockers">
          {facts.items.map((b, i) => (
            <li key={i}>
              <Icon name="info" size={14} />
              <span className="wsc-found-text">
                <span>{b.text}</span>
                {b.file && <span className="mono wsc-found-at">{b.file}{b.line ? `:${b.line}` : ''}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ConfirmDialog>
  )
}
