import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatPart, Effort, ModelId, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { MODELS } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadWorkspace, useStore } from '../../store'
import { leadOf } from '../../lead'
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

/** What the pickers chose, as plain lines for the Lead. A picked source already wrote its own prompt (pick.ts). */
export function pickedLines({ mode, target, fallback, picked }: { mode: WorkspaceMode; target: string; fallback: string; picked: string }): string[] {
  if (mode === 'current') return ['Work on the current branch, not a new worktree.']
  return target !== fallback && target !== picked ? [`Cut the branch from ${target}.`] : []
}

/** The message the Lead gets: what was typed or attached, a picked issue as a chip, then the lines the pickers add. */
export function briefParts(typed: ChatPart[], source: WorkspaceSource | null, lines: string[]): ChatPart[] {
  const parts = [...typed]
  if (source?.kind === 'issue' && !parts.some((p) => p.type === 'issue' && p.name === source.id)) {
    parts.unshift({ type: 'issue', name: source.id, title: source.title, url: source.url, source: source.id.startsWith('#') ? 'github' : 'linear' })
  }
  if (lines.length) {
    const last = parts[parts.length - 1]
    const text = lines.join('\n')
    if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: `${last.text}\n\n${text}` }
    else parts.push({ type: 'text', text })
  }
  return parts
}

/** The text a chip-only message sends as its prompt, so Create works with a long paste or a file and nothing typed. */
const promptOf = (parts: ChatPart[]) => parts.map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? p.text ?? p.name : p.name)).join('\n').trim()

/**
 * "What do you want to work on?" (NewWorkspace.png and its four popovers). Create opens a new chat with the room's Lead
 * and sends the prompt there, so the Lead plans and hands off (D-131). Enter and Cmd+Enter create, Shift+Enter breaks the line.
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
  /** The base a picked PR or branch set, which its prompt already says. */
  const [pickedRef, setPickedRef] = useState('')
  const [mode, setMode] = useState<WorkspaceMode>(settings?.workspace.mode ?? 'worktree')
  const [model, setModel] = useState<ModelId>(settings?.models.lead ?? 'claude-opus-5-5')
  const lead = useStore((s) => leadOf(s.agents, room))
  const memory = useEffortMemory()
  const defaultEffort = useDefaultEffort(lead?.effort)
  // The picker shows each model at its remembered effort, so the modal starts there too.
  const [effort, setEffort] = useState<Effort>(() => effortFor(model, memory, defaultEffort))
  const [plan, setPlan] = useState(settings?.models.leadPlanMode ?? false)
  const d = useDraft()
  const [branches, setBranches] = useState<string[]>([])
  const [tab, setTab] = useState<FromTab>('prs')
  const [creating, run] = useBusy()
  const busy = creating !== null
  const [error, setError] = useState<{ message: string } | null>(null)

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
    if (r.baseRef) { setBaseRef(r.baseRef); setPickedRef(r.baseRef) }
    actions.ui.closeMenu()
    if (!d.plain() || (!!filled && d.text === filled)) { d.setText(r.prompt); setFilled(r.prompt) }
    else requestAnimationFrame(() => d.focus())
  }
  const clearSource = () => { setSource(null); setBaseRef(''); setPickedRef(''); if (filled && d.text === filled) d.setText(''); setFilled('') }

  const togglePlan = () => { setPlan((p) => !p); actions.ui.closeMenu() }

  const create = () => {
    if (!room) { setError({ message: 'Pick a room first.' }); return }
    const typed = d.message()
    if (!typed.length) { d.focus(); return }
    const lines = pickedLines({ mode, target, fallback, picked: pickedRef })
    const parts = briefParts(typed, source, lines)
    void run('create', () => start(room, parts))
  }
  const start = async (room: string, parts: ChatPart[]) => {
    setError(null)
    let chat
    try { chat = await call('lead.start', { roomId: room, prompt: promptOf(parts), parts, model, effort, plan }) }
    catch (e) { setError({ message: reason(e) }); return }
    // The message is sent. Landing on it is best effort, since the engine pushes the same workspace and chat.
    try {
      const ws = (await call('workspaces.list', { roomId: room })).find((w) => w.id === chat.workspaceId)
      if (ws) actions.workspaces.upsert(ws)
      actions.chats.upsert(chat)
      await loadWorkspace(chat.workspaceId)
    } catch { actions.chats.upsert(chat) }
    go({ name: 'workspace', workspaceId: chat.workspaceId })
    actions.ui.setWorkspaceView({ tab: chat.id })
  }

  /** Enter creates and Shift+Enter breaks the line, as in the chat composer. Cmd+Enter is the keyboard shortcut below. */
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    create()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey && !e.nativeEvent.isComposing) { e.preventDefault(); create() }
    else if (e.key === 'Tab' && e.shiftKey && e.target === d.input.current) { e.preventDefault(); togglePlan() }
    else if (e.key.toLowerCase() === 'u' && e.metaKey && !e.shiftKey) { e.preventDefault(); filePick.current?.click() }
    else if (e.key.toLowerCase() === 'i' && e.metaKey && !e.shiftKey && room) { e.preventDefault(); setPlusPanel('linkIssue') }
  }

  return (
    <Modal title="New chat" onClose={close} bare width={680} top={170}>
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
          <DraftInput d={d} id="nw-prompt" aria-label="What do you want to work on?" placeholder="What do you want to work on?" disabled={busy} onKeyDown={onEnter} />
        </div>

        <div className="nw-foot">
          <span ref={modelAnchor} style={{ position: 'relative' }}>
            <Button variant="ghost" className="nw-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => toggle('model')}>{modelLabel}<span className="muted" style={{ fontWeight: 400 }}>{effortLabel}</span><Icon name="chevron" size={10} /></Button>
            {menu === 'model' && <ModelPicker anchorRef={modelAnchor} model={model} effort={effort} fallback={defaultEffort} onClose={actions.ui.closeMenu} onModel={(m, x) => { setModel(m); setEffort(x); actions.ui.closeMenu() }} onEffort={(x) => { rememberEffort(model, x); setEffort(x) }} />}
          </span>
          <span className="grow">
            {busy && <span className="nw-status" role="status">Sending to {lead?.name ?? 'the Lead'}</span>}
            {error && !busy && <span role="alert" className="nw-status">{error.message}</span>}
          </span>
          <span ref={plusAnchor} className="nw-plus" style={{ position: 'relative' }}>
            <PlusMenu panel={plusPanel} onPanel={setPlusPanel} anchorRef={plusAnchor} roomId={room || undefined} plan={plan} onPlan={togglePlan}
              onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
          </span>
          <Button variant="primary" className="nw-create" busy={busy} busyLabel="Sending" onClick={create}>Create<Icon name="reply" size={12} stroke={1.6} /></Button>
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
