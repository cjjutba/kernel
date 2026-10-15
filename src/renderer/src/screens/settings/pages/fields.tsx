import './reviews.css'
import { useEffect, useState } from 'react'
import { SaveNote, clampText, useBlurSave, useSaveNote, type SaveResult } from '../kit'

/**
 * A whole number beside its unit: Stop after 2 review rounds, Size limit 200 lines. It saves when the field loses focus or Enter
 * is pressed, or when the field goes away with text still in it. Text that isn't a whole number from `min` puts the saved value back, and so does a save that fails. Escape puts the saved value back.
 */
export function NumberField({ label, value, unit, min = 1, disabled, onSave }: { label: string; value: number; unit: string; min?: number; disabled?: boolean; onSave: (n: number) => SaveResult<number> }) {
  const [text, setText] = useState(String(value))
  const note = useSaveNote()
  useEffect(() => { setText(String(value)) }, [value])
  const save = useBlurSave({
    text, setText, saved: String(value),
    commit: (raw) => {
      const t = raw.trim()
      const n = Number(t)
      if (/^\d+$/.test(t) && n >= min) { if (n !== value) void note.track(onSave(n), (saved) => clampText(n, saved)) } else setText(String(value))
    }
  })
  return (
    <div className="rv-number">
      <SaveNote state={note.state} />
      <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} aria-label={label} disabled={disabled} value={text}
        onChange={(e) => { note.reset(); setText(e.target.value) }} {...save} onKeyDown={(e) => { save.onKeyDown(e); if (e.key === 'Enter') e.currentTarget.blur() }} />
      <span className="rv-unit">{unit}</span>
    </div>
  )
}
