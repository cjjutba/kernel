import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatPart, Effort, ModelId, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { MODELS } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadWorkspace, useStore } from '../../store'
import { Button, Icon, Menu, Modal, Spinner } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { EFFORTS, ModelPicker } from '../workspace/composer/ModelPicker'
import '../workspace/composer/composer.css'
import { partOf } from './attach'
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
  const [prompt, setPrompt] = useState('')
  const [source, setSource] = useState<WorkspaceSource | null>(initial ?? null)
  const [filled, setFilled] = useState(false)
  const [baseRef, setBaseRef] = useState('')
  const [mode, setMode] = useState<WorkspaceMode>(settings?.workspace.mode ?? 'worktree')
  const [model, setModel] = useState<ModelId>(settings?.models.engineers ?? 'claude-sonnet-5-5')
  const [effort, setEffort] = useState<Effort>(settings?.models.effort ?? 'high')
  const [plan, setPlan] = useState(false)
  const [parts, setParts] = useState<ChatPart[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [tab, setTab] = useState<FromTab>('prs')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; open?: string } | null>(null)

  const current = rooms.find((r) => r.id === room)
  const fallback = `origin/${current?.defaultBranch ?? 'main'}`
  const target = baseRef || fallback
  const targets = useMemo(() => targetOptions(branches, fallback, target), [branches, fallback, target])
  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0]
  const label = sourceLabel(source)
  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model
  const effortLabel = EFFORTS.find((x) => x.id === effort)?.label ?? effort

  const textarea = useRef<HTMLTextAreaElement>(null)
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const roomAnchor = useRef<HTMLSpanElement>(null)
  const branchAnchor = useRef<HTMLSpanElement>(null)
  const fromAnchor = useRef<HTMLSpanElement>(null)
  const filePick = useRef<HTMLInputElement>(null)

  // The modal shell focuses its first control. The prompt is where typing starts.
  useEffect(() => { const t = requestAnimationFrame(() => textarea.current?.focus()); return () => cancelAnimationFrame(t) }, [])
  useEffect(() => {
    if (!room) return
    let stale = false
    setBranches([])
    call('git.branches', { roomId: room }).then((b) => { if (!stale) setBranches(b) }, () => undefined)
    return () => { stale = true }
  }, [room])

  const close = () => actions.ui.closeModal()
  const toggle = (id: 'branch' | 'from' | 'model' | 'plus') => { setRoomMenu(false); actions.ui.toggleMenu(id) }

  const pick = (r: FromRow) => {
    setSource(r.source)
    if (r.baseRef) setBaseRef(r.baseRef)
    if (!prompt.trim() || filled) { setPrompt(r.prompt); setFilled(true) }
    actions.ui.closeMenu()
    requestAnimationFrame(() => { const t = textarea.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length) } })
  }
  const clearSource = () => { setSource(null); setBaseRef(''); if (filled) { setPrompt(''); setFilled(false) } }

  const attach = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      try { const p = await partOf(f); setParts((all) => [...all, p]) } catch (e) { actions.ui.toast({ title: 'Could not attach', sub: (e as Error).message }) }
    }
  }
  const togglePlan = () => { setPlan((p) => !p); actions.ui.closeMenu() }

  const create = async () => {
    if (busy) return
    if (!room || !prompt.trim()) { textarea.current?.focus(); return }
    setBusy(true); setError(null)
    try {
      const ws = await call('workspaces.create', {
        roomId: room, prompt: prompt.trim(), parts: parts.length ? parts : undefined, mode,
        baseRef: mode === 'worktree' ? target : undefined, source: source ?? undefined, model, effort, plan
      })
      await loadWorkspace(ws.id)
      if (ws.status === 'failed') { setError({ message: `Setup failed on ${ws.branch}. The workspace is there, with the setup output.`, open: ws.id }); setBusy(false); return }
      go({ name: 'workspace', workspaceId: ws.id })
    } catch (e) { setError({ message: reason(e) }); setBusy(false) }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void create() }
    else if (e.key === 'Tab' && e.shiftKey && e.target === textarea.current) { e.preventDefault(); togglePlan() }
    else if (e.key.toLowerCase() === 'u' && e.metaKey && !e.shiftKey) { e.preventDefault(); filePick.current?.click() }
  }

  return (
    <Modal title="New workspace" onClose={close} bare width={680} top={170}>
      <div className="nw" onKeyDown={onKey}>
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
            <button type="button" className="icon-btn nw-tool" aria-label="Branch options" title="Branch options" aria-haspopup="dialog" aria-expanded={menu === 'branch'} onClick={() => toggle('branch')}><Icon name="more" /></button>
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
          {(source || parts.length > 0) && (
            <div className="nw-chips">
              {source && (
                <span className="chip nw-chip"><span className="ellipsis">{label.chip}</span><button type="button" className="chip-x" aria-label={`Clear ${label.chip}`} onClick={clearSource}><Icon name="close" size={9} stroke={2} /></button></span>
              )}
              {parts.map((p, i) => p.type === 'text' ? null : (
                <span key={i} className="chip nw-chip">
                  {p.type === 'image' && p.dataUrl ? <img src={p.dataUrl} alt="" style={{ width: 16, height: 16, borderRadius: 3, objectFit: 'cover' }} /> : <Icon name={p.type === 'image' ? 'image' : 'doc'} size={12} />}
                  <span className="ellipsis">{p.type === 'skill' ? `/${p.name}` : p.name}</span>
                  <button type="button" className="chip-x" aria-label={`Remove ${p.name}`} onClick={() => setParts((all) => all.filter((_, j) => j !== i))}><Icon name="close" size={9} stroke={2} /></button>
                </span>
              ))}
            </div>
          )}
          <label htmlFor="nw-prompt" className="sr-only">What do you want to work on?</label>
          <textarea ref={textarea} id="nw-prompt" rows={7} placeholder="What do you want to work on?" disabled={busy} value={prompt} onChange={(e) => { setPrompt(e.target.value); setFilled(false) }} />
        </div>

        <div className="nw-foot">
          <span ref={modelAnchor} style={{ position: 'relative' }}>
            <Button variant="ghost" className="nw-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => toggle('model')}>{modelLabel}<span className="muted" style={{ fontWeight: 400 }}>{effortLabel}</span><Icon name="chevron" size={10} /></Button>
            {menu === 'model' && <ModelPicker anchorRef={modelAnchor} model={model} effort={effort} onClose={actions.ui.closeMenu} onModel={(m) => { setModel(m); actions.ui.closeMenu() }} onEffort={setEffort} />}
          </span>
          {plan && <Button className="nw-plan" aria-label="Turn off plan mode" onClick={() => setPlan(false)}>Plan mode<Icon name="close" size={9} stroke={2} /></Button>}
          <span className="grow">
            {busy && <span className="nw-status"><Spinner label="Creating" />Creating the workspace and running setup</span>}
            {error && !busy && (
              <span role="alert" className="nw-status">{error.message}{error.open && <button type="button" className="link" onClick={() => go({ name: 'workspace', workspaceId: error.open! })}>Open workspace</button>}</span>
            )}
          </span>
          <span ref={plusAnchor} style={{ position: 'relative' }}>
            <button type="button" className="icon-btn nw-tool" aria-label="Plan mode and attachments" title="Plan mode and attachments" aria-haspopup="menu" aria-expanded={menu === 'plus'} onClick={() => toggle('plus')}><Icon name="plus" /></button>
            {menu === 'plus' && (
              <Menu label="Add" anchorRef={plusAnchor} onClose={actions.ui.closeMenu} style={{ right: 0, bottom: 'calc(100% + 8px)', width: 240 }} items={[
                { id: 'plan', label: plan ? 'Plan mode is on' : 'Plan mode', shortcut: '⇧Tab', onSelect: togglePlan },
                { id: 'attach', label: 'Add attachment', shortcut: '⌘U', onSelect: () => filePick.current?.click() }
              ]} />
            )}
          </span>
          <Button variant="primary" className="nw-create" disabled={busy} onClick={() => void create()}>Create<Icon name="reply" size={12} stroke={1.6} /></Button>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { void attach(e.target.files); e.target.value = '' }} />
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
