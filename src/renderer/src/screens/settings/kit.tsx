import './settings.css'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Room, RoomSettings, RoomSettingsSection, SettingsPage } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, EmptyState, Icon, Kbd, Menu, Spinner, useBusy, type IconName } from '../../ui'
import { openNewRoom } from '../rooms/draft'
import { useRoomSettings } from './useSettings'

/**
 * One settings page: the title, one muted line saying changes save as you make them (KERNEL-721), and its sections. `action` sits at the right of the title, and
 * `back` is the link above it to the page it opened from. `crumb` puts a link before the title, the room on a room's page.
 */
export function Page({ title, crumb, action, back, children }: { title: string; crumb?: ReactNode; action?: ReactNode; back?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-scroll">
      <div className="set-page">
        <div>
          {back}
          <div className="set-head">
            <h1>{crumb && <>{crumb}<span className="set-crumb-sep" aria-hidden="true"><Icon name="right" size={16} /></span></>}<span>{title}</span></h1>
            {action}
          </div>
          <p className="set-saves">Changes save as you make them.</p>
        </div>
        {children}
      </div>
    </div>
  )
}

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'fading' } | { kind: 'clamped'; text: string }

/** What a field's save gives back: the saved value, or undefined when the save failed. */
export type SaveResult<T = unknown> = Promise<T | undefined> | void

const SAVED_MS = 1500

/**
 * The note beside a field that saves when you click away (KERNEL-721). `track` follows the promise of a save: Saving while it runs, then
 * Saved for a moment, or the clamp text, which stays until the next edit. A failed save (undefined) shows nothing, since the toast
 * already said so. Only the newest save of a field counts.
 */
export function useSaveNote() {
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const latest = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current) } }, [])
  const reset = () => { latest.current++; clearTimeout(timer.current); setState({ kind: 'idle' }) }
  const track = async <T,>(saving: SaveResult<T>, clamp?: (saved: T) => string | undefined) => {
    if (!saving) return
    const id = ++latest.current
    clearTimeout(timer.current)
    setState({ kind: 'saving' })
    const saved = await saving
    if (id !== latest.current || !mounted.current) return
    if (saved === undefined) { setState({ kind: 'idle' }); return }
    const text = clamp?.(saved)
    if (text) { setState({ kind: 'clamped', text }); return }
    setState({ kind: 'saved' })
    timer.current = setTimeout(() => setState({ kind: 'fading' }), SAVED_MS)
  }
  return { state, track, reset }
}

/** The words of a clamped number: main kept `saved` where the field asked for `asked`. */
export function clampText(asked: number, saved: number): string | undefined {
  if (saved === asked) return undefined
  return `Set to ${saved}, the ${saved < asked ? 'most' : 'least'} allowed`
}

export function SaveNote({ state }: { state: SaveState }) {
  if (state.kind === 'idle') return null
  const text = state.kind === 'saving' ? 'Saving' : state.kind === 'clamped' ? state.text : 'Saved'
  return (
    <span className="set-save" data-state={state.kind} role="status" aria-hidden={state.kind === 'fading' || undefined}>
      {state.kind === 'saving' ? <Spinner label={null} /> : state.kind !== 'clamped' && <Icon name="check" size={12} />}
      {text}
    </span>
  )
}

/**
 * Blur, unmount and Escape for a text field that saves when it loses focus (KERNEL-721). Text still unsaved when the field unmounts
 * (Escape to leave, a shortcut, Cmd+W) saves then. Escape in the field puts the saved text back instead, so nothing saves.
 */
export function useBlurSave({ text, setText, saved, commit }: { text: string; setText: (t: string) => void; saved: string; commit: (text: string) => void }) {
  const live = useRef({ text, saved, commit })
  live.current = { text, saved, commit }
  const done = useRef(saved)
  const flush = () => {
    const { text: t, saved: s, commit: c } = live.current
    if (done.current === t) return
    done.current = t
    if (t !== s) c(t)
  }
  useEffect(() => () => flush(), [])
  useEffect(() => { done.current = saved }, [saved])
  const cancel = () => {
    if (live.current.text === live.current.saved) return
    done.current = live.current.saved
    live.current.text = live.current.saved
    setText(live.current.saved)
  }
  return { onBlur: flush, onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() } }
}

