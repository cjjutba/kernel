import { useEffect, useMemo, useRef, useState } from 'react'
import type { Effort, ModelId, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { MODELS } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadWorkspace, useStore } from '../../store'
import { Button, Icon, Menu, Modal, useBusy } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { DraftInput, useDraft } from '../workspace/composer/draft'
import { ModelPicker } from '../workspace/composer/ModelPicker'
import { effortFor } from '@shared/effort'
import { effortLabel as labelOf, rememberEffort, useDefaultEffort, useEffortMemory } from '../workspace/composer/modelPrefs'
import { PlusMenu, type PlusPanel } from '../workspace/composer/PlusMenu'
import '../workspace/composer/composer.css'
import { FromPopover } from './FromPopover'
import { sourceLabel, targetOptions, type FromRow, type FromTab } from './pick'
import './newWorkspace.css'

const MODES: { id: WorkspaceMode; label: string; hint: string }[] = [
  { id: 'worktree', label: 'New worktree', hint: 'An isolated copy on its own branch, named from your task.' },
  { id: 'current', label: 'Current branch', hint: 'Works in your checkout. Changes already there are kept and left out of the diff.' }
]

/** "Client A" is A, "Own app" is O. */
const letter = (name = '') => { const w = name.trim().split(/\s+/); const l = w[w.length - 1]; return (l.length === 1 ? l : w[0]).charAt(0).toUpperCase() || '?' }

const reason = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * "What do you want to work on?" (NewWorkspace.png and its four popovers). It always goes to the room's Lead,
 * who names the branch from the task, so there is no agent picker. Cmd+Enter creates.
 */
