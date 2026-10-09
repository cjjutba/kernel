import { useEffect, useMemo, useRef, useState } from 'react'
import { EFFORTS, MODELS, type Effort, type ModelId } from '@shared/types'
import { actions } from '../../../store'
import { Icon } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { effortFor } from '@shared/effort'
import { effortLabel, nextEffort, useEffortMemory } from './modelPrefs'

export { EFFORTS }

/** The Effort row's flyout: the four levels with a check on the current one. Escape or ArrowLeft goes back to the models. */
function EffortMenu({ effort, at, onAt, onPick, onClose }: { effort: Effort; at: number; onAt: (i: number) => void; onPick: (e: Effort) => void; onClose: () => void }) {
  useLayer({ onEscape: onClose })
  return (
    <div className="menu pick-flyout" role="menu" aria-label="Effort">
      {EFFORTS.map((x, i) => (
        <button key={x.id} type="button" role="menuitemradio" aria-checked={x.id === effort} tabIndex={-1} className="menu-item pick-row" data-active={i === at}
          onMouseEnter={() => onAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(x.id)}>
          <span className="grow">{x.label}</span>
          {x.id === effort && <Icon name="check" size={14} />}
        </button>
      ))}
    </div>
  )
}

/**
 * Model and effort, as in Conductor (D-093). Type to search, arrow keys move, Enter picks. Each model shows the effort
 * you last used with it and comes back at that effort, else at `fallback`, the default effort, never the open chat's (D-130).
 * The caller remembers a picked effort. The Effort row opens the levels to its right (Enter or ArrowRight).
 * Ctrl+Cmd+1 to 4 pick a model and Cmd+Shift+/ cycles the effort; the workspace composer also takes them while it is closed.
 */
export function ModelPicker({ model, effort, fallback, onModel, onEffort, onClose, anchorRef }: { anchorRef: React.RefObject<HTMLElement | null>; model: ModelId; effort: Effort; fallback: Effort; onModel: (m: ModelId, effort: Effort) => void; onEffort: (e: Effort) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(() => Math.max(0, MODELS.findIndex((m) => m.id === model)))
  const [sub, setSub] = useState(false)
  const [subAt, setSubAt] = useState(() => Math.max(0, EFFORTS.findIndex((x) => x.id === effort)))
  const memory = useEffortMemory()
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return MODELS.map((m, i) => ({ ...m, n: i + 1 })).filter((m) => !needle || m.label.toLowerCase().includes(needle))
  }, [q])
  const effortRow = rows.length
  const rowEffort = (m: ModelId) => (m === model ? effort : effortFor(m, memory, fallback))

  const pickModel = (m: ModelId) => onModel(m, rowEffort(m))
  const pickEffort = (e: Effort) => { onEffort(e); setSub(false) }
  const openSub = () => { setSubAt(Math.max(0, EFFORTS.findIndex((x) => x.id === effort))); setSub(true) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.metaKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); const m = MODELS[Number(e.key) - 1]; if (m) pickModel(m.id); return }
    if (e.metaKey && e.shiftKey && (e.key === '/' || e.key === '?')) { e.preventDefault(); pickEffort(nextEffort(effort)); return }
    if (sub) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSubAt((i) => Math.min(EFFORTS.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSubAt((i) => Math.max(0, i - 1)) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setSub(false) }
      else if (e.key === 'Enter') { e.preventDefault(); pickEffort(EFFORTS[subAt].id) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(effortRow, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'ArrowRight' && at === effortRow) { e.preventDefault(); openSub() }
    else if (e.key === 'Enter') { e.preventDefault(); if (at === effortRow) openSub(); else if (rows[at]) pickModel(rows[at].id) }
  }

  return (
    <div ref={ref} className="menu cmp-pop model-pop" role="dialog" aria-label="Model and effort" onKeyDown={onKey}>
      <label className="pick-search">
        <Icon name="search" size={14} />
        <input aria-label="Search models" placeholder="Search models" autoComplete="off" spellCheck={false} value={q} onChange={(e) => { setQ(e.target.value); setAt(0); setSub(false) }} />
      </label>
      <div className="pick-body">
        <div role="listbox" aria-label="Models" className="pick-list">
          {rows.map((m, i) => (
            <button key={m.id} type="button" role="option" aria-selected={m.id === model} tabIndex={-1} className="menu-item pick-row" data-active={!sub && i === at}
              onMouseEnter={() => { setAt(i); setSub(false) }} onMouseDown={(e) => e.preventDefault()} onClick={() => pickModel(m.id)}>
              <span className="pick-glyph"><Icon name="claude" size={14} stroke={1.5} /></span>
              <span className="pick-name">{m.label}</span>
              <span className="pick-effort">{effortLabel(rowEffort(m.id))}</span>
              <span className="grow" />
              {m.id === model ? <span className="pick-check"><Icon name="check" size={14} stroke={1.6} /></span> : <span className="pick-kbd">^⌘{m.n}</span>}
            </button>
          ))}
          {!rows.length && <p className="pick-empty">No model matches "{q.trim()}".</p>}
        </div>
        <div className="menu-sep" />
        <div className="pick-effort-row">
          <button type="button" tabIndex={-1} className="menu-item pick-row" aria-haspopup="menu" aria-expanded={sub} data-active={sub || at === effortRow}
            onMouseEnter={() => { setAt(effortRow); openSub() }} onMouseDown={(e) => e.preventDefault()} onClick={() => (sub ? setSub(false) : openSub())}>
            <span className="grow">Effort</span>
            <span className="pick-effort">{effortLabel(effort)}</span>
            <Icon name="right" size={12} />
          </button>
          {sub && <EffortMenu effort={effort} at={subAt} onAt={setSubAt} onPick={pickEffort} onClose={() => setSub(false)} />}
        </div>
      </div>
      <div className="pick-foot">
        <button type="button" className="pick-link" onClick={() => { onClose(); actions.ui.go({ name: 'settings', page: 'models' }) }}><Icon name="sliders" size={13} />Edit</button>
        <span className="pick-hint"><kbd className="kbd">⌘⇧/</kbd>Cycle effort</span>
      </div>
    </div>
  )
}
