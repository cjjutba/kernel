import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type { ChangedFile, FileEntry, PrCheck, PrInfo, ScriptSuggestion, Workspace } from '@shared/types'
import { call } from '../../api'
import { isLeadWorkspace, leadOf, openLeadChat } from '../../lead'
import { collapsedWord } from './bottomWord'
import { actions, go, useStore, type State } from '../../store'
import { Button, Icon, IconButton, Menu, MENU_SEPARATOR, SegmentedControl, Tabs, Spinner, useBusy, type MenuEntry } from '../../ui'
import { stripRemote } from '../settings/remote'
import { patchRoomSettings, useRemote, useRoomSettings } from '../settings/useSettings'
import { attempt } from './MessageActions'
import { LeadPrs } from './pr/LeadPrs'
import { OUTSIDE_THE_REPO, type LocalStand } from './pr/model'
import { useLocalMerge } from './pr/useLocalMerge'
import { SharedPanel, sharedHere } from './shared/SharedPanel'
import { configuredTargets, detectedTarget, detectedUrl, openTarget, type PreviewTarget } from './previewUrls'
import { pickerNames, runningRuns } from './runScripts'
import { TerminalView } from './terminal/Terminal'
import { ScriptView } from './ScriptView'
import { scriptKey } from '@shared/scriptLog'
import { BottomResize } from './BottomResize'
import { bottomKindOf } from './bottomSplit'
import { FileIcon } from '../../components/FileIcon'
import { FileTree } from './FileTree'
import { gitDecoration } from './gitStatus'
import { changesToEntries, openByDefault } from './tree'
import { filterEntries, matchRanges, matchesPath } from './panelFilter'
import { FilterButton, FilterField, Marked, PanelTools, RefreshButton, ToolButton, ToolSlot, usePanelFilter } from './PanelTools'
import { compareEmpty, compareNote, useCompared } from './compare'
import { CompareButton } from './CompareMenu'

const split = (path: string) => { const i = path.lastIndexOf('/'); return { dir: i < 0 ? '' : path.slice(0, i), name: path.slice(i + 1) } }

/** A file's added and removed line counts, as the Changes rows and the Changes tree show them. */
function Counts({ f }: { f?: ChangedFile }) {
  if (!f || (!f.added && !f.removed)) return null
  return <span className="tree-counts mono">{f.added ? <span className="add">+{f.added}</span> : null}{f.removed ? <span className="del">-{f.removed}</span> : null}</span>
}

// ---------- All files

