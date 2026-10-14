import type { Modal } from '@shared/types'
import { ConfirmDialog, useBusy } from '../../ui'
import './issues.css'

type Finding = Extract<Modal, { kind: 'issueTaken' }>['findings'][number]

/** A finding as a row of the box: its label and what it found. Branches and PRs are code, so they are mono. */
function rowOf(f: Finding): { label: string; value: string; mono?: boolean } {
  switch (f.kind) {
    case 'branch': return { label: 'Remote branch', value: f.ref, mono: true }
    case 'pr': return { label: 'Open PR', value: `#${f.number} ${f.title}`, mono: true }
    case 'assignee': return { label: 'Assignee', value: f.name }
  }
}

/**
 * Someone may already be on this issue (ConfirmIssueTaken.png). It lists what Kernel found, up to three things, and waits.
 * Starting anyway destroys nothing, so the button is the primary one and not the red one. `onStart` is what starting does:
 * it may wait on the main process, and the button spins until it settles. `onCancel` is where Cancel goes back to (KERNEL-500).
 */
export function ConfirmIssueTaken({ issue, findings, onStart, onCancel }: { issue: string; findings: Finding[]; onStart: () => void | Promise<void>; onCancel: () => void }) {
  const [busy, run] = useBusy()
  const rows = findings.map(rowOf)
  return (
    <ConfirmDialog
      title={`Someone may already be on ${issue}`} confirmLabel="Start anyway" busy={!!busy} busyPattern="pulse" busyLabel="Starting"
      body="Kernel found work on this issue by someone else. A new workspace may repeat it."
      onConfirm={() => void run('start', async () => { await onStart() })} onCancel={onCancel}
    >
      {rows.length > 0 && (
        <dl className="is-taken">
          {rows.map((r) => (
            <div key={`${r.label}:${r.value}`} className="is-taken-row">
              <dt>{r.label}</dt>
              <dd className={r.mono ? 'mono' : undefined} title={r.value}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </ConfirmDialog>
  )
}
