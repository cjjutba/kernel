import { useRef, type KeyboardEvent } from 'react'

const LINE = 20
const PAD = 8

/** How many numbered lines a text takes. A trailing newline opens one more, the way an editor shows it. */
export function lineCount(text: string): number {
  return text.split('\n').length
}

/**
 * A multi-line text field with a line-number gutter that scrolls with it, for shell scripts (KERNEL-914). It grows with its text from `minLines`
 * up to `maxLines`, then scrolls. Lines don't wrap, so a number is a line of the text. Tab moves focus on. Cmd+Enter calls `onSubmit`.
 * `onBlur` and `onKeyDown` reach the text area, for a field that saves when it loses focus (KERNEL-721).
 */
export function CodeLines({ value, onChange, label, labelledBy, id, placeholder, minLines = 1, maxLines = 24, disabled, invalid, describedBy, onSubmit, onBlur, onKeyDown }: {
  value: string; onChange: (next: string) => void; label?: string; labelledBy?: string; id?: string; placeholder?: string; minLines?: number; maxLines?: number
  disabled?: boolean; invalid?: boolean; describedBy?: string; onSubmit?: () => void; onBlur?: () => void; onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const gutter = useRef<HTMLDivElement>(null)
  const n = lineCount(value)
  const rows = Math.min(Math.max(n, minLines), maxLines)
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e)
    if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit() }
  }
  return (
    <div className="code-lines" data-invalid={invalid ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined} style={{ height: rows * LINE + PAD * 2 }}>
      <div className="code-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: Math.max(n, rows) }, (_, i) => <span key={i}>{i < n ? i + 1 : ''}</span>)}
      </div>
      <textarea
        id={id} className="code-text" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-invalid={invalid || undefined}
        spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" placeholder={placeholder} disabled={disabled} value={value}
        onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onBlur={onBlur} onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop }}
      />
    </div>
  )
}
