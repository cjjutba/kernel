import { useEffect, useState } from 'react'
import type { PrInstructions } from '@shared/types'
import { Button, Modal } from '../../../ui'
import { SaveNote, useBlurSave, useSaveNote, type SaveResult } from '../kit'

/** The four instructions a PR button sends, with their names and the button that sends each (Settings, Pull requests and a project's). */
export const INSTRUCTIONS: { key: keyof PrInstructions; label: string; file: string; desc: string }[] = [
  { key: 'createInstructions', label: 'Create PR', file: 'create-pr.md', desc: 'Sent when you press Create PR' },
  { key: 'resolveInstructions', label: 'Resolve conflicts', file: 'resolve-conflicts.md', desc: 'Sent when you press Resolve conflicts' },
  { key: 'fixChecksInstructions', label: 'Fix checks', file: 'fix-checks.md', desc: 'Sent when you press Fix checks' },
  { key: 'addressReviewInstructions', label: 'Address review', file: 'address-review.md', desc: 'Sent when you press Address review' }
]

/**
 * Edits one PR instruction in the one modal shell (KERNEL-680), so the page lists four short rows instead of four long text boxes.
 * `fallback` is the text used when this one is left empty: the app's default, or for a project the app's text. The text saves when the
 * field loses focus or the sheet closes, with the Saved note in the footer, and Escape in the field puts the saved text back (KERNEL-721).
 * Use default puts the fallback back and saves it at once. A save sends the text, or `null` when it is empty or the fallback.
 */
export function InstructionSheet({ title, value, fallback, fallbackLabel = 'Use default', onSave, onClose }: {
  title: string; value: string; fallback: string; fallbackLabel?: string; onSave: (text: string | null) => SaveResult; onClose: () => void
}) {
  const [text, setText] = useState(value)
  const note = useSaveNote()
  useEffect(() => { setText(value) }, [value])
  const commit = (next: string) => void note.track(onSave(next.trim() === '' || next === fallback ? null : next))
  const save = useBlurSave({ text, setText, saved: value, commit })
  const useFallback = () => { setText(fallback); if (value !== fallback) commit(fallback) }
  return (
    <Modal
      title={title} width={640} onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" disabled={text === fallback} onClick={useFallback}>{fallbackLabel}</Button>
          <span className="grow" />
          <SaveNote state={note.state} />
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>
      )}
    >
      <textarea className="set-lines set-sheet-text" aria-label={title} spellCheck={false} value={text} onChange={(e) => { note.reset(); setText(e.target.value) }} {...save} />
    </Modal>
  )
}
