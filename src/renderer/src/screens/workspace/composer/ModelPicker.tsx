import { useEffect, useMemo, useRef, useState } from 'react'
import { MODELS, type Effort, type ModelId } from '@shared/types'
import { actions } from '../../../store'
import { useEscape } from '../../../ui'

export const EFFORTS: { id: Effort; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }]

/**
 * Model and effort (NewWorkspaceModel.png). Type to search the models, arrow keys move, Enter picks.
 * Ctrl+Cmd+1 to 4 pick a model and Cmd+Shift+/ cycles the effort while it is open.
 */
export function ModelPicker({ model, effort, onModel, onEffort, onClose, anchorRef }: { anchorRef: React.RefObject<HTMLElement | null>; model: ModelId; effort: Effort; onModel: (m: ModelId) => void; onEffort: (e: Effort) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(() => Math.max(0, MODELS.findIndex((m) => m.id === model)))
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchorRef.current?.contains(t)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose, anchorRef])

  const effortLabel = EFFORTS.find((x) => x.id === effort)?.label ?? effort
  const cycle = () => onEffort(EFFORTS[(EFFORTS.findIndex((x) => x.id === effort) + 1) % EFFORTS.length].id)
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return MODELS.map((m, i) => ({ ...m, n: i + 1 })).filter((m) => !needle || m.label.toLowerCase().includes(needle))
  }, [q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.metaKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); const m = MODELS[Number(e.key) - 1]; if (m) onModel(m.id); return }
    if (e.metaKey && e.shiftKey && (e.key === '/' || e.key === '?')) { e.preventDefault(); cycle(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[at]) onModel(rows[at].id) }
  }

  return (
    <div ref={ref} className="menu cmp-pop model-pop" role="dialog" aria-label="Model and effort" onKeyDown={onKey}>
      <input className="pick-search" aria-label="Search models" placeholder="Search models" autoComplete="off" value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} />
      <div className="pick-body" role="listbox" aria-label="Models">
        {rows.map((m, i) => (
          <button key={m.id} type="button" role="option" aria-selected={m.id === model} className="menu-item pick-row" data-active={i === at} onMouseEnter={() => setAt(i)} onClick={() => onModel(m.id)}>
            <span style={{ fontWeight: 500 }}>{m.label}</span>
            <span className="grow muted">{m.id === model ? effortLabel : ''}</span>
            <span className="muted" style={{ fontSize: 12 }}>{m.id === model ? 'Selected' : `^⌘${m.n}`}</span>
          </button>
        ))}
        {!rows.length && <p className="muted" style={{ margin: '8px', fontSize: 12.5 }}>No model matches “{q}”.</p>}
        <div className="menu-sep" />
        <button type="button" className="menu-item pick-row" onClick={cycle}><span className="grow">Effort</span><span className="muted">{effortLabel}</span></button>
      </div>
      <div className="pick-foot">
        <button type="button" className="pick-link" onClick={() => { onClose(); actions.ui.go({ name: 'settings', page: 'models' }) }}>Edit defaults</button>
        <span>⌘⇧/ cycle effort</span>
      </div>
    </div>
  )
}