/** Where a section's values are saved: `repo` is `.kernel/settings.toml`, shared with everyone on the repo; `mac` stays on this Mac. */
export type Scope = 'repo' | 'mac'

export function ScopeBadge({ scope }: { scope: Scope }) {
  return <span className="set-badge"><Icon name={scope === 'repo' ? 'team' : 'computer'} size={12} />{scope === 'repo' ? 'Shared with the repo' : 'This Mac only'}</span>
}

/**
 * A heading and a card of rows. `count` is a number after the title, `scope` the badge saying where the values are saved, `note` a
 * muted line beside the heading and `action` a button at its right (Add run script). `footnote` is the line under the card.
 * `collapsible` folds the card behind the heading, open when `defaultOpen`. `plain` leaves out the card, for a table or status line.
 */
export function Section({ title, count, scope, note, action, footnote, collapsible, defaultOpen = false, plain, label, children }: {
  title?: string; count?: number | string; scope?: Scope; note?: ReactNode; action?: ReactNode; footnote?: ReactNode
  collapsible?: boolean; defaultOpen?: boolean; plain?: boolean; label?: string; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const shown = !collapsible || open
  const n = count !== undefined && count !== '' && <span className="set-count">{count}</span>
  const heading = collapsible
    ? <button type="button" className="set-fold" aria-expanded={open} onClick={() => setOpen(!open)}><h2>{title}{n}</h2><Icon name="right" size={12} /></button>
    : title && <h2>{title}{n}</h2>
  return (
    <section className="set-section" aria-label={title ? undefined : label}>
      {(title || action || scope || note) && (
        <div className="set-section-head">
          {heading}
          {scope && <ScopeBadge scope={scope} />}
          {note && <span className="set-section-note">{note}</span>}
          {action && <span className="set-section-act">{action}</span>}
        </div>
      )}
      {shown && (plain ? children : <div className="set-card">{children}</div>)}
      {shown && footnote && <p className="set-note">{footnote}</p>}
    </section>
  )
}

/**
 * A label and optional description on the left, the control on the right. `full` puts the control on its own line.
 * `source` is the line under the label that says where a room's value came from, and `onReset` adds Reset, which sends `null` for the key.
 * `child` is a row that only matters because of the one above it: it is indented on a guide line. `lead` is a picture before the label
 * (an avatar or a logo). `hover` holds the buttons that show while the pointer is on the row.
 */
export function Row({ label, source, desc, onReset, children, full, className, child, lead, hover, labelId }: {
  label: ReactNode; source?: ReactNode; desc?: ReactNode; onReset?: () => void; children?: ReactNode; full?: ReactNode; className?: string
  child?: boolean; lead?: ReactNode; hover?: ReactNode; labelId?: string
}) {
  return (
    <div className={['set-row', child && 'set-child', hover && 'set-hoverable', className].filter(Boolean).join(' ')}>
      {child && <span className="set-guide" aria-hidden="true" />}
      {lead && <span className="set-lead">{lead}</span>}
      <div className="set-text">
        <span className="set-label" id={labelId}>{label}</span>
        {source && <span className="set-desc">{source}</span>}
        {desc && <span className="set-desc">{desc}</span>}
      </div>
      {hover && <span className="set-acts">{hover}</span>}
      {onReset && <Button variant="ghost" className="set-reset" aria-label={`Reset ${typeof label === 'string' ? label : 'setting'}`} onClick={onReset}>Reset</Button>}
      {children}
      {full && <div className="set-full">{full}</div>}
    </div>
  )
}

/** A status at the top of a page or section: an icon, what is true now, a line under it and one action (Hooks, a room's push access). */
export function StatusLine({ icon, title, sub, action, tone }: { icon: IconName; title: ReactNode; sub?: ReactNode; action?: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className="set-status" role="status" data-tone={tone}>
      <Icon name={icon} size={16} />
      <span className="set-status-text"><span className="set-label">{title}</span>{sub && <span className="set-desc">{sub}</span>}</span>
      {action}
    </div>
  )
}

export interface TableRow { key: string; cells: ReactNode[]; actions?: ReactNode }

/**
 * A list with a header row of column names (variables, run scripts, preview URLs). `grid` is the CSS columns, without the actions column
 * that is added at the end. A row's `actions` show while the pointer or focus is on it. `empty` shows when there are no rows.
 */
export function DataTable({ label, columns, grid, rows, empty }: { label: string; columns: string[]; grid: string; rows: TableRow[]; empty?: ReactNode }) {
  const template = `${grid} auto`
  return (
    <div className="set-card set-table" role="table" aria-label={label}>
      <div className="set-table-head" role="row" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => <span key={c} role="columnheader">{c}</span>)}
        <span role="columnheader" aria-label="Actions" />
      </div>
      {rows.map((r) => (
        <div key={r.key} className="set-table-row" role="row" style={{ gridTemplateColumns: template }}>
          {r.cells.map((c, i) => <span key={i} role="cell" className="set-cell">{c}</span>)}
          <span role="cell" className="set-acts">{r.actions}</span>
        </div>
      ))}
      {!rows.length && empty && <div className="set-table-empty">{empty}</div>}
    </div>
  )
}

