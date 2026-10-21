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

/** The five steps of the Effort track (Pen 8.3, 8.11), Low to Max, for both providers. A model that doesn't take a step shows it disabled. Codex's `ultra` has no step: at `ultra` the track is full. */
const TRACK: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** A flyout of choices with a check on the current one. Escape or ArrowLeft goes back to the picker. */
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

/** A row of the picker: a model on a provider, and `n` for its ^⌘ shortcut. */
interface Row { provider: Provider; id: string; label: string; legacy: boolean; n?: number }
/** What the arrow keys visit: a model, the Legacy models row, then the Effort track and Compact at. */
type Item = { kind: 'model'; row: Row; inLegacy?: boolean } | { kind: 'legacy'; rows: Row[] }
type Tab = 'favorites' | Provider

/**
 * Model and effort (D-093, KERNEL-1111): the one picker the composer, New chat and Settings, Models and effort open. Search on top, then a segmented
 * control: Favorites, Claude and Codex. A row is the model's name and its ^⌘N shortcut, the current one with a check. The older models fold under
 * one Legacy models row that opens in place. At the bottom, Effort is a track of steps (hover one to name it, click to set it) and Compact at
 * sits under it in Settings. Type to search (legacy models included), arrow keys move, Enter picks. Each model comes back at the effort you last used
 * with it, else at `fallback`, the default effort, never the open chat's (D-130). The caller remembers a picked effort.
 * Ctrl+Cmd+1 to 9 pick the Nth current model of the chat's provider, Cmd+D stars the model under the cursor and Cmd+Shift+/ cycles the effort.
 * Both composers take the model and effort keys while the picker is closed (useModelKeys).
 *
 * Both providers always show. A chat that has started can't take a model of the other provider, so that segment is locked: dimmed, with a lock
 * and a tooltip that says to start a new chat (KERNEL-406). Codex is dimmed too when it isn't set up (`grouped` is false). It opens 8px above its
 * trigger and aligns left; in Settings (`placement="down"`) it opens below and aligns right.
 *
 * `variant="settings"` is the role picker in Settings, Models (KERNEL-988, KERNEL-995): no ^⌘N hints, and nothing is locked by a chat. Both providers stay open there (Pen 15.34, KERNEL-1116),
 * and `onModel` says which provider the pick is on. A caller that holds one provider (New agent, the agent editor) passes `only`, so the other segment is dimmed (KERNEL-1056). A Claude role also gets a Compact at row (`compact`, `onCompact`).
 * Each model row's effort is what the role would get on it, `fitEffort(effort, model)`.
 */
