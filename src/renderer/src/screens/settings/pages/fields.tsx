import './reviews.css'
import { useEffect, useState } from 'react'

/**
 * A whole number beside its unit: Stop after 2 review rounds, Size limit 200 lines. It saves when the field loses focus or Enter
 * is pressed. Text that isn't a whole number from `min` puts the saved value back, and so does a save that fails.
 */
export function NumberField({ label, value, unit, min = 1, disabled, onSave }: { label: string; value: number; unit: string; min?: number; disabled?: boolean; onSave: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const commit = () => {
    const t = text.trim()
    const n = Number(t)
    if (/^\d+$/.test(t) && n >= min) { if (n !== value) onSave(n) } else setText(String(value))
  }
  return (
    <div className="rv-number">
      <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} aria-label={label} disabled={disabled} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      <span className="rv-unit">{unit}</span>
    </div>
  )
}

/** Fixed pills that can't be edited, such as the paths that always come to you. `mono` sets a file name in mono. */
export function Pills({ label, items }: { label: string; items: { text: string; mono?: boolean }[] }) {
  return <ul className="rv-pills" aria-label={label}>{items.map((i) => <li key={i.text} data-mono={i.mono || undefined}>{i.text}</li>)}</ul>
}
