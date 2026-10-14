import { useState } from 'react'
import type { PrInstructions } from '@shared/types'
import { Button, Modal } from '../../../ui'

/** The four instructions a PR button sends, with their names and the button that sends each (Settings, Pull requests and a room's). */
export const INSTRUCTIONS: { key: keyof PrInstructions; label: string; file: string; desc: string }[] = [
  { key: 'createInstructions', label: 'Create PR', file: 'create-pr.md', desc: 'Sent when you press Create PR' },
  { key: 'resolveInstructions', label: 'Resolve conflicts', file: 'resolve-conflicts.md', desc: 'Sent when you press Resolve conflicts' },
  { key: 'fixChecksInstructions', label: 'Fix checks', file: 'fix-checks.md', desc: 'Sent when you press Fix checks' },
  { key: 'addressReviewInstructions', label: 'Address review', file: 'address-review.md', desc: 'Sent when you press Address review' }
]

/**
 * Edits one PR instruction in the one modal shell (KERNEL-680), so the page lists four short rows instead of four long text boxes.
 * `fallback` is the text used when this one is left empty: the app's default, or for a room the app's text. Use default puts it back,
 * sending `null`. Save sends the text, or `null` when it is the fallback.
 */
export function InstructionSheet({ title, value, fallback, fallbackLabel = 'Use default', onSave, onClose }: {
  title: string; value: string; fallback: string; fallbackLabel?: string; onSave: (text: string | null) => Promise<unknown> | void; onClose: () => void
}) {
  const [text, setText] = useState(value)
  const [busy, setBusy] = useState(false)
  const save = async (next: string | null) => {
    setBusy(true)
    try { await onSave(next !== null && (next.trim() === '' || next === fallback) ? null : next) } finally { setBusy(false) }
    onClose()
  }
  return (
    <Modal
      title={title} width={640} onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" disabled={busy || text === fallback} onClick={() => setText(fallback)}>{fallbackLabel}</Button>
          <span className="grow" />
          <Button disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Saving" disabled={text === value} onClick={() => void save(text)}>Save</Button>
        </>
      )}
    >
      <textarea className="set-lines set-sheet-text" aria-label={title} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  )
}