export function NewWorkspace({ roomId, source: initial }: { roomId?: string; source?: WorkspaceSource }) {
  const rooms = useStore((s) => s.rooms)
  const settings = useStore((s) => s.settings)
  const menu = useStore((s) => s.ui.menu)
  const [room, setRoom] = useState(roomId ?? rooms[0]?.id ?? '')
  const [roomMenu, setRoomMenu] = useState(false)
  const [source, setSource] = useState<WorkspaceSource | null>(initial ?? null)
  /** The prompt a picked source wrote, replaced by the next pick or cleared with the source until you edit it. */
  const [filled, setFilled] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [mode, setMode] = useState<WorkspaceMode>(settings?.workspace.mode ?? 'worktree')
  const [model, setModel] = useState<ModelId>(settings?.models.engineers ?? 'claude-sonnet-5-5')
  const memory = useEffortMemory()
  const defaultEffort = useDefaultEffort()
  // The picker shows each model at its remembered effort, so the modal starts there too.
  const [effort, setEffort] = useState<Effort>(() => effortFor(model, memory, defaultEffort))
  const [plan, setPlan] = useState(settings?.models.workspacePlanMode ?? false)
  const d = useDraft()
  const [branches, setBranches] = useState<string[]>([])
  const [tab, setTab] = useState<FromTab>('prs')
  const [creating, run] = useBusy()
  const busy = creating !== null
  const [error, setError] = useState<{ message: string; open?: string } | null>(null)

  const current = rooms.find((r) => r.id === room)
  const fallback = `origin/${current?.defaultBranch ?? 'main'}`
  const target = baseRef || fallback
  const targets = useMemo(() => targetOptions(branches, fallback, target), [branches, fallback, target])
  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0]
  const label = sourceLabel(source)
  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model
  const effortLabel = labelOf(effort)

  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const roomAnchor = useRef<HTMLSpanElement>(null)
  const branchAnchor = useRef<HTMLSpanElement>(null)
  const fromAnchor = useRef<HTMLSpanElement>(null)
  const filePick = useRef<HTMLInputElement>(null)

  // The modal shell focuses its first control. The prompt is where typing starts.
  useEffect(() => { const t = requestAnimationFrame(() => d.focus()); return () => cancelAnimationFrame(t) }, [])
  useEffect(() => {
    if (!room) return
    let stale = false
    setBranches([])
    call('git.branches', { roomId: room }).then((b) => { if (!stale) setBranches(b) }, () => undefined)
    return () => { stale = true }
  }, [room])

  const close = () => actions.ui.closeModal()
  const toggle = (id: 'branch' | 'from' | 'model' | 'plus') => { setRoomMenu(false); actions.ui.toggleMenu(id) }
  const plusPanel: PlusPanel = menu === 'plus' || menu === 'linkIssue' || menu === 'linkWorkspaces' ? menu : null
  // Each panel switch goes to a different id, so toggling opens it.
  const setPlusPanel = (p: PlusPanel) => { setRoomMenu(false); if (p && p !== menu) actions.ui.toggleMenu(p); else if (!p) actions.ui.closeMenu() }

  const pick = (r: FromRow) => {
    setSource(r.source)
    if (r.baseRef) setBaseRef(r.baseRef)
    actions.ui.closeMenu()
    if (!d.plain() || (!!filled && d.text === filled)) { d.setText(r.prompt); setFilled(r.prompt) }
    else requestAnimationFrame(() => d.focus())
  }
  const clearSource = () => { setSource(null); setBaseRef(''); if (filled && d.text === filled) d.setText(''); setFilled('') }

  const togglePlan = () => { setPlan((p) => !p); actions.ui.closeMenu() }

  const create = () => {
    const prompt = d.plain()
    if (!room || !prompt) { d.focus(); return }
    void run('create', () => start(room, prompt))
  }
  const start = async (room: string, prompt: string) => {
    setError(null)
    try {
      const ws = await call('workspaces.create', {
        roomId: room, prompt, parts: d.message(), mode,
        baseRef: mode === 'worktree' ? target : undefined, source: source ?? undefined, model, effort, plan
      })
      await loadWorkspace(ws.id)
      if (ws.status === 'failed') { setError({ message: `Setup failed on ${ws.branch}. The workspace is there, with the setup output.`, open: ws.id }); return }
      go({ name: 'workspace', workspaceId: ws.id })
    } catch (e) { setError({ message: reason(e) }) }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); create() }
    else if (e.key === 'Tab' && e.shiftKey && e.target === d.input.current) { e.preventDefault(); togglePlan() }
    else if (e.key.toLowerCase() === 'u' && e.metaKey && !e.shiftKey) { e.preventDefault(); filePick.current?.click() }
    else if (e.key.toLowerCase() === 'i' && e.metaKey && !e.shiftKey && room) { e.preventDefault(); setPlusPanel('linkIssue') }
  }

  return (
    <Modal title="New workspace" onClose={close} bare width={680} top={170}>
      <div className="nw" data-plan={plan || undefined} onKeyDown={onKey} {...d.drop}>
        <div className="nw-head">
          <span ref={roomAnchor} style={{ position: 'relative' }}>
            <Button variant="ghost" className="nw-room" aria-haspopup="menu" aria-expanded={roomMenu} onClick={() => { actions.ui.closeMenu(); setRoomMenu(!roomMenu) }}>
              <span className="nw-letter" aria-hidden="true">{letter(current?.name)}</span>{current?.name ?? 'Pick a room'}<Icon name="chevron" size={10} />
            </Button>
            {roomMenu && (
              <Menu label="Room" anchorRef={roomAnchor} onClose={() => setRoomMenu(false)} style={{ left: 0, top: 'calc(100% + 4px)' }}
                items={rooms.map((r) => ({ id: r.id, label: r.name, onSelect: () => { setRoom(r.id); setBaseRef(''); setSource(null) } }))} />
            )}
          </span>
          <span ref={branchAnchor}>
            <button type="button" className="icon-btn nw-tool" aria-label="Branch options" aria-haspopup="dialog" aria-expanded={menu === 'branch'} onClick={() => toggle('branch')}><Icon name="more" /></button>
          </span>
          {menu === 'branch' && <BranchMenu anchorRef={branchAnchor} target={target} targets={targets} onTarget={setBaseRef} mode={mode} onMode={setMode} hint={modeInfo.hint} />}
          <span className="grow" />
          <span ref={fromAnchor}>
            <button type="button" className="nw-trigger" aria-label="Start from a PR, branch or issue" aria-haspopup="dialog" aria-expanded={menu === 'from'} onClick={() => toggle('from')}>
              <Icon name="pr" size={14} />{label.button}<Icon name="chevron" size={10} />
            </button>
          </span>
          {menu === 'from' && <FromPopover roomId={room} branches={branches} tab={tab} onTab={setTab} onPick={pick} anchorRef={fromAnchor} />}
        </div>

        <div className="nw-body">
          {source && (
            <div className="nw-chips">
              <span className="chip nw-chip"><span className="ellipsis">{label.chip}</span><button type="button" className="chip-x" aria-label={`Clear ${label.chip}`} onClick={clearSource}><Icon name="close" size={9} stroke={2} /></button></span>
            </div>
          )}
          <DraftInput d={d} id="nw-prompt" aria-label="What do you want to work on?" placeholder="What do you want to work on?" disabled={busy} />
        </div>

        <div className="nw-foot">
          <span ref={modelAnchor} style={{ position: 'relative' }}>
            <Button variant="ghost" className="nw-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => toggle('model')}>{modelLabel}<span className="muted" style={{ fontWeight: 400 }}>{effortLabel}</span><Icon name="chevron" size={10} /></Button>
            {menu === 'model' && <ModelPicker anchorRef={modelAnchor} model={model} effort={effort} fallback={defaultEffort} onClose={actions.ui.closeMenu} onModel={(m, x) => { setModel(m); setEffort(x); actions.ui.closeMenu() }} onEffort={(x) => { rememberEffort(model, x); setEffort(x) }} />}
          </span>
          <span className="grow">
            {busy && <span className="nw-status" role="status">Creating the workspace and running setup</span>}
            {error && !busy && (
              <span role="alert" className="nw-status">{error.message}{error.open && <button type="button" className="link" onClick={() => go({ name: 'workspace', workspaceId: error.open! })}>Open workspace</button>}</span>
            )}
          </span>
          <span ref={plusAnchor} className="nw-plus" style={{ position: 'relative' }}>
            <PlusMenu panel={plusPanel} onPanel={setPlusPanel} anchorRef={plusAnchor} roomId={room || undefined} plan={plan} onPlan={togglePlan}
              onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
          </span>
          <Button variant="primary" className="nw-create" busy={busy} busyLabel="Creating" onClick={create}>Create<Icon name="reply" size={12} stroke={1.6} /></Button>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
    </Modal>
  )
}

