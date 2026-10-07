import './settings.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Kbd } from '../../ui'

/** One settings page: the title, an optional intro and its sections. */
export function Page({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <div className="set-scroll">
      <div className="set-page">
        <div>
          <h1>{title}</h1>
          {intro && <p className="set-intro">{intro}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
    </section>
  )
}

/** A label and optional description on the left, the control on the right. `full` puts the control on its own line. */
export function Row({ label, desc, children, full }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; full?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <span className="set-label">{label}</span>
        {desc && <span className="set-desc">{desc}</span>}
      </div>
      {children}
      {full && <div className="set-full">{full}</div>}
    </div>
  )
}

export function Keys({ keys }: { keys: string[] }) {
  return <span className="set-keys">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
}

/** A list with one entry per line (Always ask before, Never allow). Saved when the field loses focus. */
export function LinesField({ label, value, onSave }: { label: string; value: string[]; onSave: (lines: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'))
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setText(value.join('\n')) }, [value.join('\n')])
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }, [text])
  const commit = () => {
    const next = text.split('\n').map((l) => l.trim()).filter(Boolean)
    if (next.join('\n') !== value.join('\n')) onSave(next)
  }
  return <textarea ref={ref} className="set-lines" aria-label={label} rows={Math.max(2, value.length)} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
}

/** A short list on one line, comma separated (Protected branches). */
export function ListField({ label, value, onSave }: { label: string; value: string[]; onSave: (items: string[]) => void }) {
  const [text, setText] = useState(value.join(', '))
  useEffect(() => { setText(value.join(', ')) }, [value.join(',')])
  const commit = () => {
    const next = text.split(',').map((l) => l.trim()).filter(Boolean)
    if (next.join(',') !== value.join(',')) onSave(next)
  }
  return <input className="set-inline" aria-label={label} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}
