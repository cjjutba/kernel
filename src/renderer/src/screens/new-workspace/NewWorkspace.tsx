import { useEffect, useMemo, useRef, useState } from 'react'
import { modelLabelOf, useCodexInUse, useProviderModels } from '../workspace/composer/providerModels'
import type { ChatPart, IssueTakenFinding, NewChatPicks, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { providerOf } from '@shared/providers'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { leadOf } from '../../lead'
import { Button, Icon, Menu, Modal, Select, useBusy } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { DraftInput, useDraft } from '../workspace/composer/draft'
import { NEW_CHAT_DRAFT } from '../workspace/composer/draftStore'
import { ModelPicker } from '../workspace/composer/ModelPicker'
import { effortLabel as labelOf, useLeadBox } from '../workspace/composer/modelPrefs'
import { PlusMenu, type PlusPanel } from '../workspace/composer/PlusMenu'
import { sendsOn, useSendWith } from '../workspace/composer/sendKey'
import '../workspace/composer/composer.css'
import { useRemote } from '../settings/useSettings'
import { FromPopover } from './FromPopover'
import { briefParts, pickedLines } from './brief'
import { startChat } from './start'
import { takenFindings } from './taken'
import { sourceLabel, targetOptions, type FromRow, type FromTab } from './pick'
import './newWorkspace.css'
import { RoomIcon } from '../../components/RoomIcon'

const MODES: { id: WorkspaceMode; label: string; hint: string }[] = [
  { id: 'worktree', label: 'New worktree', hint: 'An isolated copy on its own branch, named from your task.' },
  { id: 'current', label: 'Current branch', hint: 'Works in your checkout. Changes already there are kept and left out of the diff.' }
]


/**
 * "What do you want to work on?" (NewWorkspace.png and its four popovers). Create opens a new chat with the room's Lead
 * and sends the prompt there, so the Lead plans and hands off (D-131). Enter and Cmd+Enter create, Shift+Enter breaks the line.
 * The box keeps its draft while the modal is closed, until a create sends it.
 * A chat that starts from an issue first asks whether someone else is on it (KERNEL-500). `picks` is what the box had chosen when
 * that warning sent the user back.
 */
export function NewWorkspace({ roomId, source: initial, picks }: { roomId?: string; source?: WorkspaceSource; picks?: NewChatPicks }) {
  const rooms = useStore((s) => s.rooms)
  const settings = useStore((s) => s.settings)
  const menu = useStore((s) => s.ui.menu)
  const [room, setRoom] = useState(roomId ?? rooms[0]?.id ?? '')
  const [roomMenu, setRoomMenu] = useState(false)
  const [source, setSource] = useState<WorkspaceSource | null>(initial ?? null)
  /** The prompt a picked source wrote, replaced by the next pick or cleared with the source until you edit it. */
  const [filled, setFilled] = useState(picks?.filled ?? '')
  const [baseRef, setBaseRef] = useState(picks?.baseRef ?? '')
  /** The base a picked PR or branch set, which its prompt already says. */
  const [pickedRef, setPickedRef] = useState(picks?.pickedRef ?? '')
  const [mode, setMode] = useState<WorkspaceMode>(picks?.mode ?? settings?.workspace.mode ?? 'worktree')
  const codexInUse = useCodexInUse()
  const codexModels = useProviderModels('codex')
  const lead = useStore((s) => leadOf(s.agents, room))
  // Model, effort and plan mode are the Lead's until picked here, and a pick stays with the draft (KERNEL-544). The warning's picks go back in the draft.
  const { model, effort, plan, fallback: defaultEffort, pickModel, pickEffort, togglePlan: flipPlan } = useLeadBox(NEW_CHAT_DRAFT, lead, picks && { model: picks.model, effort: picks.effort, plan: picks.plan })
  const d = useDraft(undefined, NEW_CHAT_DRAFT)
  const [branches, setBranches] = useState<string[]>([])
  const [tab, setTab] = useState<FromTab>('prs')
  const [creating, run] = useBusy()
  const busy = creating !== null
  const [checking, setChecking] = useState(false)
  const alive = useRef(true)
  /** The issue check for the picked source, started when it was picked, so Create finds it answered (KERNEL-543). */
  const taken = useRef<{ key: string; found: Promise<IssueTakenFinding[]> } | null>(null)
  const [error, setError] = useState<{ message: string } | null>(null)

  const current = rooms.find((r) => r.id === room)
  const remote = useRemote(room)
  const fallback = `${remote}/${current?.defaultBranch ?? 'main'}`
  const target = baseRef || fallback
  const targets = useMemo(() => targetOptions(branches, fallback, target, remote), [branches, fallback, target, remote])
  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0]
  const label = sourceLabel(source)
  const modelLabel = modelLabelOf(model, codexModels)
  const effortLabel = labelOf(effort)

  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const roomAnchor = useRef<HTMLSpanElement>(null)
  const branchAnchor = useRef<HTMLSpanElement>(null)
  const fromAnchor = useRef<HTMLSpanElement>(null)
  const filePick = useRef<HTMLInputElement>(null)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // The modal shell focuses its first control. The prompt is where typing starts.
  useEffect(() => { const t = requestAnimationFrame(() => d.focus()); return () => cancelAnimationFrame(t) }, [])
  useEffect(() => {
    if (!room) return
    let stale = false
    setBranches([])
    call('git.branches', { roomId: room }).then((b) => { if (!stale) setBranches(b) }, () => undefined)
    return () => { stale = true }
  }, [room])

  // Kernel fetches the room's remote now, so the fetch Create needs is done or under way by then. Nothing waits on it.
  useEffect(() => {
    if (room) void call('lead.prefetch', { roomId: room }).catch(() => undefined)
  }, [room])
  // An issue source starts its check at once and keeps the answer. Clearing or changing the source, or the room, drops it.
  const issueId = source?.kind === 'issue' ? source.id : ''
  const issueKey = room && issueId ? `${room}:${issueId}` : ''
  useEffect(() => {
    if (!issueKey) { taken.current = null; return }
    if (taken.current?.key !== issueKey) taken.current = { key: issueKey, found: takenFindings((req) => call('issues.taken', req), room, issueId) }
  }, [issueKey])

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

  const togglePlan = () => { flipPlan(); actions.ui.closeMenu() }

  const create = () => {
    if (!room) { setError({ message: 'Pick a room first.' }); return }
    const typed = d.message()
    if (!typed.length) { d.focus(); return }
    const lines = pickedLines({ mode, target, fallback, picked: pickedRef })
    const parts = briefParts(typed, source, lines)
    void run('create', async () => {
      setError(null)
      if (source?.kind === 'issue' && (await someoneIsOn(room, source, parts))) return
      const failed = await startChat({ roomId: room, parts, model, effort, plan, baseRef })
      if (failed) setError({ message: failed })
    })
  }
  /**
   * Whether the issue check held the chat back: it opens the warning, which sends the chat on or brings this box back. Anything
   * the check can't answer, or the user closing the box meanwhile, leaves nothing held (KERNEL-500).
   */
  const someoneIsOn = async (room: string, issue: Extract<WorkspaceSource, { kind: 'issue' }>, parts: ChatPart[]) => {
    setChecking(true)
    let found
    // The check started when the issue was picked, and Create waits only for what is left of it.
    const asked = taken.current?.key === `${room}:${issue.id}` ? taken.current.found : takenFindings((req) => call('issues.taken', req), room, issue.id)
    try { found = await asked }
    finally { setChecking(false) }
    if (!alive.current) return true
    if (!found.length) return false
    if (getState().ui.modal?.name !== 'newWorkspace') return true
    actions.ui.openModal({ name: 'confirm', kind: 'issueTaken', issue: issue.id, findings: found, held: { roomId: room, source: issue, parts, picks: { mode, model, effort, plan, baseRef, pickedRef, filled } } })
    return true
  }

  /**
   * Enter creates and Shift+Enter breaks the line, as in the chat composer. With Send messages with on ⌘ Enter, Enter breaks
   * the line too (KERNEL-536). Cmd+Enter is the keyboard shortcut below, in both.
   */
  const sendWith = useSendWith()
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.metaKey || !sendsOn(e, sendWith) || e.nativeEvent.isComposing) return
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
              <RoomIcon room={current} className="nw-letter" fallback="?" />{current?.name ?? 'Pick a room'}<Icon name="chevron" size={12} />
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
              <Icon name="pr" size={14} />{label.button}<Icon name="chevron" size={12} />
            </button>
          </span>
          {menu === 'from' && <FromPopover roomId={room} branches={branches} tab={tab} onTab={setTab} onPick={pick} anchorRef={fromAnchor} />}
        </div>

        <div className="nw-body">
          {source && (
            <div className="nw-chips">
              <span className="chip nw-chip"><span className="ellipsis">{label.chip}</span><button type="button" className="chip-x" aria-label={`Clear ${label.chip}`} onClick={clearSource}><Icon name="close" size={12} /></button></span>
            </div>
          )}
          <DraftInput d={d} id="nw-prompt" aria-label="What do you want to work on?" placeholder="What do you want to work on?" disabled={busy} onKeyDown={onEnter} />
        </div>

        <div className="nw-foot">
          <span ref={modelAnchor} style={{ position: 'relative' }}>
            <Button variant="ghost" className="nw-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => toggle('model')}>{modelLabel}<span className="muted" style={{ fontWeight: 400 }}>{effortLabel}</span><Icon name="chevron" size={12} /></Button>
            {menu === 'model' && <ModelPicker anchorRef={modelAnchor} provider={providerOf(model)} grouped={codexInUse} model={model} effort={effort} fallback={defaultEffort} onClose={actions.ui.closeMenu} onModel={(m, x) => { pickModel(m, x); actions.ui.closeMenu() }} onEffort={pickEffort} />}
          </span>
          <span className="grow">
            {error && !busy && <span role="alert" className="nw-status">{error.message}</span>}
          </span>
          <span ref={plusAnchor} className="nw-plus" style={{ position: 'relative' }}>
            <PlusMenu panel={plusPanel} onPanel={setPlusPanel} anchorRef={plusAnchor} roomId={room || undefined} plan={plan} onPlan={togglePlan}
              onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
          </span>
          <Button variant="primary" className="nw-create" busy={busy} busyPattern="arrow-right" busyLabel={checking ? 'Checking' : 'Sending'} onClick={create}>Create<Icon name="reply" size={12} /></Button>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
    </Modal>
  )
}

/** Target branch and where it runs (NewWorkspaceBranch.png). Both are Selects, so the keyboard works. */
function BranchMenu({ anchorRef, target, targets, onTarget, mode, onMode, hint }: { anchorRef: React.RefObject<HTMLElement | null>; target: string; targets: string[]; onTarget: (b: string) => void; mode: WorkspaceMode; onMode: (m: WorkspaceMode) => void; hint: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: actions.ui.closeMenu, onOutside: actions.ui.closeMenu, ref, anchorRef })
  return (
    <div ref={ref} role="dialog" aria-label="Branch options" className="nw-pop nw-branch">
      <div className="nw-row"><span>Target branch</span>
        <Select variant="plain" align="right" className="nw-select mono" label="Target branch" value={target} disabled={mode === 'current'} onChange={onTarget} options={targets.map((t) => ({ value: t, label: t }))} />
      </div>
      <div className="nw-row"><span>Runs in</span>
        <Select variant="plain" align="right" className="nw-select" label="Runs in" value={mode} onChange={(v) => onMode(v as WorkspaceMode)} options={MODES.map((m) => ({ value: m.id, label: m.label }))} />
      </div>
      <p className="nw-hint">{hint}</p>
    </div>
  )
}