export function ModelPicker({ provider = 'claude', grouped = false, started = false, variant = 'composer', only, placement = 'up', model, effort, fallback, compact, onCompact, onModel, onEffort, onClose, anchorRef }: {
  anchorRef: React.RefObject<HTMLElement | null>; provider?: Provider; grouped?: boolean; started?: boolean; variant?: 'composer' | 'settings'; only?: Provider; placement?: 'up' | 'down'; model: string; effort: Effort; fallback: Effort; compact?: CompactWindow; onCompact?: (w: CompactWindow) => void
  onModel: (m: string, effort: Effort, provider: Provider) => void; onEffort: (e: Effort) => void; onClose: () => void
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
  const providers: Provider[] = ['claude', 'codex']
  /** Why a provider's segment is off, or undefined when it can be picked. */
  const short = (p: Provider) => (p === 'claude' ? 'Claude' : 'Codex')
  const lockReason = (p: Provider): string | undefined => {
    if (settings && only && p !== only) return `This is the ${short(only)} model. Set ${short(p)}'s on its own chip.`
    if (!settings && started && p !== provider) return `This chat started on ${short(provider)}. Start a new chat to use ${short(p)}.`
    if (!settings && p === 'codex' && !grouped && provider !== 'codex') return "Codex isn't set up. Sign in to it in Settings, Accounts."
    return undefined
  }
  const locked = (p: Provider) => lockReason(p) !== undefined
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>(provider)
  // A row shows ^⌘N only when that key works: it picks the Nth current model of the chat's own provider (useModelKeys).
  const all: Row[] = useMemo(() => {
    const row = (p: Provider, m: { id: string; label: string; legacy?: boolean }): Row => ({ provider: p, id: m.id, label: m.label, legacy: !!m.legacy, n: settings ? undefined : shortcutNumber({ id: m.id, provider: p }, provider, own) })
    return [...claude.map((m) => row('claude', m)), ...codex.map((m) => row('codex', m))]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claude, codex, provider])
  const needle = q.trim().toLowerCase()
  const current = all.find((m) => m.id === model)
  // A chat on a legacy model opens the Legacy models row, with the cursor on it.
  const [legacyOpen, setLegacyOpen] = useState(() => !!current?.legacy)
  const groups = useMemo(() => {
    const pool = tab === 'favorites' ? all.filter((m) => favorites.includes(m.id) && !locked(m.provider)) : all.filter((m) => m.provider === tab)
    const hits = needle ? pool.filter((m) => m.label.toLowerCase().includes(needle)) : pool
    const flat = tab === 'favorites' || !!needle
    return { models: flat ? hits : hits.filter((m) => !m.legacy), legacy: flat ? [] : hits.filter((m) => m.legacy) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, tab, favorites, needle, started, provider, grouped])
  const items: Item[] = useMemo(() => [
    ...groups.models.map((row): Item => ({ kind: 'model', row })),
    ...(groups.legacy.length ? [{ kind: 'legacy' as const, rows: groups.legacy }, ...(legacyOpen ? groups.legacy.map((row): Item => ({ kind: 'model', row, inLegacy: true })) : [])] : [])
  ], [groups, legacyOpen])
  const [at, setAt] = useState(() => Math.max(0, items.findIndex((i) => i.kind === 'model' && i.row.id === model)))
  const [flyout, setFlyout] = useState<'compact' | null>(null)
  const hasCompact = compact !== undefined
  const compactShown = flyout === 'compact' && hasCompact
  const compactOptions = COMPACT_WINDOWS.map((w) => ({ id: w, label: COMPACT_LABELS[w] }))
  const [flip, setFlip] = useState(false)
  const [subAt, setSubAt] = useState(0)
  const memory = useEffortMemory()
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])
  // Opening upward from the composer, the popover gets the space between its bottom and the window's top. Opening down, the space below its top.
  const [maxHeight, setMaxHeight] = useState<number>()
  useLayoutEffect(() => {
    const fit = () => { if (ref.current) { const box = ref.current.getBoundingClientRect(); setMaxHeight(Math.max(260, down ? window.innerHeight - box.top - 12 : box.bottom - 12)) } }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  useEffect(() => { ref.current?.querySelector('.pick-list [data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [at, items])
  // In Settings the picker sits at the table's right edge, so the Compact at choices that would pass the window's turn to the left.
  useLayoutEffect(() => {
    if (!settings || !flyout || !ref.current) return
    setFlip(ref.current.getBoundingClientRect().right + 200 > window.innerWidth - 16)
  }, [settings, flyout])

  // The Effort track, then Compact at, are the last stops for the arrow keys.
  const effortRow = items.length
  const compactRow = hasCompact ? items.length + 1 : -1
  const rowEffort = (m: Row) => (settings ? fitEffort(effort, m.id, listOf(m.provider)) : m.id === model ? effort : fitEffort(effortFor(m.id, memory, fallback), m.id, listOf(m.provider)))
  const pickModel = (m: Row) => { if (!locked(m.provider)) onModel(m.id, rowEffort(m), m.provider) }
  const pickEffort = (e: Effort) => onEffort(e)
  const pickCompact = (w: CompactWindow) => { onCompact?.(w); setFlyout(null) }
  const openCompact = () => { setSubAt(Math.max(0, COMPACT_WINDOWS.indexOf(compact ?? 'full'))); setFlyout('compact') }
  const goTab = (t: Tab) => { if (t !== 'favorites' && locked(t)) return; setTab(t); setAt(0) }
  const press = (i: Item | undefined) => { if (i?.kind === 'legacy') setLegacyOpen((o) => !o); else if (i) pickModel(i.row) }
  const stepEffort = (dir: 1 | -1) => { const i = efforts.indexOf(effort); const next = efforts[Math.min(efforts.length - 1, Math.max(0, i + dir))]; if (next && next !== effort) pickEffort(next) }

  const onKey = (e: React.KeyboardEvent) => {
    if (!settings && e.ctrlKey && e.metaKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const m = all.find((r) => r.n === Number(e.key)); if (m) pickModel(m); return }
    if (isCycleEffortKey(e)) { e.preventDefault(); pickEffort(nextEffort(effort, efforts)); return }
    if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      const it = items[at]
      if (!compactShown && it?.kind === 'model') toggleFavoriteModel(it.row.id)
      return
    }
    if (compactShown) {
      const to = arrowRow(e, subAt, compactOptions.length)
      if (to !== null) { e.preventDefault(); setSubAt(to) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setFlyout(null) }
      else if (e.key === 'Enter') { e.preventDefault(); const o = compactOptions[subAt]; if (o) pickCompact(o.id as CompactWindow) }
      return
    }
    const to = arrowRow(e, at, effortRow + 1 + (hasCompact ? 1 : 0))
    if (to !== null) { e.preventDefault(); setAt(to) }
    else if (at === effortRow && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); stepEffort(e.key === 'ArrowRight' ? 1 : -1) }
    else if (e.key === 'ArrowRight' && at === compactRow) { e.preventDefault(); openCompact() }
    else if (e.key === 'ArrowRight' && items[at]?.kind === 'legacy') { e.preventDefault(); setLegacyOpen(true) }
    else if (e.key === 'ArrowLeft' && (items[at]?.kind === 'legacy' || (items[at] as Extract<Item, { kind: 'model' }> | undefined)?.inLegacy)) {
      e.preventDefault()
      setLegacyOpen(false)
      setAt(items.findIndex((i) => i.kind === 'legacy'))
    }
    else if (e.key === 'Enter') { e.preventDefault(); if (at === compactRow) openCompact(); else if (at !== effortRow) press(items[at]) }
  }

  /** A model row: its name, then its ^⌘ key or a check. */
  const modelRow = (row: Row, active: boolean, onEnter: () => void, inLegacy?: boolean) => (
    <div key={`${row.provider}:${row.id}`} className="pick-item" role="presentation" data-active={active} data-legacy={inLegacy || undefined} onMouseEnter={onEnter}>
      <button type="button" role="option" aria-selected={row.id === model} tabIndex={-1} className="menu-item pick-row" data-selected={row.id === model}
        onMouseDown={(e) => e.preventDefault()} onClick={() => pickModel(row)}>
        <span className="pick-name">{row.label}</span>
        <span className="grow" />
        {row.id === model ? <span className="pick-check"><Icon name="check" size={14} /></span> : row.n ? <span className="pick-kbd">^⌘{row.n}</span> : null}
      </button>
      <button type="button" tabIndex={-1} className="pick-star" aria-pressed={favorites.includes(row.id)} aria-label={`${favorites.includes(row.id) ? 'Remove' : 'Add'} ${row.label} ${favorites.includes(row.id) ? 'from' : 'to'} favorites`}
        data-tip-kbd="⌘D" onMouseDown={(e) => e.preventDefault()} onClick={() => toggleFavoriteModel(row.id)}>
        <Icon name="star" size={13} />
      </button>
    </div>
  )
  const trackAt = TRACK.indexOf(effort) < 0 ? TRACK.length - 1 : TRACK.indexOf(effort)
  const empty = needle ? `No model matches "${q.trim()}".` : tab === 'favorites' ? 'Star a model to keep it here.' : 'No models to show.'

  return (
    <div ref={ref} className="menu cmp-pop model-pop" role="dialog" aria-label={settings ? 'Model' : 'Model and effort'} data-placement={down ? 'down' : undefined} data-align={settings ? 'right' : undefined} onKeyDown={onKey} style={{ maxHeight }}>
      <div className="pick-head">
        <label className="pick-search">
          <Icon name="search" size={13} />
          <input aria-label="Search models" placeholder="Search models" autoComplete="off" spellCheck={false} value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} />
        </label>
        <div className="pick-seg" role="tablist" aria-label="Providers">
          <button type="button" role="tab" className="pick-segment pick-segment-star" aria-selected={tab === 'favorites'} aria-label="Favorites" data-tip="Favorites" data-tip-align="start" data-tip-side="above"
            onMouseDown={(e) => e.preventDefault()} onClick={() => goTab('favorites')}><Icon name="star" size={13} /></button>
          {providers.map((p) => {
            const why = lockReason(p)
            return (
              <button key={p} type="button" role="tab" className="pick-segment" aria-selected={tab === p} aria-disabled={why ? true : undefined} data-tip={why ?? providerLabel(p)} data-tip-align="start" data-tip-side="above"
                onMouseDown={(e) => e.preventDefault()} onClick={() => goTab(p)}>
                <ProviderMark provider={p} size={13} />
                <span>{short(p)}</span>
                {why && started && !settings && <Icon name="lock" size={12} />}
              </button>
            )
          })}
        </div>
      </div>
      <div role="listbox" aria-label="Models" className="pick-list">
        {items.map((it, i) => it.kind === 'legacy' ? (
          <button key="legacy" type="button" tabIndex={-1} className="menu-item pick-legacy" aria-expanded={legacyOpen} data-active={i === at}
            onMouseEnter={() => setAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => { setAt(i); setLegacyOpen((o) => !o) }}>
            <Icon name={legacyOpen ? 'chevron' : 'right'} size={12} />
            <span>Legacy models</span>
            <span className="pick-count">{it.rows.length}</span>
          </button>
        ) : modelRow(it.row, i === at, () => setAt(i), it.inLegacy))}
        {!items.length && <p className="pick-empty">{empty}</p>}
      </div>
      <div className="pick-effort" data-active={at === effortRow} onMouseEnter={() => setAt(effortRow)}>
        <div className="pick-effort-top">
          <span className="pick-effort-name">Effort</span>
          <span className="pick-effort-value">{effortLabel(effort)}</span>
        </div>
        <div className="pick-track" role="radiogroup" aria-label="Effort">
          {TRACK.map((x, i) => {
            const offered = efforts.includes(x)
            return (
              <button key={x} type="button" role="radio" aria-checked={x === effort} aria-disabled={offered ? undefined : true} aria-label={EFFORT_LABELS[x]} data-tip-side="above" tabIndex={-1} className="pick-step" data-on={i <= trackAt} data-off={offered ? undefined : true}
                onMouseDown={(e) => e.preventDefault()} onClick={() => { if (offered) pickEffort(x) }}><span /></button>
            )
          })}
        </div>
        <div className="pick-effort-ends"><span>{EFFORT_LABELS.low}</span><span>{EFFORT_LABELS.max}</span></div>
      </div>
      {hasCompact && (
        <div className="pick-compact">
          <button type="button" tabIndex={-1} className="menu-item pick-compact-row" aria-haspopup="menu" aria-expanded={compactShown} data-active={!flyout && at === compactRow} data-open={compactShown}
            onMouseEnter={() => { setAt(compactRow); openCompact() }} onMouseDown={(e) => e.preventDefault()} onClick={() => (compactShown ? setFlyout(null) : openCompact())}>
            <Icon name="collapse" size={13} />
            <span className="pick-name">Compact at</span>
            <span className="grow" />
            <span className="pick-compact-value">{COMPACT_LABELS[compact ?? 'full']}</span>
            <Icon name="right" size={12} />
          </button>
          {compactShown && <ChoiceMenu label="Compact at" options={compactOptions} value={compact ?? 'full'} at={subAt} onAt={setSubAt} onPick={(id) => pickCompact(id as CompactWindow)} onClose={() => setFlyout(null)} flip={flip} />}
        </div>
      )}
      <div className="pick-foot">
        {!hasCompact && <button type="button" className="pick-link" onClick={() => { onClose(); actions.ui.go({ name: 'settings', page: 'models' }) }}><Icon name="sliders" size={13} />Edit models</button>}
        <span className="grow" />
        <span className="pick-hint"><kbd className="kbd">⌘⇧/</kbd>cycles effort</span>
      </div>
    </div>
  )
}
