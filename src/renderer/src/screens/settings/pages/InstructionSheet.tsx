import { useEffect, useRef } from 'react'
import type { PrInstructions } from '@shared/types'
import { Button, Modal } from '../../../ui'
import './system.css'
import { SaveNote, useBlurSave, useFieldText, useSaveNote, type SaveResult } from '../kit'

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
 * field loses focus, on Done or on a press on the scrim, with the Saved note in the footer. Escape in the field closes the sheet and drops
 * text not yet saved (KERNEL-721).
 * Use default puts the fallback back and saves it at once. A save sends the text, or `null` when it is empty or the fallback.
 */
export function InstructionSheet({ title, note: lead, value, fallback, fallbackLabel = 'Use default', onSave, onClose }: {
  title: string; note?: string; value: string; fallback: string; fallbackLabel?: string; onSave: (text: string | null) => SaveResult; onClose: () => void
}) {
  const [text, setText] = useFieldText(value)
  const note = useSaveNote()
  const commit = (next: string) => void note.track(onSave(next.trim() === '' || next === fallback ? null : next))
  const save = useBlurSave({ text, setText, saved: value, commit })
  const useFallback = () => { setText(fallback); if (value !== fallback) commit(fallback) }
  // The modal takes Escape before the field sees it and plays its exit, which can take focus out of the field. So the sheet notes an
  // Escape pressed in the field with a window listener of its own, which still runs after the modal's: then the blur during the exit
  // saves nothing, and neither does the unmount after it. Any other close, such as a press on the scrim, saves what was typed.
  const field = useRef<HTMLTextAreaElement>(null)
  const escaped = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && e.target === field.current) escaped.current = true }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <Modal
      title={title} width={640} onClose={() => { if (escaped.current) save.cancel(); onClose() }}
      footer={(
        <>
          <Button variant="ghost" disabled={text === fallback} onClick={useFallback}>{fallbackLabel}</Button>
          <span className="grow" />
          <SaveNote state={note.state} />
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>
      )}
    >
      <div className="modal-body sys-sheet">
        {lead && <p className="sys-sheet-lead">{lead}</p>}
        <textarea ref={field} className="set-lines set-sheet-text" aria-label={title} spellCheck={false} value={text} onChange={(e) => { note.reset(); setText(e.target.value) }} onBlur={() => { if (!escaped.current) save.onBlur() }} onKeyDown={save.onKeyDown} />
      </div>
    </Modal>
  )
}
