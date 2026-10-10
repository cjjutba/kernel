import { useEffect, useMemo, useState } from 'react'
import type { ChangedFile, FileEntry, PrCheck, PrInfo, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, setState, useStore } from '../../store'
import { Button, Icon, Tabs } from '../../ui'
import { useRoomSettings } from '../settings/useSettings'
import { attempt } from './MessageActions'
import { TerminalView } from './terminal/Terminal'
import { openByDefault, visibleRows } from './tree'

const stColor = (s?: string) => (s === 'A' ? 'var(--add)' : 'var(--ink-2)')
const split = (path: string) => { const i = path.lastIndexOf('/'); return { dir: path.slice(0, i + 1), name: path.slice(i + 1) } }

// ---------- All files

function FilesTree({ workspaceId, changes, onOpenFile }: { workspaceId: string; changes: ChangedFile[]; onOpenFile: (path: string) => void }) {
  const [tree, setTree] = useState<FileEntry[]>([])
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    call('workspaces.tree', { workspaceId }).then((t) => { if (live) { setTree(t); setFailed(false) } }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [workspaceId, changes])
  const expanded = open ?? openByDefault(tree)
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded])
  const toggle = (path: string) => { const next = new Set(expanded); if (next.has(path)) next.delete(path); else next.add(path); setOpen(next) }
  if (failed) return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Could not list files</span><span>Try again in a moment.</span></div>
  return (
    <div className="panel-scroll" style={{ padding: '2px 8px' }} role="tree" aria-label="All files">
      {rows.map(({ entry, depth, name }) => (
        <button
          key={entry.path} type="button" role="treeitem" aria-level={depth + 1} aria-expanded={entry.dir ? expanded.has(entry.path) : undefined}
          className="tree-row" style={{ paddingLeft: 8 + depth * 14, color: !entry.dir && entry.status ? 'var(--ink)' : 'var(--ink-2)' }}
          onClick={() => (entry.dir ? toggle(entry.path) : onOpenFile(entry.path))}
        >
          <span className="tree-chev" aria-hidden="true">{entry.dir ? (expanded.has(entry.path) ? '▾' : '▸') : ''}</span>
          <span className="grow ellipsis">{name}</span>
          {!entry.dir && entry.status && <span style={{ color: stColor(entry.status) }} aria-label={entry.status === 'A' ? 'Added' : 'Modified'}>{entry.status}</span>}
        </button>
      ))}
    </div>
  )
}

// ---------- Changes

function ChangesList({ ws, changes, onOpenDiff }: { ws: Workspace; changes: ChangedFile[]; onOpenDiff: (path: string) => void }) {
  if (!changes.length) return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>No file changes yet</span><span>Changes appear here.</span></div>
  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)
  return (
    <div className="panel-scroll" style={{ padding: '4px 10px' }}>
      <div className="changes-head">
        <span className="changes-count">{changes.length} {changes.length === 1 ? 'file' : 'files'} changed</span>
        <span className="grow" />
        <span className="mono changes-total">{added ? <span className="add">+{added}</span> : null}{removed ? <span className="del">-{removed}</span> : null}</span>
        <Button className="small" onClick={() => onOpenDiff('')}>Review all</Button>
      </div>
      {changes.map((f) => {
        const { dir, name } = split(f.path)
        return (
          <button key={f.path} type="button" className="change-row" onClick={() => onOpenDiff(f.path)}>
            <span style={{ width: 12, color: stColor(f.status) }}>{f.status}</span>
            <span className="grow ellipsis"><span className="muted">{dir}</span>{name}</span>
            <span style={{ fontSize: 11.5 }}>{f.added ? <span className="add">+{f.added}</span> : null} {f.removed ? <span className="del">-{f.removed}</span> : null}</span>
          </button>
        )
      })}
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

export function checkGroups(ws: Workspace, changes: ChangedFile[], pr?: PrInfo): { title: string; rows: CheckRow[] }[] {
  const hasPr = !!ws.prNumber
  const merged = ws.prState === 'merged'
  const conflict = ws.prState === 'conflict'
  const git: CheckRow = conflict
    ? { state: 'warn', label: `${pr?.conflicts.length || 1} ${(pr?.conflicts.length || 1) === 1 ? 'conflict' : 'conflicts'} with ${ws.baseRef.replace('origin/', '')}` }
    : { state: 'ok', label: merged ? `Merged into ${ws.baseRef.replace('origin/', '')}` : `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed, up to date with ${ws.baseRef.replace('origin/', '')}` }
  const prRow: CheckRow = hasPr
    ? { state: conflict ? 'warn' : 'ok', label: `#${ws.prNumber}${ws.prTitle ? ` ${ws.prTitle}` : ''}`, meta: merged ? 'merged' : ws.prState === 'closed' ? 'closed' : 'open' }
    : { state: 'idle', label: 'No pull request yet', meta: '⌘⇧P', dim: true }
  const ci: CheckRow[] = !hasPr
    ? [{ state: 'idle', label: 'Runs after the PR opens', dim: true }]
    : pr?.checks.length
      ? pr.checks.map((c) => ({ state: ciState[c.state], label: c.name, meta: c.state === 'running' || c.state === 'queued' ? 'running' : c.state === 'fail' ? 'failed' : c.meta }))
      : [{ state: ws.prState === 'checks' ? 'run' : 'idle', label: ws.prState === 'checks' ? 'Checks running' : 'No checks reported', dim: ws.prState !== 'checks' }]
  const groups = [{ title: 'Git', rows: [git] }, { title: 'Pull request', rows: [prRow] }, { title: 'CI', rows: ci }]
  const todos = (pr?.comments ?? []).map((c): CheckRow => ({ state: c.resolved ? 'ok' : 'idle', label: c.body, meta: c.resolved ? '' : 'from review', dim: !c.resolved }))
  return todos.length ? [...groups, { title: 'Todos', rows: todos }] : groups
}

function Checks({ ws, changes }: { ws: Workspace; changes: ChangedFile[] }) {
  const pr = useStore((s) => s.prs[ws.id])
  const groups = checkGroups(ws, changes, pr)
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
      <div className="row muted" style={{ gap: 10, fontSize: 12 }}><span>Port</span><span className="mono ink2">{ws.port}</span></div>
    </div>
  )
}

