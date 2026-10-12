import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, FileEntry, PrCheck, PrInfo, ScriptLine, Workspace } from '@shared/types'
import { call } from '../../api'
import { isLeadWorkspace, leadOf } from '../../lead'
import { actions, go, useStore, type State } from '../../store'
import { Button, Icon, IconButton, Menu, MENU_SEPARATOR, SegmentedControl, Tabs, useBusy, type MenuEntry } from '../../ui'
import { stripRemote } from '../settings/remote'
import { useRemote, useRoomSettings } from '../settings/useSettings'
import { attempt } from './MessageActions'
import { LeadPrs } from './pr/LeadPrs'
import { OUTSIDE_THE_REPO } from './pr/model'
import { useLeadPrs } from './pr/leadPrList'
import { SharedPanel, sharedHere } from './shared/SharedPanel'
import { configuredTargets, detectedTarget, detectedUrl, openTarget, type PreviewTarget } from './previewUrls'
import { pickerNames, runningRuns } from './runScripts'
import { TerminalView } from './terminal/Terminal'
import { FileIcon } from '../../components/FileIcon'
import { FileTree } from './FileTree'
import { gitDecoration } from './gitStatus'
import { changesToEntries, openByDefault } from './tree'

const split = (path: string) => { const i = path.lastIndexOf('/'); return { dir: path.slice(0, i), name: path.slice(i + 1) } }

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
  const root = useStore((s) => s.rooms.find((r) => r.id === ws.roomId)?.name) ?? split(ws.path.replace(/\/+$/, '')).name
  useEffect(() => {
    let live = true
    call('workspaces.tree', { workspaceId: ws.id }).then((t) => { if (live) { setTree(t); setFailed(false) } }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [ws.id, changes])
  const initial = useMemo(() => openByDefault(tree), [tree])
  const expanded = open ?? initial
  const toggle = (path: string) => { const next = new Set(expanded); if (next.has(path)) next.delete(path); else next.add(path); setOpen(next) }
  if (failed) return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Could not list files</span><span>Try again in a moment.</span></div>
  return (
    <div className="panel-scroll" style={{ padding: '0 8px 8px' }}>
      <div className="tree-head">
        <span className="grow ellipsis">{root}</span>
        <IconButton icon="collapse" size={14} label="Collapse all folders" onClick={() => setOpen(new Set())} />
      </div>
      <FileTree label="All files" entries={tree} expanded={expanded} onToggle={toggle} onOpen={onOpenFile} activePath={activePath} />
    </div>
  )
}

// ---------- Changes

/** One changed file the way VS Code's Source Control lists it: icon, name in its git color, the folder after it, the counts, then the letter. */
function ChangeRow({ f, active, onOpen }: { f: ChangedFile; active: boolean; onOpen: () => void }) {
  const { dir, name } = split(f.path)
  const deco = gitDecoration(f.status)
  return (
    <button type="button" className="tree-row change-row" aria-current={active || undefined} onClick={onOpen}>
      <FileIcon path={f.path} />
      <span className="tree-name ellipsis">
        <span data-struck={deco?.struck || undefined} style={deco ? { color: deco.color } : undefined}>{name}</span>
        {dir && <span className="change-dir">{dir}</span>}
      </span>
      <Counts f={f} />
      {deco && <span className="tree-letter" style={{ color: deco.color }} aria-label={deco.label}>{deco.letter}</span>}
    </button>
  )
}

function ChangesList({ ws, changes, onOpenDiff, activePath }: { ws: Workspace; changes: ChangedFile[]; onOpenDiff: (path: string) => void; activePath?: string }) {
  const view = useStore((s) => s.ui.workspace.changesView ?? 'list')
  const entries = useMemo(() => changesToEntries(changes), [changes])
  const byPath = useMemo(() => new Map(changes.map((f) => [f.path, f])), [changes])
  // Every folder of the tree starts open. This keeps the ones closed by hand.
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const expanded = useMemo(() => new Set(entries.filter((e) => e.dir && !closed.has(e.path)).map((e) => e.path)), [entries, closed])
  const toggle = (path: string) => { const next = new Set(closed); if (next.has(path)) next.delete(path); else next.add(path); setClosed(next) }
  if (!changes.length) return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>No file changes yet</span><span>Changes appear here.</span></div>
  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)
  return (
    <div className="panel-scroll" style={{ padding: '4px 10px' }}>
      <div className="changes-head">
        <span className="changes-count">{changes.length} {changes.length === 1 ? 'file' : 'files'} changed</span>
        <span className="grow" />
        <span className="mono changes-total">{added ? <span className="add">+{added}</span> : null}{removed ? <span className="del">-{removed}</span> : null}</span>
        <IconButton icon="listTree" size={14} label="View as tree" aria-pressed={view === 'tree'} onClick={() => actions.ui.setChangesView(view === 'tree' ? 'list' : 'tree')} />
        <Button className="small" onClick={() => onOpenDiff('')}>Review all</Button>
      </div>
      {view === 'tree'
        ? <FileTree label="Changed files" entries={entries} expanded={expanded} onToggle={toggle} onOpen={onOpenDiff} activePath={activePath} trailing={(e) => <Counts f={byPath.get(e.path)} />} />
        : changes.map((f) => <ChangeRow key={f.path} f={f} active={f.path === activePath} onOpen={() => onOpenDiff(f.path)} />)}
      {ws.mode === 'current' && <p className="muted" style={{ margin: '8px 6px 0', fontSize: 12 }}>Changes from before this workspace started are hidden.</p>}
    </div>
  )
}

