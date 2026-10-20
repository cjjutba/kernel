import './settings.css'
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Project, ProjectSettings, ProjectSettingsSection, SettingsPage } from '@shared/types'
import { APP_SETTING_TIMING, PROJECT_SETTING_TIMING, type SettingTiming } from '@shared/settingsTiming'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, LinkButton, EmptyState, Icon, Kbd, Menu, Spinner, SplitButton, useBusy, type IconName, type LinkVariant } from '../../ui'
import { openNewProject } from '../projects/draft'
import { useProjectSettings } from './useSettings'
import { useKeptScroll } from '../../ui/keptScroll'

/** Which spot the page in view keeps, and whether a route row or an agent editor is taking it somewhere on purpose (KERNEL-920). */
export const KeepContext = createContext<{ key: string; target: boolean } | null>(null)

/**
 * One settings page: the title and its sections, with nothing under the title (KERNEL-1023). `action` sits at the right of the title, and `note` just before it,
 * for a save that has no field of its own. `back` is the link above it to the page it opened from. `crumb` puts a link before the title, the project on a project's page.
 */
export function Page({ title, crumb, action, back, note, children }: { title: string; crumb?: ReactNode; action?: ReactNode; back?: ReactNode; note?: ReactNode; children: ReactNode }) {
  const keep = useContext(KeepContext)
  const scroll = useRef<HTMLDivElement>(null)
  useKeptScroll(scroll, { key: keep?.key ?? '', ready: !!keep, target: keep?.target })
  return (
    <div className="set-scroll" ref={scroll}>
      <div className="set-page">
        <div>
          {back}
          <div className="set-head">
            <h1>{crumb && <>{crumb}<span className="set-crumb-sep" aria-hidden="true"><Icon name="right" size={16} /></span></>}<span>{title}</span></h1>
            {note}
            {action}
          </div>
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

/** The project whose page is showing, so a row looks its setting up in the project's table and a save checks that project's chats. */
const ProjectScope = createContext<string | undefined>(undefined)

/** What the row around a field says about its setting: when a change reaches agents, and the project it is a value of. */
const RowTiming = createContext<{ timing?: SettingTiming; projectId?: string; shared?: boolean }>({})

const TERMINAL_TAB_SETTINGS = new Set(['terminal.preset', 'terminal.onlyInWorktrees'])

const APPLIES: Partial<Record<SettingTiming, string>> = {
  newChats: 'Applies to new chats',
  newWorkspaces: 'Applies to new workspaces',
  newProjects: 'Applies to new projects',
  restart: 'Applies the next time Kernel opens'
}

/** The timing of a setting by dotted path. An entry covers every key under it, as in `APP_SETTING_TIMING`. */
export function timingOf(path: string, projectId?: string): SettingTiming | undefined {
  const parts = path.split('.')
  for (const table of projectId ? [PROJECT_SETTING_TIMING, APP_SETTING_TIMING] : [APP_SETTING_TIMING]) {
    const map: Record<string, SettingTiming> = table
    for (let n = parts.length; n > 0; n--) { const t = map[parts.slice(0, n).join('.')]; if (t) return t }
  }
  return undefined
}

const BOTH = 'Applies to teammates and to chats in Build here'
const TEAMMATES_AND_BUILD = 'Applies to teammates and to chats when they switch to Build here'

/** Settings that reach chats with Kernel as well as teammates. A chat in Hand off has no workspace of its own, so these meet it when it switches to Build here (KERNEL-1052). */
const CHAT_AUDIENCE: Record<string, string> = {
  'workspace.mode': TEAMMATES_AND_BUILD,
  'scripts.setupOnCreate': TEAMMATES_AND_BUILD,
  'workspace.oneCurrentBranchPerProject': BOTH
}

/** The muted line for a setting whose change doesn't reach running agents, or undefined when it does. */
export function appliesTo(path: string, projectId?: string): string | undefined {
  if (TERMINAL_TAB_SETTINGS.has(path)) return 'Applies to new terminal tabs'
  if (CHAT_AUDIENCE[path]) return CHAT_AUDIENCE[path]
  const timing = timingOf(path, projectId)
  return timing && APPLIES[timing]
}

/** Is any chat running in the project, or in any project when `projectId` is unset? Read from the store's running chats, never a timer. */
function useChatsRunning(projectId?: string): boolean {
  return useStore((s) => s.workspaces.some((w) => (!projectId || w.projectId === projectId) && (s.chats[w.id] ?? []).some((c) => s.running[c.id])))
}

export const SHARED_SAVED = 'Saved to settings.toml. Commit it so your team gets it.'

/** `shared` is for a note outside a row whose value lives in the tracked settings.toml. A row says so with its own `shared`. */
export function SaveNote({ state, shared }: { state: SaveState; shared?: boolean }) {
  const { timing, projectId, shared: rowShared } = useContext(RowTiming)
  const running = useChatsRunning(projectId)
  if (state.kind === 'idle') return null
  const kept = timing === 'newChats' && running
  const text = state.kind === 'saving' ? 'Saving' : state.kind === 'clamped' ? state.text : shared || rowShared ? SHARED_SAVED : kept ? 'Saved. Running chats keep the old value.' : 'Saved'
  return (
    <span className="set-save" data-state={state.kind} role="status" aria-hidden={state.kind === 'fading' || undefined}>
      {state.kind === 'saving' ? <Spinner label={null} pattern="ripple" /> : state.kind !== 'clamped' && <Icon name="check" size={12} />}
      {text}
    </span>
  )
}

/**
 * The text of a field that saves when it loses focus. A new saved value replaces the text only while the field holds the old one, so a
 * write from outside (settings.toml changed on disk) never takes away what is being typed. A failed save still puts the saved value back,
 * since the rollback lands while the field holds the text it tried to save.
 */
export function useFieldText(saved: string): [string, (t: string) => void] {
  const [text, setText] = useState(saved)
  const last = useRef(saved)
  useEffect(() => {
    const before = last.current
    last.current = saved
    setText((t) => (t === before ? saved : t))
  }, [saved])
  return [text, setText]
}

/**
 * Blur, unmount and Escape for a text field that saves when it loses focus (KERNEL-721). Text still unsaved when the field unmounts
 * (Escape to leave, a shortcut, Cmd+W) saves then. Escape in the field puts the saved text back instead, so nothing saves. `cancel` does the
 * same for an Escape the field never sees, such as the one a modal takes first.
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
  return { onBlur: flush, onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }, cancel }
}

/** Where a section's values are saved: `repo` is `.kernel/settings.toml`, shared with everyone on the repo; `mac` stays on this Mac. */
export type Scope = 'repo' | 'mac'

export function ScopeBadge({ scope }: { scope: Scope }) {
  return <span className="set-badge"><Icon name={scope === 'repo' ? 'team' : 'computer'} size={12} />{scope === 'repo' ? 'Shared with the repo' : 'This Mac only'}</span>
}

/**
 * A heading and a card of rows. `holds` lists the ids of rows inside a `collapsible` section that search can land on: landing on one opens it. `id` makes the section a search target when it holds no single row (the theme picker). `count` is a number after the title, `scope` the badge saying where the values are saved, `note` a
 * muted line beside the heading and `action` a button at its right (Add run script). `footnote` is the line under the card.
 * `collapsible` folds the card behind the heading, open when `defaultOpen`. `plain` leaves out the card, for a table or status line.
 */
export function Section({ id, holds, title, count, scope, note, action, footnote, collapsible, defaultOpen = false, plain, label, children }: {
  id?: string; holds?: string[]; title?: string; count?: number | string; scope?: Scope; note?: ReactNode; action?: ReactNode; footnote?: ReactNode
  collapsible?: boolean; defaultOpen?: boolean; plain?: boolean; label?: string; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  // A search result for a row inside a folded section opens it first, so the row is there to land on.
  const route = useStore((s) => s.ui.route)
  useEffect(() => { if (holds && route.name === 'settings' && route.row && holds.includes(route.row)) setOpen(true) }, [route])
  const shown = !collapsible || open
  const n = count !== undefined && count !== '' && <span className="set-count">{count}</span>
  const heading = collapsible
    ? <button type="button" className="set-fold" aria-expanded={open} onClick={() => setOpen(!open)}><h2>{title}{n}</h2><Icon name="right" size={12} /></button>
    : title && <h2>{title}{n}</h2>
  return (
    <section className="set-section" data-row={id} data-keep-id={id} aria-label={title ? undefined : label}>
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
 * `id` is the row's name in search: a result opens the page, scrolls to the row, highlights it and focuses its control (KERNEL-727).
 * `setting` is the setting's dotted path (`models.leadPlanMode`): a row whose change doesn't reach running agents says so under its description (KERNEL-725),
 * and a Saved note in the row says when running chats keep the old value. On a project page `inherited` says the value is the app's and links to the page it comes from, `changed` says the project sets it, and `onReset` adds Reset, which sends `null` for the key. `shared` is a row saved to the tracked settings.toml, so its Saved note says to commit it.
 * `child` is a row that only matters because of the one above it: it is indented on a guide line. `lead` is a picture before the label
 * (an avatar or a logo). `hover` holds the buttons that show while the pointer is on the row.
 */
export function Row({ id, label, shared, inherited, changed, changedIn, desc, setting, onReset, children, full, className, child, lead, hover, labelId }: {
  id?: string; label: ReactNode; shared?: boolean; inherited?: { to: SettingsTarget; label: string }; changed?: boolean; changedIn?: { id: string; name: string; to: SettingsTarget }[]; desc?: ReactNode; setting?: string; onReset?: () => void; children?: ReactNode; full?: ReactNode; className?: string
  child?: boolean; lead?: ReactNode; hover?: ReactNode; labelId?: string
}) {
  const projectId = useContext(ProjectScope)
  const note = setting ? appliesTo(setting, projectId) : undefined
  const ref = useRef<HTMLDivElement>(null)
  // Reset takes itself away, so focus moves to the row's own control and stays on the row.
  const reset = () => {
    onReset?.()
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input:not([disabled]), button:not(.set-reset):not([disabled]), [role="switch"], [role="radio"]')?.focus(), 0)
  }
  return (
    <RowTiming.Provider value={{ timing: setting ? timingOf(setting, projectId) : undefined, projectId, shared }}>
    <div ref={ref} data-row={id} data-keep-id={id} className={['set-row', child && 'set-child', hover && 'set-hoverable', className].filter(Boolean).join(' ')}>
      {child && <span className="set-guide" aria-hidden="true" />}
      {lead && <span className="set-lead">{lead}</span>}
      <div className="set-text">
        <span className="set-label" id={labelId}>{label}</span>
        {inherited && <span className="set-desc set-from"><SettingsLink variant="quiet" to={inherited.to}>Default, from {inherited.label}</SettingsLink></span>}
        {changed && <span className="set-desc set-from">Changed for this project</span>}
        {changedIn && changedIn.length > 0 && <span className="set-desc set-from">Changed in {changedIn.map((r, i) => <span key={r.id}>{i > 0 && ', '}<SettingsLink variant="quiet" to={r.to}>{r.name}</SettingsLink></span>)}</span>}
        {desc && <span className="set-desc">{desc}</span>}
        {note && <span className="set-desc set-applies">{note}</span>}
      </div>
      {hover && <span className="set-acts">{hover}</span>}
      {onReset && <Button variant="ghost" className="set-reset" aria-label={`Reset ${typeof label === 'string' ? label : 'setting'}`} onClick={reset}>Reset</Button>}
      {children}
      {full && <div className="set-full">{full}</div>}
    </div>
    </RowTiming.Provider>
  )
}

/** A status at the top of a page or section: an icon, what is true now, a line under it and one action (Hooks, a project's push access). */
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
    <div className="set-card set-table" role="table" aria-label={label} style={{ gridTemplateColumns: template }}>
      <div className="set-table-head" role="row">
        {columns.map((c) => <span key={c} role="columnheader">{c}</span>)}
        <span role="columnheader" aria-label="Actions" />
      </div>
      {rows.map((r) => (
        <div key={r.key} className="set-table-row" role="row">
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
          <button type="button" className="set-tag-x" aria-label={`Remove ${t}`} disabled={disabled} onClick={() => onChange(value.filter((v) => v !== t))}><Icon name="close" size={12} /></button>
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

/** Where a Settings link goes: an app page, or a project's page with its section. */
export type SettingsTarget = { page: SettingsPage; projectId?: string; section?: ProjectSettingsSection; agentId?: string; row?: string }

/** "Settings, Models and effort" you can click: a cross-reference to another Settings page (KERNEL-680). */
export function SettingsLink({ to, children, variant }: { to: SettingsTarget; children: ReactNode; variant?: LinkVariant }) {
  return <LinkButton variant={variant} onClick={() => go({ name: 'settings', ...to })}>{children}</LinkButton>
}

export function Keys({ keys }: { keys: string[] }) {
  return <span className="set-keys">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
}

/** A page for a repo's settings when there is no repo to read them from yet. */
export function NoProject() {
  return (
    <Page title="No project yet">
      <EmptyState icon="projects" title="These settings belong to a repo" action={<Button variant="primary" icon="plus" onClick={() => openNewProject()}>New project</Button>}>Add a project and its settings show up here.</EmptyState>
    </Page>
  )
}

/** Does this project set the value itself (in its personal file, with or without settings.toml)? Those are the values Reset can drop. */
export const isOverride = (rs: ProjectSettings | null, path: string) => rs?.sources?.[path] === 'local' || rs?.sources?.[path] === 'override'

/**
 * The row props that say where a project's value comes from, the same on every project page: a value the project sets, in its personal file or in the repo's
 * settings.toml, says "Changed for this project". Reset only shows when the personal file sets it, since it can't remove a value from settings.toml.
 * A project that sets nothing shows the app's value with a link to where it is set (`from`). A value with no app default passes no `from`.
 */
export function projectValue(rs: ProjectSettings | null, path: string, reset: () => void, from?: { to: SettingsTarget; label: string }) {
  if (isOverride(rs, path)) return { changed: true, onReset: reset }
  if (rs?.sources?.[path] === 'shared') return { changed: true }
  return from ? { inherited: from } : {}
}

/** The project a project page shows, with its settings. `project` is undefined when the route's project is gone. */
export function useProjectPage(projectId?: string): { project: Project | undefined; rs: ProjectSettings | null } {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
  return { project, rs: useProjectSettings(projectId) }
}

/**
 * The button at the top right of a project page: it opens settings.local.toml, and its menu opens settings.toml.
 * Only a file that exists is offered, and `sources` says which do: a value from settings.toml means that file is there.
 * `shared` is a page whose values only settings.toml holds (Reviews, KERNEL-557): it opens that file first, and offers it even when no
 * value in `sources` came from it, since `[review]` isn't one of them.
 */
function OpenSettingsFiles({ project, rs, shared }: { project: Project; rs: ProjectSettings | null; shared?: boolean }) {
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
    try { await call('system.openInEditor', { path: `${project.path}/.kernel/${file}` }) } catch (e) { actions.ui.toast({ title: `Could not open ${file}`, sub: cleanError(e) }) }
  })
  return (
    <div className="set-files" ref={anchor}>
      {more.length === 0 ? (
        <Button icon="doc" busy={busy === 'open'} busyLabel="Opening" onClick={() => void edit(first)}>Open {first}</Button>
      ) : (
        <SplitButton
          icon="doc"
          busy={busy === 'open'}
          busyLabel="Opening"
          onClick={() => void edit(first)}
          caretLabel="More files"
          expanded={open}
          onCaret={() => actions.ui.toggleMenu('settingsFiles')}
          caretDisabled={busy !== null}
        >
          Open {first}
        </SplitButton>
      )}
      {open && <Menu label="More files" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 34, width: 224 }} items={more.map((f) => ({ id: f, label: `Open ${f}`, icon: 'doc' as const, onSelect: () => void edit(f) }))} />}
    </div>
  )
}

/**
 * A project page: the project and the page's name as a breadcrumb, the settings files button, and the sections. The project's name goes back to
 * its General page. `shared` is a page the team shares, so its file button opens settings.toml first.
 */
export function ProjectPage({ project, rs, title, shared, note, children }: { project: Project; rs: ProjectSettings | null; title: string; shared?: boolean; note?: ReactNode; children: ReactNode }) {
  const crumb = <button type="button" className="set-crumb" aria-label={`${project.name} settings`} onClick={() => go({ name: 'settings', page: 'project', projectId: project.id })}>{project.name}</button>
  return <ProjectScope.Provider value={project.id}><Page title={title} crumb={crumb} note={note} action={<OpenSettingsFiles project={project} rs={rs} shared={shared} />}>{children}</Page></ProjectScope.Provider>
}
