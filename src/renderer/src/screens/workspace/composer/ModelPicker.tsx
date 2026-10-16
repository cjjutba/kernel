import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { COMPACT_WINDOWS, EFFORT_LABELS, EFFORTS, type CompactWindow, type Effort, type Provider } from '@shared/types'
import { actions } from '../../../store'
import { arrowRow, Icon, ProviderMark } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { effortFor } from '@shared/effort'
import { effortLabel, nextEffort, useEffortMemory } from './modelPrefs'
import { useFavoriteModels, toggleFavoriteModel } from './favoriteModels'
import { COMPACT_LABELS, effortsOf, fitEffort, providerLabel, useProviderModels } from './providerModels'
import { isCycleEffortKey, shortcutNumber } from './modelShortcuts'

export { EFFORTS }

/** A row's flyout: its choices with a check on the current one. Escape or ArrowLeft goes back to the models. */
function ChoiceMenu({ label, options, value, at, onAt, onPick, onClose, flip }: { label: string; options: { id: string; label: string }[]; value: string; at: number; onAt: (i: number) => void; onPick: (id: string) => void; onClose: () => void; flip?: boolean }) {
  useLayer({ onEscape: onClose })
  return (
    <div className="menu pick-flyout" role="menu" aria-label={label} data-flip={flip ? 'left' : undefined}>
      {options.map((x, i) => (
        <button key={x.id} type="button" role="menuitemradio" aria-checked={x.id === value} tabIndex={-1} className="menu-item pick-row" data-active={i === at}
          onMouseEnter={() => onAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(x.id)}>
          <span className="grow">{x.label}</span>
          {x.id === value && <Icon name="check" size={14} />}
        </button>
      ))}
    </div>
  )
}

/** The Legacy models row's flyout, built like the Effort one: the older models as rows like the main list's. Escape or ArrowLeft goes back to the Legacy row. */
function LegacyMenu({ style, flip, onClose, children }: { style: React.CSSProperties; flip: boolean; onClose: () => void; children: React.ReactNode }) {
  useLayer({ onEscape: onClose })
  return <div className="menu pick-flyout pick-flyout-legacy" role="listbox" aria-label="Legacy models" data-flip={flip ? 'left' : undefined} style={style}>{children}</div>
}

/** A row of the picker: a model on a provider, and `n` for its ^⌘ shortcut. */
interface Row { provider: Provider; id: string; label: string; legacy: boolean; n?: number }
type Item = { kind: 'model'; row: Row } | { kind: 'legacy'; rows: Row[] }
type Tab = 'favorites' | Provider

/**
 * Model and effort (D-093) with t3's rail. The rail switches between Favorites and the providers, and the list shows
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
 *
 * `variant="settings"` is the role picker in Settings, Models (KERNEL-988, KERNEL-995): the rail lists Claude and Codex with neither locked, and favorites,
 * ^⌘N hints, footer and their keys are gone. The Effort row stays, and a Claude role also gets a Compact at row (`compact`, `onCompact`). Each model
 * row shows the effort the role would get on it, `fitEffort(effort, model)`. A flyout opens to the left when there is no room on the right.
 * `placement="down"` opens it under its anchor, sized to the space below, and its Legacy flyout opens downward too.
 */
