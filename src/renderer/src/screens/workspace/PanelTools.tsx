import { createContext, useCallback, useContext, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { call, cleanError } from '../../api'
import { actions } from '../../store'
import { Icon, IconButton, useBusy } from '../../ui'
import { filterQuery } from './panelFilter'

/**
 * The right side of the panel's top strip, which belongs to the tab on show (PanelToolbarPrs.png and its siblings, KERNEL-515). The panel
 * puts its toolbar's element here, and each tab draws its own buttons into it with `PanelTools`, so a tab's actions sit with the state
 * they act on and go away with the tab. Nothing is drawn until the element is there.
 */
export const ToolSlot = createContext<HTMLElement | null>(null)

export function PanelTools({ children }: { children: ReactNode }) {
  const slot = useContext(ToolSlot)
  return slot ? createPortal(children, slot) : null
}

/** One icon in the strip: 24px, with the icon at 14px. Name it with `label`, which is also its tooltip. */
export function ToolButton({ ref, ...props }: Omit<Parameters<typeof IconButton>[0], 'size'> & { ref?: Ref<HTMLButtonElement> }) {
  return <IconButton size={14} {...props} {...(ref ? { ref } : {})} />
}

/**
 * Reads the pull request again, for each workspace in `ids` (`pr.refresh`). The rows move on their own, from the pushes the read makes.
 * The button spins and says Refreshing until every read is done, and a read that fails says so once.
 */
export function RefreshButton({ ids, label, failTitle }: { ids: string[]; label: string; failTitle: string }) {
  const [busy, run] = useBusy<'refresh'>()
  const refresh = () => void run('refresh', async () => {
    const results = await Promise.allSettled(ids.map((workspaceId) => call('pr.refresh', { workspaceId })))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) actions.ui.toast({ title: failTitle, sub: cleanError(failed.reason) })
  })
  return <ToolButton icon="refresh" label={label} busy={busy === 'refresh'} busyPattern="ripple" busyLabel="Refreshing" onClick={refresh} />
}

const NO_FOLDS = new Set<string>()
const CLOSED = { open: false, text: '', shut: NO_FOLDS }

export interface PanelFilter {
  /** The field is showing under the strip. */
  open: boolean
  text: string
  /** `text` as matched, empty while there is nothing to filter by. */
  query: string
  /** Rows are being narrowed. */
  filtering: boolean
  /** Folders the reader closed while filtering. They are all drawn open otherwise, so a match never hides in one. */
  shut: Set<string>
  /** The search button, which gets focus back when Escape closes the field. */
  button: RefObject<HTMLButtonElement | null>
  setText: (text: string) => void
  /** The search button: opens the field, or closes and clears it. */
  toggle: () => void
  close: (refocus?: boolean) => void
  fold: (path: string) => void
  foldAll: (paths: Iterable<string>) => void
}

/**
 * The filter of a tab that has one (PanelFilter.png): a field under the strip, opened by the search button. It lives in its tab, so a
 * new tab or workspace starts without one. Closing clears it.
 */
export function usePanelFilter(): PanelFilter {
  const [state, setState] = useState(CLOSED)
  const button = useRef<HTMLButtonElement>(null)
  const query = filterQuery(state.text)
  const toggle = useCallback(() => setState((s) => (s.open ? CLOSED : { ...CLOSED, open: true })), [])
  const close = useCallback((refocus?: boolean) => { setState(CLOSED); if (refocus) button.current?.focus() }, [])
  const setText = useCallback((text: string) => setState((s) => ({ ...s, text, shut: filterQuery(text) ? s.shut : NO_FOLDS })), [])
  const fold = useCallback((path: string) => setState((s) => {
    const shut = new Set(s.shut)
    if (shut.has(path)) shut.delete(path); else shut.add(path)
    return { ...s, shut }
  }), [])
  const foldAll = useCallback((paths: Iterable<string>) => setState((s) => ({ ...s, shut: new Set(paths) })), [])
  return { open: state.open, text: state.text, query, filtering: !!query, shut: state.shut, button, setText, toggle, close, fold, foldAll }
}

/** The search button for a tab's filter, drawn pressed while the field is open. */
export function FilterButton({ filter, label }: { filter: PanelFilter; label: string }) {
  return <ToolButton ref={filter.button} icon="search" label={label} aria-pressed={filter.open} onClick={filter.toggle} />
}

/** The field under the strip. Escape closes and clears it. The X clears the text and keeps the field, or closes it when there is no text. */
export function FilterField({ filter, label, placeholder = 'Filter by path' }: { filter: PanelFilter; label: string; placeholder?: string }) {
  const input = useRef<HTMLInputElement>(null)
  if (!filter.open) return null
  const empty = !filter.text
  return (
    <div className="ffield">
      <div className="finput" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); filter.close(true) } }}>
        <Icon name="search" size={14} />
        <input ref={input} type="text" aria-label={label} placeholder={placeholder} value={filter.text} onChange={(e) => filter.setText(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus />
        <ToolButton icon="close" label={empty ? 'Close filter' : 'Clear filter'} onClick={() => { if (empty) filter.close(true); else { filter.setText(''); input.current?.focus() } }} />
      </div>
    </div>
  )
}

/** `text` is the piece of a path that starts `from` characters in, with the filter's matches in the whole path marked. */
export function Marked({ text, from, ranges }: { text: string; from: number; ranges: [number, number][] }) {
  const out: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    const a = Math.max(start - from, at)
    const b = Math.min(end - from, text.length)
    if (b <= a) continue
    if (a > at) out.push(text.slice(at, a))
    out.push(<mark key={a} className="hl">{text.slice(a, b)}</mark>)
    at = b
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}