// ---------- Checks

type CheckState = 'ok' | 'run' | 'idle' | 'fail' | 'warn'
interface CheckRow { state: CheckState; label: string; meta?: string; dim?: boolean }

const ciState: Record<PrCheck['state'], CheckState> = { pass: 'ok', fail: 'fail', running: 'run', queued: 'run', skipped: 'idle' }

function CheckIcon({ state }: { state: CheckState }) {
  if (state === 'run') return <span className="spin" role="status" aria-label="Running" style={{ margin: '0 1px' }} />
  const icon = state === 'ok' ? 'check' : state === 'fail' ? 'x' : state === 'warn' ? 'warning' : 'minus'
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

/** `remote` is the room's git remote, which a base ref like `origin/main` names. */
export function checkGroups(ws: Workspace, changes: ChangedFile[], pr?: PrInfo, remote = 'origin'): { title: string; rows: CheckRow[] }[] {
  const hasPr = !!ws.prNumber
  const base = stripRemote(ws.baseRef, remote)
  const merged = ws.prState === 'merged'
  const conflict = ws.prState === 'conflict'
  const git: CheckRow = conflict
    ? { state: 'warn', label: `${pr?.conflicts.length || 1} ${(pr?.conflicts.length || 1) === 1 ? 'conflict' : 'conflicts'} with ${base}` }
    : { state: 'ok', label: merged ? `Merged into ${base}` : `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed, up to date with ${base}` }
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
          <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>
        </button>
        {/* The menu waits for the room's settings, so it opens with its first row focused and not the one row it had before they loaded. */}
        {menuOpen && rs && <Menu label="Open preview" heading="Preview URLs" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: -10, top: 30, width: 300 }} items={items} />}
      </span>
    </span>
  )
}

function Checks({ ws, changes }: { ws: Workspace; changes: ChangedFile[] }) {
  const pr = useStore((s) => s.prs[ws.id])
  const groups = checkGroups(ws, changes, pr, useRemote(ws.roomId))
  return (
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
  )
}