function FilesTree({ ws, changes, onOpenFile, activePath }: { ws: Workspace; changes: ChangedFile[]; onOpenFile: (path: string) => void; activePath?: string }) {
  const [tree, setTree] = useState<FileEntry[]>([])
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [failed, setFailed] = useState(false)
  const filter = usePanelFilter()
  useEffect(() => {
    let live = true
    call('workspaces.tree', { workspaceId: ws.id }).then((t) => { if (live) { setTree(t); setFailed(false) } }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [ws.id, changes])
  const initial = useMemo(() => openByDefault(tree), [tree])
  // Filtering draws every folder with a match open, but the ones the reader closed since.
  const found = useMemo(() => (filter.filtering ? filterEntries(tree, filter.query) : null), [tree, filter.filtering, filter.query])
  const expanded = useMemo(() => (found ? new Set([...found.dirs].filter((d) => !filter.shut.has(d))) : open ?? initial), [found, filter.shut, open, initial])
  const toggle = (path: string) => {
    if (found) return filter.fold(path)
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path); else next.add(path)
    setOpen(next)
  }
  const collapseAll = () => (found ? filter.foldAll(found.dirs) : setOpen(new Set()))
  if (failed) return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Could not list files</span><span>Try again in a moment.</span></div>
  return (
    <>
      <PanelTools>
        <FilterButton filter={filter} label="Filter files" />
        <ToolButton icon="collapse" label="Collapse all folders" onClick={collapseAll} />
      </PanelTools>
      <FilterField filter={filter} label="Filter files" />
      {found && !found.entries.length
        ? <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>No files match</span><span>Try another name or folder.</span></div>
        : (
          <div className="panel-scroll" style={{ padding: '0 8px 8px' }}>
            <FileTree label="All files" entries={found ? found.entries : tree} expanded={expanded} onToggle={toggle} onOpen={onOpenFile} activePath={activePath} />
          </div>
        )}
    </>
  )
}

// ---------- Changes

/** One changed file the way VS Code's Source Control lists it: icon, name in its git color, the folder after it, the counts, then the letter. A renamed file says where it came from. */
function ChangeRow({ f, active, conflicted, ranges, onOpen }: { f: ChangedFile; active: boolean; conflicted?: boolean; ranges: [number, number][]; onOpen: () => void }) {
  const { dir, name } = split(f.path)
  // A file a local merge would conflict in reads C in the diff's red, the letter the merge note lists it with (KERNEL-478).
  const deco = conflicted ? { letter: 'C', label: 'Conflict', color: 'var(--del)', struck: false } : gitDecoration(f.status)
  return (
    <button type="button" className="tree-row change-row" aria-current={active || undefined} data-tip={f.from ? `Renamed from ${f.from}` : undefined} onClick={onOpen}>
      <FileIcon path={f.path} />
      <span className="tree-name ellipsis">
        <span data-struck={deco?.struck || undefined} style={deco ? { color: deco.color } : undefined}><Marked text={name} from={dir ? dir.length + 1 : 0} ranges={ranges} /></span>
        {dir && <span className="change-dir"><Marked text={dir} from={0} ranges={ranges} /></span>}
      </span>
      <Counts f={f} />
      {deco && <span className="tree-letter" style={{ color: deco.color }} aria-label={deco.label}>{deco.letter}</span>}
      {f.from && <span className="sr-only">, renamed from {f.from}</span>}
    </button>
  )
}

const NO_FILES: ChangedFile[] = []

/**
 * `base` is the workspace's changed files. The list shows them, or the files of what the ⋯ menu compares with instead (PanelCompare, KERNEL-517),
 * which the menu's pick and the diff tabs it opens share (compare.ts).
 */
function ChangesList({ ws, changes: base, onOpenDiff, activePath }: { ws: Workspace; changes: ChangedFile[]; onOpenDiff: (path: string) => void; activePath?: string }) {
  const view = useStore((s) => s.ui.workspace.changesView ?? 'list')
  const { compare, files, error } = useCompared(ws, base)
  const changes = files ?? NO_FILES
  const entries = useMemo(() => changesToEntries(changes), [changes])
  const byPath = useMemo(() => new Map(changes.map((f) => [f.path, f])), [changes])
  const local = useLocalMerge(ws)
  const conflicts = useMemo(() => new Set(local?.stand === 'conflict' ? local.info?.conflicts : []), [local])
  const filter = usePanelFilter()
  // Every folder of the tree starts open. This keeps the ones closed by hand.
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  // Filtering narrows the list to the paths that match, and the tree to them and the folders above, all drawn open but the ones the reader closed since.
  const shown = useMemo(() => (filter.filtering ? changes.filter((f) => matchesPath(f.path, filter.query)) : changes), [changes, filter.filtering, filter.query])
  const found = useMemo(() => (filter.filtering ? filterEntries(entries, filter.query) : null), [entries, filter.filtering, filter.query])
  const treeEntries = found ? found.entries : entries
  const expanded = useMemo(() => new Set(treeEntries.filter((e) => e.dir && !(found ? filter.shut : closed).has(e.path)).map((e) => e.path)), [treeEntries, found, filter.shut, closed])
  const toggle = (path: string) => {
    if (found) return filter.fold(path)
    const next = new Set(closed)
    if (next.has(path)) next.delete(path); else next.add(path)
    setClosed(next)
  }
  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)
  const note = compareNote(compare)
  const empty = compareEmpty(compare)
  // The ⋯ stays whatever the list holds, so a pick with no files can be changed. A pick still being read, or one that failed, has no list to act on.
  const listed = files !== null && !error && changes.length > 0
  return (
    <>
      <PanelTools>
        {listed && (
          <>
            <Button className="tool-text" onClick={() => onOpenDiff('')}>Review all</Button>
            <FilterButton filter={filter} label="Filter changed files" />
            <ToolButton icon="listTree" label="View as tree" aria-pressed={view === 'tree'} onClick={() => actions.ui.setChangesView(view === 'tree' ? 'list' : 'tree')} />
          </>
        )}
        <CompareButton ws={ws} compare={compare} />
      </PanelTools>
      {error
        ? <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Could not compare</span><span>{error}</span></div>
        : files === null
          ? null
          : !changes.length
            ? <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>{empty.title}</span><span>{empty.sub}</span></div>
            : (
              <>
                <FilterField filter={filter} label="Filter changed files" />
                <div className="panel-scroll" style={{ padding: '4px 10px' }}>
                  <div className="changes-head">
                    <span className="changes-count">{changes.length} {changes.length === 1 ? 'file' : 'files'} changed{note && ` ${note}`}</span>
                    <span className="grow" />
                    <span className="mono changes-total">{added ? <span className="add">+{added}</span> : null}{removed ? <span className="del">-{removed}</span> : null}</span>
                  </div>
                  {filter.filtering && !shown.length
                    ? <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>No changes match</span><span>Try another name or folder.</span></div>
                    : view === 'tree'
                      ? <FileTree label="Changed files" entries={treeEntries} expanded={expanded} onToggle={toggle} onOpen={onOpenDiff} activePath={activePath} trailing={(e) => <Counts f={byPath.get(e.path)} />} />
                      : shown.map((f) => <ChangeRow key={f.path} f={f} active={f.path === activePath} conflicted={conflicts.has(f.path)} ranges={matchRanges(f.path, filter.query)} onOpen={() => onOpenDiff(f.path)} />)}
                  {ws.mode === 'current' && !note && <p className="muted" style={{ margin: '8px 6px 0', fontSize: 12 }}>Changes from before this workspace started are hidden.</p>}
                </div>
              </>
            )}
    </>
  )
}