export function ModelPicker({ provider = 'claude', grouped = false, started = false, variant = 'composer', placement = 'up', model, effort, fallback, compact, onCompact, onModel, onEffort, onClose, anchorRef }: {
  anchorRef: React.RefObject<HTMLElement | null>; provider?: Provider; grouped?: boolean; started?: boolean; variant?: 'composer' | 'settings'; placement?: 'up' | 'down'; model: string; effort: Effort; fallback: Effort; compact?: CompactWindow; onCompact?: (w: CompactWindow) => void
  onModel: (m: string, effort: Effort) => void; onEffort: (e: Effort) => void; onClose: () => void
}) {
  const codex = useProviderModels('codex')
  const claude = useProviderModels('claude')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const own = listOf(provider)
  const efforts = effortsOf(model, own)
  const favorites = useFavoriteModels()
  const settings = variant === 'settings'
  // Under the chip when the window has room for the picker below it, else above it, so a low row's picker isn't squeezed (KERNEL-995).
  const [down] = useState(() => {
    if (placement !== 'down') return false
    const a = anchorRef.current?.getBoundingClientRect()
    if (!settings || !a) return true
    const below = window.innerHeight - a.bottom
    return below >= 460 || below >= a.top
  })
  const providers: Provider[] = settings || grouped || provider === 'codex' ? ['claude', 'codex'] : ['claude']
  /** The other provider can't take over a chat that has started. */
  const locked = (p: Provider) => !settings && started && p !== provider
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>(provider)
  // A row shows ^⌘N only when that key works: it picks the Nth current model of the chat's own provider (useModelKeys).
  const all: Row[] = useMemo(() => {
    const row = (p: Provider, m: { id: string; label: string; legacy?: boolean }): Row => ({ provider: p, id: m.id, label: m.label, legacy: !!m.legacy, n: settings ? undefined : shortcutNumber({ id: m.id, provider: p }, provider, own) })
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
  const [flyout, setFlyout] = useState<'effort' | 'compact' | 'legacy' | null>(null)
  const sub = flyout === 'effort'
  const hasCompact = settings && compact !== undefined
  const compactShown = flyout === 'compact' && hasCompact
  const compactOptions = COMPACT_WINDOWS.map((w) => ({ id: w, label: COMPACT_LABELS[w] }))
  const effortOptions = efforts.map((x) => ({ id: x, label: EFFORT_LABELS[x] }))
  const [flip, setFlip] = useState(false)
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
  // Opening upward from the composer, the popover gets the space between its bottom and the window's top. Opening down, the space below its top.
  const [maxHeight, setMaxHeight] = useState<number>()
  useLayoutEffect(() => {
    const fit = () => { if (ref.current) { const box = ref.current.getBoundingClientRect(); setMaxHeight(Math.max(160, down ? window.innerHeight - box.top - 12 : box.bottom - 12)) } }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  useEffect(() => { ref.current?.querySelector('.pick-list [data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [at, items])
  useEffect(() => { if (legacyShown) ref.current?.querySelector('.pick-flyout-legacy [data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [legacyAt, legacyShown])
  // The flyout's bottom edge sits on the Legacy row's, like the Effort flyout's, and it grows upward into the space above. Opening down, its top sits on the row's and it grows down.
  useLayoutEffect(() => {
    if (!legacyShown || !ref.current) return
    const row = ref.current.querySelector('.pick-legacy')?.getBoundingClientRect()
    if (!row) return
    const pop = ref.current.getBoundingClientRect()
    setLegacyStyle(down
      ? { top: row.top - pop.top - 7, bottom: 'auto', maxHeight: Math.max(160, window.innerHeight - row.top + 6 - 12) }
      : { bottom: pop.bottom - row.bottom - 7, maxHeight: Math.max(160, row.bottom + 6 - 12) })
  }, [legacyShown, items])
  // In Settings the picker sits at the table's right edge, so a flyout that would pass the window's turns to the left.
  useLayoutEffect(() => {
    if (!settings || !flyout || !ref.current) return
    setFlip(ref.current.getBoundingClientRect().right + 21 + (flyout === 'legacy' ? 320 : 220) > window.innerWidth - 16)
  }, [settings, flyout])

  // The Effort row, then the Compact at row in Settings, are the last stops for the arrow keys.
  const effortRow = items.length
  const compactRow = hasCompact ? items.length + 1 : -1
  const rowEffort = (m: Row) => (settings ? fitEffort(effort, m.id, listOf(m.provider)) : m.id === model ? effort : fitEffort(effortFor(m.id, memory, fallback), m.id, listOf(m.provider)))
  const pickModel = (m: Row) => { if (!locked(m.provider)) onModel(m.id, rowEffort(m)) }
  const setSub = (on: boolean) => setFlyout(on ? 'effort' : null)
  const pickEffort = (e: Effort) => { onEffort(e); setSub(false) }
  const openSub = () => { setSubAt(Math.max(0, efforts.indexOf(effort))); setSub(true) }
  const pickCompact = (w: CompactWindow) => { onCompact?.(w); setFlyout(null) }
  const openCompact = () => { setSubAt(Math.max(0, COMPACT_WINDOWS.indexOf(compact ?? 'full'))); setFlyout('compact') }
  const openLegacy = () => { setLegacyAt(Math.max(0, legacyRows.findIndex((r) => r.id === model))); setFlyout('legacy') }
  const goTab = (t: Tab) => { if (t !== 'favorites' && locked(t)) return; setTab(t); setAt(0); setSub(false) }
  const press = (i: Item | undefined) => { if (i?.kind === 'legacy') (legacyShown ? setFlyout(null) : openLegacy()); else if (i) pickModel(i.row) }

  const onKey = (e: React.KeyboardEvent) => {
    if (!settings && e.ctrlKey && e.metaKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const m = all.find((r) => r.n === Number(e.key)); if (m) pickModel(m); return }
    if (!settings && isCycleEffortKey(e)) { e.preventDefault(); pickEffort(nextEffort(effort, efforts)); return }
    if (!settings && e.metaKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'd') {
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
    if (sub || compactShown) {
      const options = sub ? effortOptions : compactOptions
      const to = arrowRow(e, subAt, options.length)
      if (to !== null) { e.preventDefault(); setSubAt(to) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setFlyout(null) }
      else if (e.key === 'Enter') { e.preventDefault(); const o = options[subAt]; if (o) (sub ? pickEffort(o.id as Effort) : pickCompact(o.id as CompactWindow)) }
      return
    }
    const to = arrowRow(e, at, effortRow + 1 + (hasCompact ? 1 : 0))
    if (to !== null) { e.preventDefault(); setAt(to) }
    else if (e.key === 'ArrowRight' && at === effortRow) { e.preventDefault(); openSub() }
    else if (e.key === 'ArrowRight' && at === compactRow) { e.preventDefault(); openCompact() }
    else if (e.key === 'ArrowRight' && items[at]?.kind === 'legacy') { e.preventDefault(); openLegacy() }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[at]; if (at === effortRow) openSub(); else if (at === compactRow) openCompact(); else if (it?.kind === 'legacy') openLegacy(); else press(it) }
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
      {!settings && <button type="button" tabIndex={-1} className="pick-star" aria-pressed={favorites.includes(row.id)} aria-label={`${favorites.includes(row.id) ? 'Remove' : 'Add'} ${row.label} ${favorites.includes(row.id) ? 'from' : 'to'} favorites`}
        data-tip-kbd="⌘D" onMouseDown={(e) => e.preventDefault()} onClick={() => toggleFavoriteModel(row.id)}>
        <Icon name="star" size={14} />
      </button>}
    </div>
  )
  const tabs: { id: Tab; label: string }[] = [...(settings ? [] : [{ id: 'favorites' as Tab, label: 'Favorites' }]), ...providers.map((p) => ({ id: p as Tab, label: providerLabel(p) }))]
  const empty = needle ? `No model matches "${q.trim()}".` : tab === 'favorites' ? 'Star a model to keep it here.' : 'No models to show.'

  return (
    <div ref={ref} className="menu cmp-pop model-pop" role="dialog" aria-label={settings ? 'Model' : 'Model and effort'} data-placement={down ? 'down' : undefined} data-align={settings ? 'right' : undefined} onKeyDown={onKey} style={{ maxHeight }}>
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
                onMouseEnter={() => { setAt(i); if (flyout === 'effort' || flyout === 'compact') setFlyout(null) }} onMouseDown={(e) => e.preventDefault()} onClick={() => (legacyShown ? setFlyout(null) : (setAt(i), openLegacy()))}>
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
          <button type="button" tabIndex={-1} className="menu-item pick-row pick-effort-btn" aria-haspopup="menu" aria-expanded={sub} data-active={!flyout && at === effortRow} data-open={sub}
            onMouseEnter={() => { setAt(effortRow); openSub() }} onMouseDown={(e) => e.preventDefault()} onClick={() => (sub ? setSub(false) : openSub())}>
            <span className="pick-name">Effort</span>
            <span className="grow" />
            <span className="pick-effort">{effortLabel(effort)}</span>
            <Icon name="right" size={14} />
          </button>
          {sub && <ChoiceMenu label="Effort" options={effortOptions} value={effort} at={subAt} onAt={setSubAt} onPick={(id) => pickEffort(id as Effort)} onClose={() => setSub(false)} flip={flip} />}
        </div>
        {hasCompact && (
          <div className="pick-effort-row">
            <button type="button" tabIndex={-1} className="menu-item pick-row pick-effort-btn" aria-haspopup="menu" aria-expanded={compactShown} data-active={!flyout && at === compactRow} data-open={compactShown}
              onMouseEnter={() => { setAt(compactRow); openCompact() }} onMouseDown={(e) => e.preventDefault()} onClick={() => (compactShown ? setFlyout(null) : openCompact())}>
              <span className="pick-name">Compact at</span>
              <span className="grow" />
              <span className="pick-effort">{COMPACT_LABELS[compact ?? 'full']}</span>
              <Icon name="right" size={14} />
            </button>
            {compactShown && <ChoiceMenu label="Compact at" options={compactOptions} value={compact ?? 'full'} at={subAt} onAt={setSubAt} onPick={(id) => pickCompact(id as CompactWindow)} onClose={() => setFlyout(null)} flip={flip} />}
          </div>
        )}
      </div>
      {legacyShown && (
        <LegacyMenu style={legacyStyle} flip={flip} onClose={() => setFlyout(null)}>
          {legacyRows.map((r, i) => modelRow(r, i === legacyAt, () => setLegacyAt(i)))}
        </LegacyMenu>
      )}
      {!settings && <div className="pick-foot">
        <button type="button" className="pick-link" onClick={() => { onClose(); actions.ui.go({ name: 'settings', page: 'models' }) }}><Icon name="sliders" size={14} />Edit</button>
        <span className="pick-hint"><kbd className="kbd">⌘⇧/</kbd>Cycle effort</span>
      </div>}
    </div>
  )
}