/** `filePath` and `diffPath` are the file and diff tabs showing in the center, drawn selected in All files and Changes. */
export function RightPanel({ ws, changes, onOpenFile, onOpenDiff, filePath, diffPath }: { ws: Workspace; changes: ChangedFile[]; onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void; filePath?: string; diffPath?: string }) {
  // The Lead's workspace keeps its own tab, and PRs is the one only it has: elsewhere `prs` falls back to Changes, the way Shared does (KERNEL-354).
  const isLead = useStore((s) => isLeadWorkspace(ws, ws.roomId, leadOf(s.agents, ws.roomId)?.id))
  const shown = useStore((s) => (isLead ? s.ui.workspace.leadRight ?? 'prs' : s.ui.workspace.right))
  const ready = useLeadPrs(isLead ? ws.roomId : '').filter((r) => r.ready).length
  const shared = useStore((s) => sharedHere(s, ws).length)
  // The Shared tab is there once a file has been shared, or while sharing is on, so a room that never shares one sees nothing of it.
  const sharing = useStore((s) => !!s.settings?.experimental.sharing) || shared > 0
  const right = (shown === 'shared' && !sharing) || (shown === 'prs' && !isLead) ? 'changes' : shown
  // The Lead's strip takes LeadPrs.png's tabs: a plain faint count, where a teammate's keeps the mono one.
  const count = (n: number) => <span className={isLead ? 'tab-count' : 'mono muted'} style={isLead ? undefined : { fontSize: 11.5 }}>{n}</span>
  // While setup runs or has failed there is nothing to show here yet, so the files fold to their tabs and the log below takes the height.
  // Picking a tab or Show files opens them again (KERNEL-430).
  const [opened, setOpened] = useState<string>()
  const folded = setupFolds(ws) && opened !== ws.id
  const pick = (id: string) => { setOpened(ws.id); actions.ui.setWorkspaceView(isLead ? { leadRight: id as typeof right } : { right: id as typeof right }) }
  return (
    <div className={folded ? 'col' : 'col grow'} style={{ minHeight: 0 }}>
      <div className="panel-tabs" data-lead={isLead || undefined}>
        <Tabs label="Workspace panel" value={folded ? '' : right} onChange={pick} tabs={[
          // No count with nothing ready, as LeadPrsEmpty and LeadPrsNoneReady draw it (KERNEL-411).
          ...(isLead ? [{ id: 'prs', label: ready ? <>PRs {count(ready)}</> : 'PRs' }] : []),
          { id: 'files', label: 'All files' },
          { id: 'changes', label: <>Changes {count(changes.length)}</> },
          { id: 'checks', label: 'Checks' },
          ...(sharing ? [{ id: 'shared', label: <>Shared {count(shared)}</> }] : [])
        ]} />
        {folded && <><span className="grow" /><IconButton icon="chevron" size={12} label="Show files" onClick={() => setOpened(ws.id)} /></>}
      </div>
      {folded ? null : <>{right === 'prs' && <LeadPrs roomId={ws.roomId} />}
      {right === 'files' && <FilesTree ws={ws} changes={changes} onOpenFile={onOpenFile} activePath={filePath} />}
      {right === 'changes' && <ChangesList ws={ws} changes={changes} onOpenDiff={onOpenDiff} activePath={diffPath} />}
      {right === 'checks' && <Checks ws={ws} changes={changes} />}
      {right === 'shared' && <SharedPanel ws={ws} />}</>}
    </div>
  )
}

// ---------- Setup, Run, Terminal

/** Setup is still running, or failed and holds the chat: the Setup tab is what matters, so the files fold (KERNEL-430). */
const setupFolds = (ws: Workspace) => ws.status === 'setup' || ws.status === 'failed'

/** Setup is running from its first line until it exits. A new start clears the exit, so the lines of its last run don't count as a stop. */
function setupRunning(s: Pick<State, 'scripts' | 'scriptExit'>, workspaceId: string) {
  return (s.scripts[workspaceId] ?? []).some((l) => l.kind === 'setup') && s.scriptExit[workspaceId]?.setup === undefined
}

/** The log follows its end while the reader is within this many px of it. */
const PIN_PX = 80

/** A line keeps its key as older ones drop off the front of the capped log, so only new lines are drawn. */
const lineIds = new WeakMap<ScriptLine, number>()
let lineCount = 0
const lineKey = (l: ScriptLine) => { let k = lineIds.get(l); if (k === undefined) lineIds.set(l, (k = ++lineCount)); return k }

const LogLine = memo(function LogLine({ l }: { l: ScriptLine }) {
  return <div style={{ whiteSpace: 'pre-wrap', color: l.stream === 'stderr' ? 'var(--del)' : l.line.startsWith('$') ? 'var(--ink)' : 'var(--ink-3)' }}>{l.line}</div>
})

