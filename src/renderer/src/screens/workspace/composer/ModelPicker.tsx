import { useEffect, useMemo, useRef, useState } from 'react'
import { MODELS, type Effort, type ModelId } from '@shared/types'
import { Icon, useEscape } from '../../../ui'

export const EFFORTS: { id: Effort; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }]

/** Model and effort, with a search box. Arrow keys move, Enter picks, Escape closes. */
export function ModelPicker({ model, effort, onModel, onEffort, onClose, anchorRef }: { anchorRef: React.RefObject<HTMLElement | null>; model: ModelId; effort: Effort; onModel: (m: ModelId) => void; onEffort: (e: Effort) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchorRef.current?.contains(t)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose, anchorRef])
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const models = MODELS.filter((m) => !needle || m.label.toLowerCase().includes(needle)).map((m) => ({ key: m.id, label: m.label, on: m.id === model, pick: () => onModel(m.id) }))
    const efforts = EFFORTS.filter((e) => !needle || `effort ${e.label}`.toLowerCase().includes(needle)).map((e) => ({ key: `effort-${e.id}`, label: `Effort: ${e.label}`, on: e.id === effort, pick: () => onEffort(e.id) }))
    return [...models, ...efforts]
  }, [q, model, effort, onModel, onEffort])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); rows[at]?.pick() }
  }

  return (
    <div ref={ref} className="menu cmp-pop" role="dialog" aria-label="Model and effort" onKeyDown={onKey}>
      <div className="pick-search"><Icon name="search" size={13} /><input aria-label="Search models and effort" placeholder="Search" autoComplete="off" value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} /></div>
      <div role="listbox" aria-label="Models and effort">
        {rows.map((r, i) => (
          <button key={r.key} type="button" role="option" aria-selected={r.on} className="menu-item pick-row" data-active={i === at} onMouseEnter={() => setAt(i)} onClick={r.pick}>
            <span className="grow ellipsis">{r.label}</span>
            {r.on && <Icon name="check" size={13} />}
          </button>
        ))}
        {!rows.length && <p className="muted" style={{ margin: '8px', fontSize: 12.5 }}>Nothing matches “{q}”.</p>}
      </div>
    </div>
  )
}
