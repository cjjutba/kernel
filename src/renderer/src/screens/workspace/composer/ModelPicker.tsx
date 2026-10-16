import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EFFORT_LABELS, EFFORTS, type Effort, type Provider } from '@shared/types'
import { actions } from '../../../store'
import { arrowRow, Icon, ProviderMark } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { effortFor } from '@shared/effort'
import { effortLabel, nextEffort, useEffortMemory } from './modelPrefs'
import { useFavoriteModels, toggleFavoriteModel } from './favoriteModels'
import { effortsOf, fitEffort, providerLabel, useProviderModels } from './providerModels'
import { isCycleEffortKey, shortcutNumber } from './modelShortcuts'

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

/** The Legacy models row's flyout, built like the Effort one: the older models as rows like the main list's. Escape or ArrowLeft goes back to the Legacy row. */
function LegacyMenu({ style, onClose, children }: { style: React.CSSProperties; onClose: () => void; children: React.ReactNode }) {
  useLayer({ onEscape: onClose })
  return <div className="menu pick-flyout pick-flyout-legacy" role="listbox" aria-label="Legacy models" style={style}>{children}</div>
}

/** A row of the picker: a model on a provider, and `n` for its ^⌘ shortcut. */
interface Row { provider: Provider; id: string; label: string; legacy: boolean; n?: number }
type Item = { kind: 'model'; row: Row } | { kind: 'legacy'; rows: Row[] }
type Tab = 'favorites' | Provider

/**
 * Model and effort, as in Conductor (D-093) with t3's rail. The rail switches between Favorites and the providers, and the list shows
 * only that tab's models, the older ones folded under one Legacy models row. Type to search (legacy models included), arrow keys
 * move, Enter picks. Each model shows the effort you last used with it and comes back at that effort, else at `fallback`, the default
 * effort, never the open chat's (D-130). The caller remembers a picked effort. The Effort row opens the levels to its right and the Legacy
 * models row opens the older models to its right, one flyout at a time. The Legacy flyout opens on click, Enter or ArrowRight, never on hover,
 * so the list never grows. A chat on a legacy model shows its name on the Legacy row.
 * Ctrl+Cmd+1 to 9 pick the Nth current model of the chat's provider, Claude or Codex, and the rows show the key they answer to. Cmd+D stars the
 * model under the cursor and Cmd+Shift+/ cycles the effort. Both composers take the model and effort keys while the picker is closed (useModelKeys).
 *
 * The picker opens on the current model's provider. Both providers show when Codex is in use (`grouped`). A model on the other provider
 * can't take over a chat that has started, so that provider's rail icon is dimmed and says to start a new chat (KERNEL-406).
 */