export function BottomPanel({ ws }: { ws: Workspace }) {
  const bottom = useStore((s) => s.ui.workspace.bottom)
  const rs = useRoomSettings(ws.roomId)
  // A script that is running stays in the picker, so it can be stopped, even after Settings renamed or removed it or before they load.
  const runningNames = useStore((s) => runningRuns(s, ws.id).join('\n')).split('\n').filter(Boolean)
  const names = pickerNames((rs?.runScripts ?? []).map((r) => r.name), runningNames)
  // The Run tab shows one run script at a time. Each keeps its own output and exit (KERNEL-249).
  const [picked, setPicked] = useState<Record<string, string>>({})
  // Until one is picked, the tab shows a script that is running, else the first.
  const selected = names.includes(picked[ws.id]) ? picked[ws.id] : names.find((n) => runningNames.includes(n)) ?? names[0] ?? 'run'
  const lines = useStore((s) => (s.scripts[ws.id] ?? []).filter((l) => (bottom === 'setup' ? l.kind === 'setup' : l.kind === 'run' && l.name === selected)))
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
  // The log follows new output while the reader is at its end. Scrolling up to read stops it, and a tab or workspace change starts it again.
  const log = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const onLogScroll = () => { const el = log.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_PX }
  useLayoutEffect(() => { pinned.current = true }, [bottom, ws.id, selected])
  useLayoutEffect(() => { const el = log.current; if (el && pinned.current) el.scrollTop = el.scrollHeight }, [lines, bottom, ws.id, selected])
  const addScript = () => go({ name: 'settings', page: 'room', roomId: ws.roomId, section: 'scripts' })
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
        <span className="script-empty-icon"><Icon name="play" size={30} stroke={1.2} /></span>
        <span>Runs on port {ws.port}. Output shows here.</span>
      </div>
    )
    : noSetup ? (
      <div className="script-empty">
        <span className="ink2">No setup script</span>
        <span>This room has no setup script. Add one and new workspaces run it before the agent starts.</span>
        <Button onClick={addScript}>Add setup script</Button>
      </div>
    ) : (
      <div className="script-empty">
        <span className="ink2">No setup output yet</span>
        <span>Setup output appears here after it runs.</span>
        <Button icon="play" busy={busy === 'setup'} busyLabel="Starting" disabled={setupBusy || busy !== null} onClick={() => void start('setup')}>Run setup</Button>
      </div>
    )
  return (
    <div className="bottom-panel" data-tall={setupFolds(ws) || undefined}>
      <div className="bottom-tabs">
        <Tabs label="Scripts" value={bottom} onChange={(id) => actions.ui.setWorkspaceView({ bottom: id as typeof bottom })} tabs={[{ id: 'setup', label: 'Setup' }, { id: 'run', label: 'Run' }, { id: 'terminal', label: 'Terminal' }]} />
        <span className="grow" />
        {/* Running, setup can be stopped. Failed, the chat's card has Run again, so the tab doesn't repeat it (KERNEL-430). */}
        {bottom === 'setup' && setupBusy && <Button className="small" busy={busy === 'stopSetup'} busyLabel="Stopping" disabled={busy !== null} onClick={() => void stopSetup()}>Stop</Button>}
        {bottom === 'setup' && !setupBusy && ws.status !== 'failed' && !noSetup && lines.length > 0 && <Button className="small" busy={busy === 'setup'} busyLabel="Starting" disabled={busy !== null} onClick={() => void start('setup')}>Run setup</Button>}
        {/* Run and Stop are the one action for the script picked on the Run tab, so its empty state has no button of its own. Setup has its own Run setup, so it shows neither. Off the Run tab, Stop names the script, so it can't read as stopping setup. */}
        {bottom !== 'setup' && (selectedRunning
          ? <Button className="small" busy={busy === 'stop'} busyLabel="Stopping" disabled={busy !== null} onClick={() => void stop()}>{bottom === 'run' ? 'Stop' : names.length > 1 ? `Stop ${selected}` : 'Stop run'}</Button>
          : !noRun && <Button className="small" icon="play" busy={busy === 'run'} busyLabel="Starting" disabled={busy !== null} onClick={() => void start('run')}>Run</Button>)}
      </div>
      {bottom === 'run' && names.length > 1 && (
        <div className="run-picker">
          <SegmentedControl label="Run script" value={selected} onChange={(name) => setPicked((p) => ({ ...p, [ws.id]: name }))} options={names.map((name) => ({ value: name, label: name, busy: runningNames.includes(name) }))} />
        </div>
      )}
      {bottom === 'terminal' && <TerminalView id={`shell:${ws.id}`} label="Terminal" compact />}
      {bottom !== 'terminal' && <div ref={log} className="log selectable mono" role="log" aria-label={bottom === 'run' && names.length > 1 ? `${selected} output` : `${bottom} output`} data-empty={lines.length ? undefined : 'true'} onScroll={onLogScroll}>
        {lines.length
          ? lines.map((l) => <LogLine key={lineKey(l)} l={l} />)
          : empty}
      </div>}
    </div>
  )
}