// ---------- Checks

type CheckState = 'ok' | 'run' | 'idle' | 'fail' | 'warn'
interface CheckRow { state: CheckState; label: string; meta?: string; dim?: boolean }

const ciState: Record<PrCheck['state'], CheckState> = { pass: 'ok', fail: 'fail', running: 'run', queued: 'run', skipped: 'idle' }

function CheckIcon({ state }: { state: CheckState }) {
  if (state === 'run') return <span style={{ margin: '0 1px', display: 'inline-flex' }}><Spinner label="Running" kind="process" /></span>
  const icon = state === 'ok' ? 'check' : state === 'fail' ? 'close' : state === 'warn' ? 'warning' : 'minus'
  const color = state === 'ok' ? 'var(--add)' : state === 'fail' ? 'var(--del)' : state === 'warn' ? 'var(--ink-2)' : 'var(--faint)'
  return <span style={{ color, display: 'inline-flex' }}><Icon name={icon} size={14} /></span>
}

/**
 * One CI row. A check that doesn't decide the PR says so, and its failure shows the muted warning instead of the red x,
 * since the PR can still merge (KERNEL-388).
 */
export function checkRow(c: PrCheck): CheckRow {
  const word = c.state === 'running' || c.state === 'queued' ? 'running' : c.state === 'fail' ? 'failed' : c.meta
  if (!c.optional) return { state: ciState[c.state], label: c.name, meta: word }
  return { state: c.state === 'fail' ? 'warn' : ciState[c.state], label: c.name, meta: word ? `${word}, optional` : 'optional' }
}

/**
 * `remote` is the room's git remote, which a base ref like `origin/main` names. `local` is set for a branch that merges on the Mac,
 * which has no PR and no checks: Git says how it stands against its base and CI reads "No checks reported", as it does for a PR with none (KERNEL-478).
 */