export function ModelPicker({ provider = 'claude', grouped = false, started = false, model, effort, fallback, onModel, onEffort, onClose, anchorRef }: {
  anchorRef: React.RefObject<HTMLElement | null>; provider?: Provider; grouped?: boolean; started?: boolean; model: string; effort: Effort; fallback: Effort
  onModel: (m: string, effort: Effort) => void; onEffort: (e: Effort) => void; onClose: () => void
}) {
  const codex = useProviderModels('codex')
  const claude = useProviderModels('claude')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const own = listOf(provider)
  const efforts = effortsOf(model, own)
  const favorites = useFavoriteModels()
  const providers: Provider[] = grouped || provider === 'codex' ? ['claude', 'codex'] : ['claude']
  /** The other provider can't take over a chat that has started. */
  const locked = (p: Provider) => started && p !== provider
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>(provider)
  // A row shows ^⌘N only when that key works: it picks the Nth current model of the chat's own provider (useModelKeys).
  const all: Row[] = useMemo(() => {
    const row = (p: Provider, m: { id: string; label: string; legacy?: boolean }): Row => ({ provider: p, id: m.id, label: m.label, legacy: !!m.legacy, n: shortcutNumber({ id: m.id, provider: p }, provider, own) })
    return [...claude.map((m) => row('claude', m)), ...(providers.includes('codex') ? codex.map((m) => row('codex', m)) : [])]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claude, codex, grouped, provider])
  const current = all.find((m) => m.id === model)
  const needle = q.trim().toLowerCase()
  const items: Item[] = useMemo(() => {
    const pool = tab === 'favorites' ? all.filter((m) => favorites.includes(m.id) && !locked(m.provider)) : all.filter((m) => m.provider === tab)
    const hits = needle ? pool.filter((m) => m.label.toLowerCase().includes(needle)) : pool
    const model = (row: Row): Item => ({ kind: 'model', row })
    if (tab === 'favorites' || needle) return hits.map(model)
    const old = hits.filter((m) => m.legacy)
    return [...hits.filter((m) => !m.legacy).map(model), ...(old.length ? [{ kind: 'legacy' as const, rows: old }] : [])]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, tab, favorites, needle, started, provider])
  // A chat on a legacy model starts with the cursor on the Legacy row, which names that model.
  const [at, setAt] = useState(() => Math.max(0, items.findIndex((i) => (i.kind === 'model' ? i.row.id === model : i.rows.some((r) => r.id === model)))))
  const [flyout, setFlyout] = useState<'effort' | 'legacy' | null>(null)
  const sub = flyout === 'effort'
  const legacyIdx = items.findIndex((i) => i.kind === 'legacy')
  const legacyRows = (items[legacyIdx] as Extract<Item, { kind: 'legacy' }> | undefined)?.rows ?? []
  const legacyShown = flyout === 'legacy' && legacyRows.length > 0
  const [legacyAt, setLegacyAt] = useState(0)
  const [legacyStyle, setLegacyStyle] = useState<React.CSSProperties>({})
  const [subAt, setSubAt] = useState(() => Math.max(0, efforts.indexOf(effort)))
  const memory = useEffortMemory()
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])
  // The popover opens upward from the composer, so it gets the space between its bottom and the window's top.
  const [maxHeight, setMaxHeight] = useState<number>()
  useLayoutEffect(() => {
    const fit = () => { if (ref.current) setMaxHeight(Math.max(160, ref.current.getBoundingClientRect().bottom - 12)) }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  useEffect(() => { ref.current?.querySelector('.pick-list [data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [at, items])
  useEffect(() => { if (legacyShown) ref.current?.querySelector('.pick-flyout-legacy [data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [legacyAt, legacyShown])
  // The flyout's bottom edge sits on the Legacy row's, like the Effort flyout's, and it grows upward into the space above.
  useLayoutEffect(() => {
    if (!legacyShown || !ref.current) return
    const row = ref.current.querySelector('.pick-legacy')?.getBoundingClientRect()
    if (!row) return
    const pop = ref.current.getBoundingClientRect()
    setLegacyStyle({ bottom: pop.bottom - row.bottom - 7, maxHeight: Math.max(160, row.bottom + 6 - 12) })
  }, [legacyShown, items])

  const effortRow = items.length
  const rowEffort = (m: Row) => (m.id === model ? effort : fitEffort(effortFor(m.id, memory, fallback), m.id, listOf(m.provider)))
  const pickModel = (m: Row) => { if (!locked(m.provider)) onModel(m.id, rowEffort(m)) }
  const setSub = (on: boolean) => setFlyout(on ? 'effort' : null)
  const pickEffort = (e: Effort) => { onEffort(e); setSub(false) }
  const openSub = () => { setSubAt(Math.max(0, efforts.indexOf(effort))); setSub(true) }
  const openLegacy = () => { setLegacyAt(Math.max(0, legacyRows.findIndex((r) => r.id === model))); setFlyout('legacy') }
  const goTab = (t: Tab) => { if (t !== 'favorites' && locked(t)) return; setTab(t); setAt(0); setSub(false) }
  const press = (i: Item | undefined) => { if (i?.kind === 'legacy') (legacyShown ? setFlyout(null) : openLegacy()); else if (i) pickModel(i.row) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.metaKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const m = all.find((r) => r.n === Number(e.key)); if (m) pickModel(m); return }
    if (isCycleEffortKey(e)) { e.preventDefault(); pickEffort(nextEffort(effort, efforts)); return }
    if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      const it = items[at]
      if (legacyShown) { const r = legacyRows[legacyAt]; if (r) toggleFavoriteModel(r.id) }
      else if (!sub && it?.kind === 'model') toggleFavoriteModel(it.row.id)
      return
    }
    if (legacyShown) {
      const to = arrowRow(e, legacyAt, legacyRows.length)
      if (to !== null) { e.preventDefault(); setLegacyAt(to) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setFlyout(null) }
      else if (e.key === 'Enter') { e.preventDefault(); const r = legacyRows[legacyAt]; if (r) pickModel(r) }
      return
    }
    if (sub) {
      const to = arrowRow(e, subAt, efforts.length)
      if (to !== null) { e.preventDefault(); setSubAt(to) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setSub(false) }
      else if (e.key === 'Enter') { e.preventDefault(); pickEffort(efforts[subAt]) }
      return
    }
    const to = arrowRow(e, at, effortRow + 1)
    if (to !== null) { e.preventDefault(); setAt(to) }
    else if (e.key === 'ArrowRight' && at === effortRow) { e.preventDefault(); openSub() }
    else if (e.key === 'ArrowRight' && items[at]?.kind === 'legacy') { e.preventDefault(); openLegacy() }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[at]; if (at === effortRow) openSub(); else if (it?.kind === 'legacy') openLegacy(); else press(it) }
  }

  /** A model row, in the list and in the Legacy flyout alike. */
  const modelRow = (row: Row, active: boolean, onEnter: () => void) => (
    <div key={`${row.provider}:${row.id}`} className="pick-item" role="presentation" data-active={active} onMouseEnter={onEnter}>
      <button type="button" role="option" aria-selected={row.id === model} tabIndex={-1} className="menu-item pick-row" data-selected={row.id === model}
        onMouseDown={(e) => e.preventDefault()} onClick={() => pickModel(row)}>
        <ProviderMark provider={row.provider} size={16} />
        <span className="pick-name">{row.label}</span>
        <span className="pick-effort">{effortLabel(rowEffort(row))}</span>
        <span className="grow" />
        {row.id === model ? <span className="pick-check"><Icon name="check" size={14} /></span> : row.n ? <span className="pick-kbd">^⌘{row.n}</span> : null}
      </button>
      <button type="button" tabIndex={-1} className="pick-star" aria-pressed={favorites.includes(row.id)} aria-label={`${favorites.includes(row.id) ? 'Remove' : 'Add'} ${row.label} ${favorites.includes(row.id) ? 'from' : 'to'} favorites`}
        data-tip-kbd="⌘D" onMouseDown={(e) => e.preventDefault()} onClick={() => toggleFavoriteModel(row.id)}>
        <Icon name="star" size={14} />
      </button>
    </div>
  )
  const tabs: { id: Tab; label: string }[] = [{ id: 'favorites', label: 'Favorites' }, ...providers.map((p) => ({ id: p as Tab, label: providerLabel(p) }))]
  const empty = needle ? `No model matches "${q.trim()}".` : tab === 'favorites' ? 'Star a model to keep it here.' : 'No models to show.'

  return (
    <div ref={ref} className="menu cmp-pop model-pop" role="dialog" aria-label="Model and effort" onKeyDown={onKey} style={{ maxHeight }}>
      <label className="pick-search">
        <Icon name="search" size={14} />
        <input aria-label="Search models" placeholder="Search models" autoComplete="off" spellCheck={false} value={q} onChange={(e) => { setQ(e.target.value); setAt(0); setFlyout(null) }} />
      </label>
      <div className="pick-body">
        <div className="pick-split">
          <div className="pick-rail" role="tablist" aria-orientation="vertical" aria-label="Providers">
            {tabs.map((t) => {
              const off = t.id !== 'favorites' && locked(t.id)
              return (
                <button key={t.id} type="button" role="tab" className="pick-tab" aria-selected={tab === t.id} aria-label={t.label} aria-disabled={off || undefined}
                  data-tip={off ? `${t.label} is unavailable in this chat. Start a new chat to switch providers.` : t.label} data-tip-align="start"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => goTab(t.id)}>
                  {t.id === 'favorites' ? <Icon name="star" size={16} /> : <ProviderMark provider={t.id} size={16} />}
                </button>
              )
            })}
          </div>
          <div role="listbox" aria-label="Models" className="pick-list">
            {items.map((it, i) => it.kind === 'legacy' ? (
              <button key="legacy" type="button" tabIndex={-1} className="menu-item pick-row pick-legacy" aria-haspopup="listbox" aria-expanded={legacyShown} data-active={!sub && !legacyShown && i === at} data-open={legacyShown}
                onMouseEnter={() => { setAt(i); if (flyout === 'effort') setFlyout(null) }} onMouseDown={(e) => e.preventDefault()} onClick={() => (legacyShown ? setFlyout(null) : (setAt(i), openLegacy()))}>
                <span className="pick-name">Legacy models</span>
                <span className="pick-count">{it.rows.length}</span>
                <span className="grow" />
                {it.rows.find((r) => r.id === model) && <span className="pick-effort">{it.rows.find((r) => r.id === model)?.label}</span>}
                <Icon name="right" size={14} />
              </button>
            ) : modelRow(it.row, !sub && !legacyShown && i === at, () => { setAt(i); setFlyout(null) }))}
            {!items.length && <p className="pick-empty">{empty}</p>}
          </div>
        </div>
        <div className="menu-sep" />
        <div className="pick-effort-row">
          <button type="button" tabIndex={-1} className="menu-item pick-row pick-effort-btn" aria-haspopup="menu" aria-expanded={sub} data-active={!sub && !legacyShown && at === effortRow} data-open={sub}
            onMouseEnter={() => { setAt(effortRow); openSub() }} onMouseDown={(e) => e.preventDefault()} onClick={() => (sub ? setSub(false) : openSub())}>
            <span className="pick-name">Effort</span>
            <span className="grow" />
            <span className="pick-effort">{effortLabel(effort)}</span>
            <Icon name="right" size={14} />
          </button>
          {sub && <EffortMenu efforts={efforts} effort={effort} at={subAt} onAt={setSubAt} onPick={pickEffort} onClose={() => setSub(false)} />}
        </div>
      </div>
      {legacyShown && (
        <LegacyMenu style={legacyStyle} onClose={() => setFlyout(null)}>
          {legacyRows.map((r, i) => modelRow(r, i === legacyAt, () => setLegacyAt(i)))}
        </LegacyMenu>
      )}
      <div className="pick-foot">
        <button type="button" className="pick-link" onClick={() => { onClose(); actions.ui.go({ name: 'settings', page: 'models' }) }}><Icon name="sliders" size={14} />Edit</button>
        <span className="pick-hint"><kbd className="kbd">⌘⇧/</kbd>Cycle effort</span>
      </div>
    </div>
  )
}