export function RightPanel({ ws, changes, onOpenFile, onOpenDiff }: { ws: Workspace; changes: ChangedFile[]; onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void }) {
  const right = useStore((s) => s.ui.workspace.right)
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="panel-tabs">
        <Tabs label="Workspace panel" value={right} onChange={(id) => actions.ui.setWorkspaceView({ right: id as typeof right })} tabs={[
          { id: 'files', label: 'All files' },
          { id: 'changes', label: <>Changes <span className="mono muted" style={{ fontSize: 11.5 }}>{changes.length}</span></> },
          { id: 'checks', label: 'Checks' }
        ]} />
      </div>
      {right === 'files' && <FilesTree workspaceId={ws.id} changes={changes} onOpenFile={onOpenFile} />}
      {right === 'changes' && <ChangesList ws={ws} changes={changes} onOpenDiff={onOpenDiff} />}
      {right === 'checks' && <Checks ws={ws} changes={changes} />}
    </div>
  )
}

// ---------- Setup, Run, Terminal

export function BottomPanel({ ws }: { ws: Workspace }) {
  const bottom = useStore((s) => s.ui.workspace.bottom)
  const scriptKind = bottom === 'setup' ? 'setup' : 'run'
  const lines = useStore((s) => (s.scripts[ws.id] ?? []).filter((l) => l.kind === scriptKind))
  const exited = useStore((s) => s.scriptExit[ws.id]?.[scriptKind])
  const running = lines.length > 0 && exited === undefined
  // A room without a setup script never runs one, so the tab says so instead of waiting for output that won't come.
  const rs = useRoomSettings(ws.roomId)
  const noSetup = !!rs && !rs.scripts.setup
  // The run script's Run and Stop stay at the top right on every tab (KERNEL-274), so they read its own state.
  const runRunning = useStore((s) => (s.scripts[ws.id] ?? []).some((l) => l.kind === 'run') && s.scriptExit[ws.id]?.run === undefined)
  const start = (kind: 'setup' | 'run') => {
    // A new run starts clean, so the last exit code no longer says it stopped.
    setState((s) => ({ scriptExit: { ...s.scriptExit, [ws.id]: { ...s.scriptExit[ws.id], [kind]: undefined } } }))
    void attempt(`Could not start ${kind}`, () => call('scripts.run', { workspaceId: ws.id, kind }))
  }
  const addSetup = () => go({ name: 'settings', page: 'scripts', roomId: ws.roomId })
  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <Tabs label="Scripts" value={bottom} onChange={(id) => actions.ui.setWorkspaceView({ bottom: id as typeof bottom })} tabs={[{ id: 'setup', label: 'Setup' }, { id: 'run', label: 'Run' }, { id: 'terminal', label: 'Terminal' }]} />
        <span className="grow" />
        {bottom === 'setup' && !noSetup && lines.length > 0 && <Button className="small" disabled={running} onClick={() => start('setup')}>Run setup</Button>}
        {runRunning
          ? <Button className="small" onClick={() => void attempt('Could not stop', () => call('scripts.stop', { workspaceId: ws.id, kind: 'run' }))}>Stop</Button>
          : <Button className="small" icon="play" onClick={() => start('run')}>Run</Button>}
      </div>
      {bottom === 'terminal' && <TerminalView id={`shell:${ws.id}`} label="Terminal" compact />}
      {bottom !== 'terminal' && lines.length > 0 && <div className="log selectable mono" role="log" aria-label={`${bottom} output`}>
        {lines.map((l, i) => <div key={i} style={{ whiteSpace: 'pre-wrap', color: l.stream === 'stderr' ? 'var(--del)' : l.line.startsWith('$') ? 'var(--ink)' : 'var(--ink-3)' }}>{l.line}</div>)}
      </div>}
      {bottom === 'run' && !lines.length && (
        <div className="script-empty">
          <span className="script-empty-icon"><Icon name="play" size={30} stroke={1.2} /></span>
          <Button onClick={() => start('run')}>Start run script</Button>
          <span>Runs on port {ws.port}. Output shows here.</span>
        </div>
      )}
      {bottom === 'setup' && !lines.length && (noSetup ? (
        <div className="script-empty">
          <span className="ink2">No setup script</span>
          <span>This room has no setup script. Add one and new workspaces run it before the agent starts.</span>
          <Button onClick={addSetup}>Add setup script</Button>
        </div>
      ) : (
        <div className="script-empty">
          <span className="ink2">No setup output yet</span>
          <span>Setup output appears here after it runs.</span>
          <Button icon="play" disabled={running} onClick={() => start('setup')}>Run setup</Button>
        </div>
      ))}
    </div>
  )
}