/** Target branch and where it runs (NewWorkspaceBranch.png). Both are native selects, so the keyboard works. */
function BranchMenu({ anchorRef, target, targets, onTarget, mode, onMode, hint }: { anchorRef: React.RefObject<HTMLElement | null>; target: string; targets: string[]; onTarget: (b: string) => void; mode: WorkspaceMode; onMode: (m: WorkspaceMode) => void; hint: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: actions.ui.closeMenu, onOutside: actions.ui.closeMenu, ref, anchorRef })
  return (
    <div ref={ref} role="dialog" aria-label="Branch options" className="nw-pop nw-branch">
      <label className="nw-row"><span>Target branch</span>
        <span className="nw-select mono" style={{ fontSize: 12.5 }}>
          <select aria-label="Target branch" value={target} disabled={mode === 'current'} onChange={(e) => onTarget(e.target.value)}>{targets.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Icon name="chevrons" size={12} stroke={1.5} />
        </span>
      </label>
      <label className="nw-row"><span>Runs in</span>
        <span className="nw-select">
          <select aria-label="Runs in" value={mode} onChange={(e) => onMode(e.target.value as WorkspaceMode)}>{MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          <Icon name="chevrons" size={12} stroke={1.5} />
        </span>
      </label>
      <p className="nw-hint">{hint}</p>
    </div>
  )
}