/**
 * A list of short values as tags, with × to remove one and an Add button that opens a field in place (Always ask before, Protected
 * branches, Files to copy). A `locked` value is built in: it shows a lock and can't be removed. Enter adds, Escape cancels.
 */
export function TagList({ label, value, onChange, locked = [], addLabel = 'Add', placeholder, mono = true, disabled }: {
  label: string; value: string[]; onChange: (next: string[]) => SaveResult; locked?: string[]; addLabel?: string; placeholder?: string; mono?: boolean; disabled?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const addRef = useRef<HTMLButtonElement>(null)
  const note = useSaveNote()
  const live = useRef({ text, value, onChange })
  live.current = { text, value, onChange }
  const take = () => {
    const { text: t, value: v, onChange: change } = live.current
    live.current.text = ''
    const next = t.split(/[\n,]/).map((x) => x.trim()).filter((x) => x && !v.includes(x) && !locked.includes(x))
    if (next.length) void note.track(change([...v, ...next]))
  }
  useEffect(() => () => take(), [])
  const commit = (keepOpen: boolean) => {
    take()
    setText('')
    if (!keepOpen) { setAdding(false); addRef.current?.focus() }
  }
  return (
    <div className="set-tags" role="list" aria-label={label}>
      {locked.map((t) => <span key={`l-${t}`} role="listitem" className="set-tag" data-locked=""><Icon name="lock" size={12} /><span className={['set-tag-text', mono && 'mono'].filter(Boolean).join(' ')} title={t}>{t}</span></span>)}
      {value.filter((t) => !locked.includes(t)).map((t) => (
        <span key={t} role="listitem" className="set-tag">
          <span className={['set-tag-text', mono && 'mono'].filter(Boolean).join(' ')} title={t}>{t}</span>
          <button type="button" className="set-tag-x" aria-label={`Remove ${t}`} disabled={disabled} onClick={() => onChange(value.filter((v) => v !== t))}><Icon name="x" size={12} /></button>
        </span>
      ))}
      {adding
        ? <input
            autoFocus className={['set-tag-input', mono && 'mono'].filter(Boolean).join(' ')} aria-label={`${addLabel} to ${label}`} placeholder={placeholder} spellCheck={false} value={text}
            onChange={(e) => setText(e.target.value)} onBlur={() => commit(false)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(true) } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); live.current.text = ''; setText(''); setAdding(false); addRef.current?.focus() } }}
          />
        : <button ref={addRef} type="button" className="set-tag-add" disabled={disabled} aria-label={`${addLabel} to ${label}`} onClick={() => { note.reset(); setAdding(true) }}><Icon name="plus" size={12} />{addLabel}</button>}
      <SaveNote state={note.state} />
    </div>
  )
}

