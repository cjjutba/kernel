import type { Modal } from '@shared/types'
import { actions } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import './issues.css'

type Found = Extract<Modal, { kind: 'issueTaken' }>['found']

/**
 * Someone may already be on this issue (ConfirmIssueTaken.png). It lists what Kernel found, up to three things, and waits.
 * Starting anyway destroys nothing, so the button is the primary one and not the red one. `onStart` is what starting does:
 * it may wait on the main process, and the button spins until it settles.
 */
export function ConfirmIssueTaken({ issue, found, onStart }: { issue: string; found: Found; onStart: () => void | Promise<void> }) {
  const [busy, run] = useBusy()
  const rows: { label: string; value: string; mono?: boolean }[] = [
    ...(found.branch ? [{ label: 'Remote branch', value: found.branch, mono: true }] : []),
    ...(found.pr ? [{ label: 'Open PR', value: `#${found.pr.number} ${found.pr.title}`, mono: true }] : []),
    ...(found.assignee ? [{ label: 'Assignee', value: found.assignee }] : [])
  ]
  return (
    <ConfirmDialog
      title={`Someone may already be on ${issue}`} confirmLabel="Start anyway" busy={!!busy} busyLabel="Starting"
      body="Kernel found work on this issue by someone else. A new workspace may repeat it."
      onConfirm={() => void run('start', async () => { await onStart() })} onCancel={actions.ui.closeModal}
    >
      {rows.length > 0 && (
        <dl className="is-taken">
          {rows.map((r) => (
            <div key={r.label} className="is-taken-row">
              <dt>{r.label}</dt>
              <dd className={r.mono ? 'mono' : undefined} title={r.value}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </ConfirmDialog>
  )
}
