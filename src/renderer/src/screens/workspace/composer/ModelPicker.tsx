import { useEffect, useMemo, useRef, useState } from 'react'
import { EFFORT_LABELS, EFFORTS, MODELS, type Effort, type Provider } from '@shared/types'
import { actions } from '../../../store'
import { ClaudeMark, Icon } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { effortFor } from '@shared/effort'
import { effortLabel, nextEffort, useEffortMemory } from './modelPrefs'
import { effortsOf, fitEffort, providerLabel, useProviderModels } from './providerModels'

export { EFFORTS }

/** The Effort row's flyout: the model's levels with a check on the current one. Escape or ArrowLeft goes back to the models. */
function EffortMenu({ efforts, effort, at, onAt, onPick, onClose }: { efforts: Effort[]; effort: Effort; at: number; onAt: (i: number) => void; onPick: (e: Effort) => void; onClose: () => void }) {
  useLayer({ onEscape: onClose })
  return (
    <div className="menu pick-flyout" role="menu" aria-label="Effort">
      {efforts.map((x, i) => (
        <button key={x} type="button" role="menuitemradio" aria-checked={x === effort} tabIndex={-1} className="menu-item pick-row" data-active={i === at}
          onMouseEnter={() => onAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(x)}>
          <span className="grow">{EFFORT_LABELS[x]}</span>
          {x === effort && <Icon name="check" size={14} />}
        </button>
      ))}
    </div>
  )
}

/** A row of the picker: a model on a provider, and `n` for Claude's ^⌘ shortcut. */
interface Row { provider: Provider; id: string; label: string; n?: number }

/**
 * Model and effort, as in Conductor (D-093). Type to search, arrow keys move, Enter picks. Each model shows the effort
 * you last used with it and comes back at that effort, else at `fallback`, the default effort, never the open chat's (D-130).
 * The caller remembers a picked effort. The Effort row opens the levels to its right (Enter or ArrowRight).
 * Ctrl+Cmd+1 to 4 pick a Claude model and Cmd+Shift+/ cycles the effort; the workspace composer also takes them while it is closed.
 *
 * With `grouped` the models come under their provider (WorkspaceModelPicker.png, KERNEL-406). A model on the other provider
 * can't take over a started chat, so it says New chat and `onNewChat` opens a tab on it.
 */
export function ModelPicker({ provider = 'claude', grouped = false, started = false, model, effort, fallback, onModel, onEffort, onNewChat, onClose, anchorRef }: {
  anchorRef: React.RefObject<HTMLElement | null>; provider?: Provider; grouped?: boolean; started?: boolean; model: string; effort: Effort; fallback: Effort
  onModel: (m: string, effort: Effort) => void; onEffort: (e: Effort) => void; onNewChat?: (provider: Provider, m: string, effort: Effort) => void; onClose: () => void
}) {
  const codex = useProviderModels('codex')
  const claude = useProviderModels('claude')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const own = listOf(provider)
  const efforts = effortsOf(model, own)
  const [q, setQ] = useState('')
  const all: Row[] = useMemo(() => [
    ...MODELS.map((m, i) => ({ provider: 'claude' as const, id: m.id, label: m.label, n: i + 1 })),
    ...(grouped || provider === 'codex' ? codex.map((m) => ({ provider: 'codex' as const, id: m.id, label: m.label })) : [])
  ], [codex, grouped, provider])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((m) => !needle || m.label.toLowerCase().includes(needle))
  }, [q, all])
  const [at, setAt] = useState(() => Math.max(0, all.findIndex((m) => m.id === model)))
  const [sub, setSub] = useState(false)
  const [subAt, setSubAt] = useState(() => Math.max(0, efforts.indexOf(effort)))
  const memory = useEffortMemory()
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])

  const effortRow = rows.length
  const rowEffort = (m: Row) => (m.id === model ? effort : fitEffort(effortFor(m.id, memory, fallback), m.id, listOf(m.provider)))
  /** The other provider's model can't take over a chat that has started: it opens a new chat on it. */
  const elsewhere = (m: Row) => m.provider !== provider && started

  const pickModel = (m: Row) => (elsewhere(m) ? onNewChat?.(m.provider, m.id, rowEffort(m)) : onModel(m.id, rowEffort(m)))
  const pickEffort = (e: Effort) => { onEffort(e); setSub(false) }
  const openSub = () => { setSubAt(Math.max(0, efforts.indexOf(effort))); setSub(true) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.metaKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); const m = all.find((r) => r.n === Number(e.key)); if (m) pickModel(m); return }
    if (e.metaKey && e.shiftKey && (e.key === '/' || e.key === '?')) { e.preventDefault(); pickEffort(nextEffort(effort, efforts)); return }
    if (sub) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSubAt((i) => Math.min(efforts.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSubAt((i) => Math.max(0, i - 1)) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setSub(false) }
      else if (e.key === 'Enter') { e.preventDefault(); pickEffort(efforts[subAt]) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(effortRow, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'ArrowRight' && at === effortRow) { e.preventDefault(); openSub() }
    else if (e.key === 'Enter') { e.preventDefault(); if (at === effortRow) openSub(); else if (rows[at]) pickModel(rows[at]) }
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
            <div key={`${m.provider}:${m.id}`} role="presentation">
              {grouped && (i === 0 || rows[i - 1].provider !== m.provider) && <p className="pick-group" role="presentation">{providerLabel(m.provider)}</p>}
              <button type="button" role="option" aria-selected={m.id === model} tabIndex={-1} className="menu-item pick-row" data-active={!sub && i === at}
                onMouseEnter={() => { setAt(i); setSub(false) }} onMouseDown={(e) => e.preventDefault()} onClick={() => pickModel(m)}>
                {!grouped && <span className="pick-glyph"><ClaudeMark size={14} /></span>}
                <span className="pick-name">{m.label}</span>
                {!elsewhere(m) && <span className="pick-effort">{effortLabel(rowEffort(m))}</span>}
                <span className="grow" />
                {m.id === model ? <span className="pick-check"><Icon name="check" size={14} /></span>
                  : elsewhere(m) ? <span className="pick-kbd">New chat</span>
                  : m.n ? <span className="pick-kbd">^⌘{m.n}</span> : null}
              </button>
            </div>
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
          {sub && <EffortMenu efforts={efforts} effort={effort} at={subAt} onAt={setSubAt} onPick={pickEffort} onClose={() => setSub(false)} />}
        </div>
      </div>
      <div className="pick-foot">
        <button type="button" className="pick-link" onClick={() => { onClose(); actions.ui.go({ name: 'settings', page: 'models' }) }}><Icon name="sliders" size={14} />Edit</button>
        <span className="pick-hint"><kbd className="kbd">⌘⇧/</kbd>Cycle effort</span>
      </div>
    </div>
  )
}