/** Where a Settings link goes: an app page, or a room's page with its section. */
export type SettingsTarget = { page: SettingsPage; roomId?: string; section?: RoomSettingsSection; agentId?: string }

/** "Settings, Models and effort" you can click: a cross-reference to another Settings page (KERNEL-680). */
export function SettingsLink({ to, children }: { to: SettingsTarget; children: ReactNode }) {
  return <button type="button" className="set-link" onClick={() => go({ name: 'settings', ...to })}>{children}</button>
}

export function Keys({ keys }: { keys: string[] }) {
  return <span className="set-keys">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
}

/** A list with one entry per line (Always ask before, Never allow). Saved when the field loses focus. */
export function LinesField({ label, value, onSave }: { label: string; value: string[]; onSave: (lines: string[]) => SaveResult }) {
  const [text, setText] = useState(value.join('\n'))
  const ref = useRef<HTMLTextAreaElement>(null)
  const note = useSaveNote()
  useEffect(() => { setText(value.join('\n')) }, [value.join('\n')])
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }, [text])
  const save = useBlurSave({
    text, setText, saved: value.join('\n'),
    commit: (t) => { const next = t.split('\n').map((l) => l.trim()).filter(Boolean); if (next.join('\n') !== value.join('\n')) void note.track(onSave(next)) }
  })
  return (
    <div className="set-field">
      <textarea ref={ref} className="set-lines" aria-label={label} rows={Math.max(2, value.length)} spellCheck={false} value={text} onChange={(e) => { note.reset(); setText(e.target.value) }} {...save} />
      <SaveNote state={note.state} />
    </div>
  )
}

/** A short list on one line, comma separated (Protected branches). */
export function ListField({ label, value, onSave }: { label: string; value: string[]; onSave: (items: string[]) => SaveResult }) {
  const [text, setText] = useState(value.join(', '))
  const note = useSaveNote()
  useEffect(() => { setText(value.join(', ')) }, [value.join(',')])
  const save = useBlurSave({
    text, setText, saved: value.join(', '),
    commit: (t) => { const next = t.split(',').map((l) => l.trim()).filter(Boolean); if (next.join(',') !== value.join(',')) void note.track(onSave(next)) }
  })
  return (
    <span className="set-field-inline">
      <SaveNote state={note.state} />
      <input className="set-inline" aria-label={label} spellCheck={false} value={text} onChange={(e) => { note.reset(); setText(e.target.value) }} {...save}
        onKeyDown={(e) => { save.onKeyDown(e); if (e.key === 'Enter') e.currentTarget.blur() }} />
    </span>
  )
}

/** Free text, kept as typed (blank lines and all): instructions and scripts. Saved when the field loses focus. */
export function TextField({ label, value, onSave, placeholder }: { label: string; value: string; onSave: (text: string) => SaveResult; placeholder?: string }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  const note = useSaveNote()
  useEffect(() => { setText(value) }, [value])
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }, [text])
  const save = useBlurSave({ text, setText, saved: value, commit: (t) => void note.track(onSave(t)) })
  return (
    <div className="set-field">
      <textarea ref={ref} className="set-lines" aria-label={label} placeholder={placeholder} rows={Math.max(1, text.split('\n').length)} spellCheck={false} value={text} onChange={(e) => { note.reset(); setText(e.target.value) }} {...save} />
      <SaveNote state={note.state} />
    </div>
  )
}

/** A page for a repo's settings when there is no repo to read them from yet. */
export function NoRoom() {
  return (
    <Page title="No room yet">
      <EmptyState icon="rooms" title="These settings belong to a repo" action={<Button variant="primary" icon="plus" onClick={() => openNewRoom()}>New room</Button>}>Add a room and its settings show up here.</EmptyState>
    </Page>
  )
}