export function checkGroups(ws: Workspace, changes: ChangedFile[], pr?: PrInfo, remote = 'origin', local?: { stand: LocalStand; base: string }): { title: string; rows: CheckRow[] }[] {
  const hasPr = !!ws.prNumber
  const base = local?.base ?? stripRemote(ws.baseRef, remote)
  const merged = ws.prState === 'merged'
  const conflict = ws.prState === 'conflict'
  const files = `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed`
  const behind = local?.stand === 'behind' ? pr?.local?.behind ?? 0 : 0
  const git: CheckRow = conflict
    ? { state: 'warn', label: `${pr?.conflicts.length || 1} ${(pr?.conflicts.length || 1) === 1 ? 'conflict' : 'conflicts'} with ${base}` }
    : behind
      ? { state: 'idle', label: `${files}, ${behind} behind ${base}` }
      : { state: 'ok', label: merged ? `Merged into ${base}` : `${files}, up to date with ${base}` }
  if (local) return [{ title: 'Git', rows: [git] }, { title: 'CI', rows: [{ state: 'idle', label: 'No checks reported', dim: true }] }]
  const prRow: CheckRow = hasPr
    ? { state: conflict ? 'warn' : 'ok', label: `#${ws.prNumber}${ws.prTitle ? ` ${ws.prTitle}` : ''}`, meta: merged ? 'merged' : ws.prState === 'closed' ? 'closed' : 'open' }
    : { state: 'idle', label: 'No pull request yet', meta: '⌘⇧P', dim: true }
  const ci: CheckRow[] = !hasPr
    ? [{ state: 'idle', label: 'Runs after the PR opens', dim: true }]
    : pr?.checks.length
      ? pr.checks.map(checkRow)
      : [{ state: ws.prState === 'checks' ? 'run' : 'idle', label: ws.prState === 'checks' ? 'Checks running' : 'No checks reported', dim: ws.prState !== 'checks' }]
  const groups = [{ title: 'Git', rows: [git] }, { title: 'Pull request', rows: [prRow] }, { title: 'CI', rows: ci }]
  const todos = (pr?.comments ?? []).map((c): CheckRow => ({ state: c.resolved ? 'ok' : 'idle', label: c.body, meta: c.resolved ? '' : c.association === 'outside' ? OUTSIDE_THE_REPO : 'from review', dim: !c.resolved }))
  return todos.length ? [...groups, { title: 'Todos', rows: todos }] : groups
}

/** Open opens the first preview URL, or the one a run script printed. The caret lists them all (WorkspacePreview.png). */
function OpenPreview({ ws }: { ws: Workspace }) {
  const rs = useRoomSettings(ws.roomId)
  const configured = rs?.preview?.urls ?? []
  const detected = useStore((s) => detectedUrl(s.scriptUrl[ws.id], (rs?.runScripts ?? []).map((r) => r.name)))
  const menuOpen = useStore((s) => s.ui.menu === 'preview')
  const anchor = useRef<HTMLSpanElement>(null)
  const first = openTarget(configured, ws.port, detected)
  const open = (url: string | null) => { if (url) void attempt('Could not open the preview', () => call('system.openExternal', { url })) }
  const entry = (t: PreviewTarget): MenuEntry => ({ id: t.id, label: t.label, shortcut: t.address, disabled: !t.url, onSelect: () => open(t.url) })
  const items: (MenuEntry | typeof MENU_SEPARATOR)[] = [...configuredTargets(configured, ws.port).map(entry), ...(configured.length ? [MENU_SEPARATOR] : []), entry(detectedTarget(detected))]
  return (
    <span className="open-split">
      <button type="button" className="open-main" disabled={!first} onClick={() => open(first)}>Open</button>
      <span ref={anchor} className="open-caret-anchor">
        <button type="button" className="open-caret" aria-label="More preview URLs" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu('preview')}>
          <Icon name="chevron" size={12} />
        </button>
        {/* The menu waits for the room's settings, so it opens with its first row focused and not the one row it had before they loaded. */}
        {menuOpen && rs && <Menu label="Open preview" heading="Preview URLs" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: -10, top: 30, width: 300 }} items={items} />}
      </span>
    </span>
  )
}

/** The PR's Checks page on GitHub, or nothing for a branch with no PR, or one that merges on the Mac. */
export const checksUrl = (prUrl?: string) => (prUrl ? `${prUrl.replace(/\/+$/, '')}/checks` : undefined)

function Checks({ ws, changes }: { ws: Workspace; changes: ChangedFile[] }) {
  const pr = useStore((s) => s.prs[ws.id])
  const local = useLocalMerge(ws)
  const groups = checkGroups(ws, changes, pr, useRemote(ws.roomId), local)
  const url = checksUrl(pr?.url || ws.prUrl)
  return (
    <>
      <PanelTools>
        <RefreshButton ids={[ws.id]} label="Refresh checks" failTitle="Could not refresh checks" />
        <ToolButton icon="ext" label="Open on GitHub" disabled={!url} onClick={() => { if (url) void attempt('Could not open GitHub', () => call('system.openExternal', { url })) }} />
      </PanelTools>
      <div className="panel-scroll" style={{ gap: 14, padding: '6px 16px' }}>
        {groups.map((g) => (
          <div key={g.title} className="col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>{g.title}</span>
            {g.rows.map((r, i) => (
              <div key={i} className="row" style={{ gap: 10, minHeight: 26 }}>
                <CheckIcon state={r.state} />
                <span className="grow ellipsis" style={{ color: r.dim ? 'var(--muted)' : 'var(--ink-2)' }}>{r.label}</span>
                {r.meta && <span className="mono muted" style={{ fontSize: 11.5 }}>{r.meta}</span>}
              </div>
            ))}
          </div>
        ))}
        <div className="row muted" style={{ gap: 10, fontSize: 12 }}><span>Port</span><span className="mono ink2">{ws.port}</span><span className="grow" /><OpenPreview ws={ws} /></div>
      </div>
    </>
  )
}