/** Where a room's value came from, for the line under its label. The app default says nothing. A personal value only the room sees says nothing either. */
export function sourceLine(rs: RoomSettings | null, path: string): string | undefined {
  const s = rs?.sources?.[path]
  return s === 'shared' ? 'From settings.toml' : s === 'override' ? 'Overriding settings.toml' : undefined
}

/** Does this room set the value itself (in its personal file, with or without settings.toml)? Those are the values Reset can drop. */
export const isOverride = (rs: RoomSettings | null, path: string) => rs?.sources?.[path] === 'local' || rs?.sources?.[path] === 'override'

/** The room a room page shows, with its settings. `room` is undefined when the route's room is gone. */
export function useRoomPage(roomId?: string): { room: Room | undefined; rs: RoomSettings | null } {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  return { room, rs: useRoomSettings(roomId) }
}

/**
 * The button at the top right of a room page: it opens settings.local.toml, and its menu opens settings.toml.
 * Only a file that exists is offered, and `sources` says which do: a value from settings.toml means that file is there.
 * `shared` is a page whose values only settings.toml holds (Reviews, KERNEL-557): it opens that file first, and offers it even when no
 * value in `sources` came from it, since `[review]` isn't one of them.
 */
function OpenSettingsFiles({ room, rs, shared }: { room: Room; rs: RoomSettings | null; shared?: boolean }) {
  const open = useStore((s) => s.ui.menu === 'settingsFiles')
  const [busy, run] = useBusy()
  const anchor = useRef<HTMLDivElement>(null)
  const values = Object.values(rs?.sources ?? {})
  const files = shared
    ? ['settings.toml', ...(values.some((s) => s === 'local' || s === 'override') ? ['settings.local.toml'] : [])]
    : [
      ...(values.some((s) => s === 'local' || s === 'override') ? ['settings.local.toml'] : []),
      ...(values.some((s) => s === 'shared' || s === 'override') ? ['settings.toml'] : [])
    ]
  if (!files.length) return null
  const [first, ...more] = files
  const edit = (file: string) => run('open', async () => {
    try { await call('system.openInEditor', { path: `${room.path}/.kernel/${file}` }) } catch (e) { actions.ui.toast({ title: `Could not open ${file}`, sub: cleanError(e) }) }
  })
  return (
    <div className="set-files" ref={anchor}>
      <div className="set-split">
        <Button variant="ghost" className="set-split-main" icon="doc" busy={busy === 'open'} busyLabel="Opening" onClick={() => void edit(first)}>Open {first}</Button>
        {more.length > 0 && (
          <button type="button" className="set-split-caret" aria-label="More files" aria-haspopup="menu" aria-expanded={open} disabled={busy !== null} onClick={() => actions.ui.toggleMenu('settingsFiles')}><Icon name="chevron" size={12} /></button>
        )}
      </div>
      {open && <Menu label="More files" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 36, width: 224 }} items={more.map((f) => ({ id: f, label: `Open ${f}`, icon: 'doc' as const, onSelect: () => void edit(f) }))} />}
    </div>
  )
}

/**
 * A room page: the room and the page's name as a breadcrumb, the settings files button, and the sections. The room's name goes back to
 * its General page. `shared` is a page the team shares, so its file button opens settings.toml first.
 */
export function RoomPage({ room, rs, title, shared, children }: { room: Room; rs: RoomSettings | null; title: string; shared?: boolean; children: ReactNode }) {
  const crumb = <button type="button" className="set-crumb" aria-label={`${room.name} settings`} onClick={() => go({ name: 'settings', page: 'room', roomId: room.id })}>{room.name}</button>
  return <Page title={title} crumb={crumb} action={<OpenSettingsFiles room={room} rs={rs} shared={shared} />}>{children}</Page>
}