// ---------- Tab strips

/**
 * A strip of tabs that scrolls sideways when they don't fit (KERNEL-489). A side with hidden tabs fades into the panel and shows an arrow that scrolls to the
 * next one (KERNEL-514). Only the tablist scrolls, so what sits beside the strip stays pinned. The arrows are for the pointer: the tablist's arrow keys already
 * reach every tab, so they stay out of the tab order, and one that goes away can't strand focus.
 */
function TabStrip(props: ComponentProps<typeof Tabs>) {
  const wrap = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ left: false, right: false })
  const ids = props.tabs.map((t) => t.id).join()
  const list = () => wrap.current?.querySelector<HTMLElement>('[role="tablist"]') ?? null

  // Which sides have tabs cut off, again when the strip scrolls, when the panel or a tab changes size and when tabs come and go.
  useLayoutEffect(() => {
    const el = list()
    if (!el) return
    const measure = () => {
      const left = el.scrollLeft > 1
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    for (const tab of el.children) resize.observe(tab)
    return () => { el.removeEventListener('scroll', measure); resize.disconnect() }
  }, [ids])

  // The tab shown scrolls into view when it changes, clear of the fade (KERNEL-489).
  useLayoutEffect(() => { list()?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [props.value, ids])

  // One tab over: the first tab the fade hides on that side comes fully into view, or the last one on that side when the fade only covers part of a tab.
  const step = (dir: 1 | -1) => {
    const el = list()
    if (!el) return
    const fade = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0
    const box = el.getBoundingClientRect()
    const tabs = [...el.children] as HTMLElement[]
    const hidden = (dir > 0 ? tabs : [...tabs].reverse()).find((t) => {
      const r = t.getBoundingClientRect()
      return dir > 0 ? r.left >= box.right - fade : r.right <= box.left + fade
    })
    ;(hidden ?? tabs[dir > 0 ? tabs.length - 1 : 0])?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' })
  }

  return (
    <div ref={wrap} className="tab-strip">
      <Tabs {...props} />
      {more.left && <IconButton icon="right" size={14} label="More tabs" className="tab-more" data-side="left" tabIndex={-1} onClick={() => step(-1)} />}
      {more.right && <IconButton icon="right" size={14} label="More tabs" className="tab-more" data-side="right" tabIndex={-1} onClick={() => step(1)} />}
    </div>
  )
}

/** `filePath` and `diffPath` are the file and diff tabs showing in the center, drawn selected in All files and Changes. */
export function RightPanel({ ws, changes, onOpenFile, onOpenDiff, filePath, diffPath }: { ws: Workspace; changes: ChangedFile[]; onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void; filePath?: string; diffPath?: string }) {
  // The Lead's workspace keeps its own tab, and PRs is the one only it has: elsewhere `prs` falls back to Changes, the way Shared does (KERNEL-354).
  const isLead = useStore((s) => isLeadWorkspace(ws, ws.roomId, leadOf(s.agents, ws.roomId)?.id))
  const shown = useStore((s) => (isLead ? s.ui.workspace.leadRight ?? 'prs' : s.ui.workspace.right))
  const shared = useStore((s) => sharedHere(s, ws).length)
  // The Shared tab is there once a file has been shared, or while sharing is on, so a room that never shares one sees nothing of it.
  const sharing = useStore((s) => !!s.settings?.experimental.sharing) || shared > 0
  const right = (shown === 'shared' && !sharing) || (shown === 'prs' && !isLead) ? 'changes' : shown
  // The Lead's strip takes LeadPrs.png's tabs: a plain faint count, where a teammate's keeps the mono one.
  const count = (n: number) => <span className={isLead ? 'tab-count' : 'mono muted'} style={isLead ? undefined : { fontSize: 11.5 }}>{n}</span>
  const pick = (id: string) => actions.ui.setWorkspaceView(isLead ? { leadRight: id as typeof right } : { right: id as typeof right })
  // The strip's right side belongs to the tab on show: it draws its buttons into this element (PanelTools). Files and Changes are keyed by workspace, so a new one starts without a filter.
  const [tools, setTools] = useState<HTMLDivElement | null>(null)
  return (
    <ToolSlot.Provider value={tools}>
      <div className="col grow" style={{ minHeight: 0 }}>
        <div className="panel-tabs" data-lead={isLead || undefined}>
          <TabStrip label="Workspace panel" value={right} onChange={pick} tabs={[
            // The PRs tab has no count: the band and the Ready to merge heading show it.
            ...(isLead ? [{ id: 'prs', label: 'PRs' }] : []),
            { id: 'files', label: 'All files' },
            { id: 'changes', label: <>Changes {count(changes.length)}</> },
            { id: 'checks', label: 'Checks' },
            ...(sharing ? [{ id: 'shared', label: <>Shared {count(shared)}</> }] : [])
          ]} />
          <div ref={setTools} className="panel-tools" role="toolbar" aria-label="Panel actions" />
        </div>
        {right === 'prs' && <LeadPrs roomId={ws.roomId} />}
        {right === 'files' && <FilesTree key={ws.id} ws={ws} changes={changes} onOpenFile={onOpenFile} activePath={filePath} />}
        {right === 'changes' && <ChangesList key={ws.id} ws={ws} changes={changes} onOpenDiff={onOpenDiff} activePath={diffPath} />}
        {right === 'checks' && <Checks ws={ws} changes={changes} />}
        {right === 'shared' && <SharedPanel ws={ws} />}
      </div>
    </ToolSlot.Provider>
  )
}

// ---------- Setup, Run, Terminal

/** Setup is running from its first line until it exits. A new start clears the exit, so the lines of its last run don't count as a stop. */
function setupRunning(s: Pick<State, 'scripts' | 'scriptExit'>, workspaceId: string) {
  return (s.scripts[workspaceId] ?? []).some((l) => l.kind === 'setup') && s.scriptExit[workspaceId]?.setup === undefined
}

/** What `scripts.suggest` found for the room (KERNEL-682). Empty until the first answer, and on a failed read. */
function useSuggestions(roomId: string) {
  const [found, setFound] = useState<ScriptSuggestion[]>([])
  useEffect(() => {
    let live = true
    setFound([])
    call('scripts.suggest', { roomId }).then((next) => { if (live) setFound(next) }, () => {})
    return () => { live = false }
  }, [roomId])
  return found
}

/** The Setup tab of a room with no setup script: take Kernel's suggestion, ask the Lead to write one, or type it in Settings (KERNEL-685). */
function AddSetup({ roomId, onManual }: { roomId: string; onManual: () => void }) {
  const found = useSuggestions(roomId)
  const lead = useStore((s) => leadOf(s.agents, roomId)?.name ?? 'Kernel')
  const [busy, doing] = useBusy<'use' | 'ask'>()
  // The first suggestion that has a setup script, in the order the engine returns them.
  const pick = found.find((s) => s.patch.scripts?.setup)
  const ask = () => doing('ask', () => attempt(`Could not ask ${lead}`, async () => {
    const chat = await call('scripts.askLead', { roomId })
    await openLeadChat(roomId, chat.id)
  }))
  return (
    <div className="script-empty add-setup">
      <span className="ink2">Add setup script</span>
      <span>Runs when a workspace is created, to install dependencies or set up the environment.</span>
      {pick && (
        <div className="add-setup-pick">
          <div className="add-setup-head">
            <span>{pick.source === 'detected' ? `Detected from ${pick.file}` : `From ${pick.file}`}</span>
            <Button className="small" aria-label="Use the suggested setup script" busy={busy === 'use'} busyLabel="Saving" disabled={busy !== null} onClick={() => void doing('use', () => patchRoomSettings(roomId, pick.patch))}>Use</Button>
          </div>
          <pre className="add-setup-script">{pick.patch.scripts?.setup}</pre>
          {pick.notes.slice(0, 1).map((n) => <span key={n} className="add-setup-note" title={n}>{n}</span>)}
        </div>
      )}
      <div className="add-setup-actions">
        <Button busy={busy === 'ask'} busyLabel="Starting" disabled={busy !== null} onClick={() => void ask()}>Ask {lead}</Button>
        <Button variant="ghost" disabled={busy !== null} onClick={onManual}>Add manually</Button>
      </div>
    </div>
  )
}

/**
 * The bottom pane: Setup, Run and Terminal under the files, a third of the panel until it is dragged (KERNEL-513). The chevron folds it to its tab bar, and
 * pressing a tab opens it again. Lead chats and teammates' workspaces each remember whether it is folded.
 */
export function BottomPanel({ ws }: { ws: Workspace }) {
  const bottom = useStore((s) => s.ui.workspace.bottom)
  const kind = useStore((s) => bottomKindOf(s, ws))
  const collapsed = useStore((s) => s.ui.bottomCollapsed[kind])
  const panel = useRef<HTMLDivElement>(null)
  const pick = (id: string) => {
    actions.ui.setWorkspaceView({ bottom: id as typeof bottom })
    if (collapsed) actions.ui.setBottomCollapsed(kind, false)
  }
  const rs = useRoomSettings(ws.roomId)
  // A script that is running stays in the picker, so it can be stopped, even after Settings renamed or removed it or before they load.
  const runningNames = useStore((s) => runningRuns(s, ws.id).join('\n')).split('\n').filter(Boolean)
  const names = pickerNames((rs?.runScripts ?? []).map((r) => r.name), runningNames)
  // The Run tab shows one run script at a time. Each keeps its own output and exit (KERNEL-249).
  const [picked, setPicked] = useState<Record<string, string>>({})
  // Until one is picked, the tab shows a script that is running, else the first.
  const selected = names.includes(picked[ws.id]) ? picked[ws.id] : names.find((n) => runningNames.includes(n)) ?? names[0] ?? 'run'
  const scriptName = bottom === 'run' ? selected : undefined
  const dataKey = scriptKey(bottom === 'run' ? 'run' : 'setup', scriptName)
  const fallback = useStore((s) => (s.scripts[ws.id] ?? []).filter((l) => (bottom === 'setup' ? l.kind === 'setup' : l.kind === 'run' && l.name === selected)).map((l) => l.line + '\r\n').join(''))
  const output = useStore((s) => s.scriptData[ws.id]?.[dataKey] ?? '') || fallback
  const hasOutput = output.length > 0
  const logLabel = bottom === 'run' && names.length > 1 ? `${selected} output` : `${bottom} output`
  const setupBusy = useStore((s) => setupRunning(s, ws.id))
  const selectedRunning = runningNames.includes(selected)
  // A room without a setup script never runs one, so the tab says so instead of waiting for output that won't come.
  const noSetup = !!rs && !rs.scripts.setup
  const noRun = !!rs && names.length === 0
  const [busy, doing] = useBusy<'setup' | 'run' | 'stop' | 'stopSetup'>()
  const start = (kind: 'setup' | 'run') => doing(kind, async () => {
    actions.workspaces.clearScriptExit(ws.id, kind, kind === 'run' ? selected : undefined)
    await attempt(`Could not start ${kind === 'run' ? selected : kind}`, () => call('scripts.run', { workspaceId: ws.id, kind, ...(kind === 'run' && { name: selected }) }))
  })
  const stopSetup = () => doing('stopSetup', () => attempt('Could not stop setup', () => call('scripts.stop', { workspaceId: ws.id, kind: 'setup' })))
  const stop = () => doing('stop', () => attempt(`Could not stop ${selected}`, () => call('scripts.stop', { workspaceId: ws.id, kind: 'run', name: selected })))
  const addScript = () => go({ name: 'settings', page: 'room', roomId: ws.roomId, section: 'setup' })
  // The Run tab's empty state has the Run button, so the strip's steps aside while it shows and the word is never on screen twice (KERNEL-512).
  const onRunTab = !collapsed && bottom === 'run'
  const runEmpty = onRunTab && !noRun && !hasOutput
  // The log stays mounted, so its first lines are announced; an empty one shows what to do instead (KERNEL-274).
  const empty = bottom === 'run'
    ? noRun ? (
      <div className="script-empty">
        <span className="ink2">No run script</span>
        <span>This room has no run script. Add one to start the app from here, on its own port.</span>
        <Button onClick={addScript}>Add run script</Button>
      </div>
    ) : (
      <div className="script-empty">
        <span className="script-empty-icon"><Icon name="play" size={20} /></span>
        {!selectedRunning && <Button className="idle-run" busy={busy === 'run'} busyLabel="Starting" disabled={busy !== null} onClick={() => void start('run')}>Run</Button>}
        <span>Runs on port {ws.port}. Output shows here.</span>
      </div>
    )
    : noSetup ? (
      <AddSetup roomId={ws.roomId} onManual={addScript} />
    ) : (
      <div className="script-empty">
        <span className="ink2">No setup output yet</span>
        <span>Setup output appears here after it runs.</span>
        <Button icon="play" busy={busy === 'setup'} busyLabel="Starting" disabled={setupBusy || busy !== null} onClick={() => void start('setup')}>Run setup</Button>
      </div>
    )
  return (
    <div ref={panel} className="bottom-panel" data-collapsed={collapsed || undefined}>
      {!collapsed && <BottomResize panel={panel} />}
      <div className="bottom-tabs">
        <IconButton icon="chevron" size={14} label={collapsed ? 'Expand bottom panel' : 'Collapse bottom panel'} aria-expanded={!collapsed} data-tip-kbd="⌘J" onClick={() => actions.ui.setBottomCollapsed(kind, !collapsed)} />
        <TabStrip label="Scripts" value={collapsed ? '' : bottom} onChange={pick} tabs={[{ id: 'setup', label: 'Setup' }, { id: 'run', label: 'Run' }, { id: 'terminal', label: 'Terminal' }]} />
        {/* Folded, the bar says what the scripts are doing, so you can tell the app is up without opening it (KERNEL-529). */}
        {collapsed && <span className="bottom-word" role="status">{collapsedWord({ setupRunning: setupBusy, setupFailed: ws.status === 'failed', running: runningNames, scripts: names.length, noRun, port: ws.port })}</span>}
        {/* Running, setup can be stopped. Failed, the chat's card has Run again, so the tab doesn't repeat it (KERNEL-430). */}
        {!collapsed && bottom === 'setup' && setupBusy && <Button className="small" busy={busy === 'stopSetup'} busyLabel="Stopping" disabled={busy !== null} onClick={() => void stopSetup()}>Stop</Button>}
        {!collapsed && bottom === 'setup' && !setupBusy && ws.status !== 'failed' && !noSetup && hasOutput && <Button className="small" busy={busy === 'setup'} busyLabel="Starting" disabled={busy !== null} onClick={() => void start('setup')}>Run setup</Button>}
        {/* Run and Stop are the one action for the script picked on the Run tab. Its empty state has a Run button of its own, so the strip's Run steps aside while that shows (KERNEL-512). A collapsed bar has no empty state, so it keeps Run and Stop. Setup has its own Run setup, so it shows neither. Off the Run tab, Stop names the script, so it can't read as stopping setup. */}
        {(collapsed || bottom !== 'setup') && (selectedRunning
          ? <Button className="small" busy={busy === 'stop'} busyLabel="Stopping" disabled={busy !== null} onClick={() => void stop()}>{onRunTab ? 'Stop' : names.length > 1 ? `Stop ${selected}` : 'Stop run'}</Button>
          : !noRun && !runEmpty && <Button className="small" icon="play" busy={busy === 'run'} busyLabel="Starting" disabled={busy !== null} onClick={() => void start('run')}>Run</Button>)}
      </div>
      {!collapsed && bottom === 'run' && names.length > 1 && (
        <div className="run-picker">
          <SegmentedControl label="Run script" value={selected} onChange={(name) => setPicked((p) => ({ ...p, [ws.id]: name }))} options={names.map((name) => ({ value: name, label: name, busy: runningNames.includes(name) }))} />
        </div>
      )}
      {!collapsed && bottom === 'terminal' && <TerminalView id={`shell:${ws.id}`} label="Terminal" compact />}
      {!collapsed && bottom !== 'terminal' && (hasOutput
        ? <ScriptView key={`${ws.id}:${dataKey}`} workspaceId={ws.id} kind={bottom === 'run' ? 'run' : 'setup'} name={scriptName} label={logLabel} fallback={fallback} />
        : <div className="log selectable mono" role="log" aria-label={logLabel} data-empty="true">{empty}</div>)}
    </div>
  )
}
