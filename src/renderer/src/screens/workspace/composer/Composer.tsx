import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentDef, BuiltinCommand, Chat, ChatPart, Effort, FileEntry, ModelId, PermissionMode, QueuedMessage, Skill, Workspace } from '@shared/types'
import { MODELS, type Provider } from '@shared/types'
import { chatProvider } from '@shared/providers'
import { effortsOf, modelLabelOf, useCodexInUse, useProviderModels } from './providerModels'
import { call, cleanError } from '../../../api'
import { bypassConfirmed } from '../../../bypassConfirm'
import { FileIcon } from '../../../components/FileIcon'
import { useModeAvailability } from '../../../permissionModes'
import { actions, getState, loadWorkspace, useStore } from '../../../store'
import { Button, Icon } from '../../../ui'
import { attempt } from '../MessageActions'
import { PlanBar } from '../cards/plan'
import { noteFromParts, waitingPlan } from '../cards/steps'
import { baseName, dirName, filterAgents, mentionAt, mentionMenu, mentionPart, runsOnEnter, slashAt, slashMenu } from './autocomplete'
import { onAddToComposer, onComposerCommand, onComposerFocusAsked, onEditQueued, takeComposerFocus } from './bus'
import { DraftInput, useDraft } from './draft'
import { ContextRing } from './ContextRing'
import { HunkCard } from './HunkCard'
import { ModeMenu } from './ModeMenu'
import { ModelPicker } from './ModelPicker'
import { effortFor } from '@shared/effort'
import { effortLabel, nextEffort, rememberEffort, useDefaultEffort, useEffortMemory } from './modelPrefs'
import { MODE_ICON, buttonName, modeAria, cyclePatch, modePatch, nextMode, offLine, shownMode, type ComposerMode } from './modes'
import { PlusMenu, type PlusPanel } from './PlusMenu'
import { QueueList } from './QueueList'
import { sendsOn, useSendWith } from './sendKey'
import { NoteText } from '../NoteText'
import { heldLine, waitersLine } from '../waitLines'
import './composer.css'

const EMPTY_QUEUE: QueuedMessage[] = []
const EMPTY_TEAM: AgentDef[] = []
const EMPTY_WS: Workspace[] = []
/**
 * The newest prefill already put in a box, so a composer that remounts doesn't write an old one over a restored draft.
 * It compares `n`, which `Workspace` sets from `Date.now()`, so it only goes up. A per-mount counter would block every edit after the first.
 */
let appliedPrefill = 0

type MenuName = 'model' | 'context' | 'mode' | PlusPanel

/**
 * The message box under the transcript. The message is a list of parts: typed text and chips (pasted text, images,
 * files, skills, diff hunks) inline, in order. Enter sends (or Cmd+Enter, by Send messages with), Shift+Enter breaks the line, Shift+Tab cycles the chat's
 * permission mode, which the dropdown after the model button shows and picks (KERNEL-456), Backspace takes a chip like a
 * character. While the agent works, a sent message waits in the queue above the box.
 */
export function Composer({ chat, agent, blocked, running, prefill, banner }: { chat: Chat; agent?: AgentDef; blocked: boolean; running: boolean; prefill?: { text: string; n: number }; /** A failure banner, drawn right above the box (KERNEL-28). */ banner?: ReactNode }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === chat.workspaceId))
  const queue = useStore((s) => s.queue[chat.id]) ?? EMPTY_QUEUE
  const queueWhy = useStore((s) => s.queueWhy[chat.id])
  // What this workspace waits for, and who waits for it, named live as PRs open and merge (KERNEL-259). Only those
  // workspaces are read, so a poll of the room's other PRs doesn't redraw the box.
  const related = useStore((s) => (ws ? s.workspaces.filter((w) => ws.waitsFor?.on.includes(w.id) || w.waitsFor?.on.includes(ws.id)) : EMPTY_WS))
  const team = useStore((s) => (ws ? s.agents[ws.roomId] : undefined)) ?? EMPTY_TEAM
  const held = useMemo(() => (ws ? heldLine(ws, related, team) : undefined), [ws, related, team])
  const waiters = useMemo(() => (ws ? waitersLine(ws, related, team) : undefined), [ws, related, team])
  const forced = useStore((s) => s.ui.workspace.composer)
  // Fixtures open the context popover for a shot.
  const contextForced = useStore((s) => s.ui.workspace.contextOpen)
  // A plan waiting on you here puts Copy and Approve on the box, and what you send goes back as changes to it.
  const plan = useStore((s) => waitingPlan(s.approvals, chat))
  const d = useDraft(forced, chat.id)
  // Fixtures open the model picker and the mode menu the same way, through the app's menu, for a shot (WorkspaceModelPicker, KERNEL-406).
  const [menu, setMenu] = useState<MenuName>(contextForced ? 'context' : getState().ui.menu === 'model' ? 'model' : getState().ui.menu === 'mode' ? 'mode' : null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [commands, setCommands] = useState<BuiltinCommand[]>([])
  const [files, setFiles] = useState<FileEntry[]>([])
  const [at, setAt] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const filePick = useRef<HTMLInputElement>(null)
  const run = useRef<{ before: PermissionMode | undefined } | null>(null)
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const modeAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const name = agent?.name ?? 'the agent'

  const mention = mentionAt(d.before)
  const slash = slashAt(d.before, !d.first)
  const acKey = mention ? `@${mention.query}` : slash ? `/${slash.query}` : ''
  const acOpen = !!acKey && dismissed !== acKey && !blocked
  const slashGroups = useMemo(() => (slash ? slashMenu(skills, commands, slash.query) : []), [skills, commands, slash?.query])
  const slashRows = slashGroups.flatMap((g) => g.rows)
  // Only the Lead's chat can @ a teammate (KERNEL-746): its message goes to the Lead, who acts for them.
  const mentionAgents = useMemo(() => (agent?.lead && mention ? filterAgents(team, mention.query) : EMPTY_TEAM), [agent?.lead, team, mention?.query])
  const mentionGroups = useMemo(() => mentionMenu(files, mentionAgents), [files, mentionAgents])
  const mentionRows = mentionGroups.flatMap((g) => g.rows)
  const rows = mention ? mentionRows : slashRows
  const roomId = ws?.roomId

  // The queue and what it waits for are also pushed as events; this reads what was queued before the screen opened.
  // No reason comes back for an empty queue, so a null answer says nothing and leaves a pushed one alone.
  useEffect(() => {
    void call('chats.queue', { chatId: chat.id }).then((q) => actions.chats.setQueue(chat.id, q)).catch(() => undefined)
    void call('chats.queueReason', { chatId: chat.id }).then((why) => { if (why) actions.chats.setQueueWhy(chat.id, why) }).catch(() => undefined)
  }, [chat.id])
  useEffect(() => { if (roomId) void call('skills.list', { roomId }).then(setSkills).catch(() => setSkills([])) }, [roomId])
  useEffect(() => { void call('commands.list', undefined).then(setCommands).catch(() => setCommands([])) }, [])

  // Files for the @ menu, as the query changes. Older answers are dropped.
  const query = mention?.query
  useEffect(() => {
    if (query === undefined || !ws) { setFiles([]); return }
    let live = true
    const t = setTimeout(() => {
      call('workspaces.files', { workspaceId: ws.id, query, limit: 5 }).then((r) => { if (live) setFiles(r) }).catch(() => { if (live) setFiles([]) })
    }, 60)
    return () => { live = false; clearTimeout(t) }
  }, [query, ws?.id])
  useEffect(() => { setAt(0) }, [acKey])

  useEffect(() => { if (prefill && prefill.n > appliedPrefill) { appliedPrefill = prefill.n; d.setText(prefill.text) } }, [prefill])
  useEffect(() => onAddToComposer((part) => d.insert(part)), [])

  // A chat that was just created, or opened from the sidebar, takes the caret. The frame lets a closing dialog hand focus back to its trigger first.
  useEffect(() => {
    if (blocked || !takeComposerFocus(chat)) return
    const f = requestAnimationFrame(() => d.focus())
    return () => cancelAnimationFrame(f)
  }, [chat.id])
  // A sidebar row for the chat already on screen changes nothing, so the box takes the caret as it is asked.
  // Subscribed on every render, so the listener sees the current chat.
  useEffect(() => onComposerFocusAsked(() => { if (!blocked && takeComposerFocus(chat)) d.focus() }))

  /** `run` is Enter or a click: a / row that needs nothing more is sent at once. Tab only completes it. */
  const pickRow = (i: number, run: boolean) => {
    if (mention) { const r = mentionRows[i]; if (r) d.insert(mentionPart(r), mention.query.length + 1) }
    else if (slash) {
      const s = slashRows[i]
      if (!s) return
      if (run && runsOnEnter(s, slash.query)) void send([{ type: 'text', text: [`/${s.name}`, d.after.trim()].filter(Boolean).join(' ') }])
      else d.insert({ type: 'skill', name: s.name }, slash.query.length + 1)
    }
  }

  /**
   * Sends what is in the box, or `picked` in its place (a command run from the / menu). While a plan waits, a typed
   * message is the change to ask for instead: the agent reads it as the reason the plan was sent back, and keeps planning.
   */
  const send = async (picked?: ChatPart[]) => {
    const parts = picked ?? d.message()
    if (!parts.length || blocked) return
    const id = chat.id
    const kept = d.snapshot()
    d.reset()
    try {
      if (plan && !picked) {
        // Images go as files the agent reads, since a denial carries text only (D-134).
        const images = parts.flatMap((p) => p.type === 'image' && p.dataUrl ? [{ name: p.name, dataUrl: p.dataUrl }] : [])
        await call('approvals.decide', { id: plan.id, decision: { behavior: 'deny', message: noteFromParts(parts), ...(images.length ? { images } : {}) } })
      }
      else await call('chats.send', { chatId: chat.id, parts })
    }
    catch (e) {
      // Back into the chat it came from, ahead of anything typed there since.
      const since = d.snapshot(id)
      d.reset(since.length ? [...kept, ...since] : kept, id)
      actions.ui.toast({ title: 'Could not send', sub: cleanError(e) })
    }
  }

  const pickModel = (m: string, effort: Effort) => void configure({ model: m, effort })
  // KERNEL-406: the chat's provider, its models, and a new tab on the other provider for a chat that has started.
  const provider = chatProvider(chat)
  const grouped = useCodexInUse(provider)
  // KERNEL-456: the mode the chat runs in comes from main (KERNEL-572), which the window reads once for a chat it hasn't heard of and then hears of each change.
  const runMode = useStore((s) => s.runModes[chat.id])
  const roomMode = useStore((s) => s.rooms.find((r) => r.id === roomId)?.permissionMode)
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const availability = useModeAvailability()
  useEffect(() => {
    if (getState().runModes[chat.id]) return
    void call('chats.runMode', { chatId: chat.id }).then((m) => { if (!getState().runModes[chat.id]) actions.chats.setRunMode(chat.id, m) }).catch(() => undefined)
  }, [chat.id])
  const shown = shownMode(chat.plan, runMode, chat.mode ?? roomMode ?? appMode ?? 'default')
  /** Plan sets `plan` and leaves the chat's `mode`. Every other mode sets `mode` and leaves plan. Bypass permissions asks once first, and what it saves is this chat's mode. */
  const setMode = (mode: ComposerMode, patch: (m: ComposerMode) => ReturnType<typeof modePatch> | ReturnType<typeof cyclePatch> = modePatch) => {
    if (mode === shown.picked) return
    if (mode === 'bypassPermissions' && !bypassConfirmed()) { run.current = null; setMenu(null); return actions.ui.openModal({ name: 'confirm', kind: 'bypass', chatId: chat.id }) }
    void configure(patch(mode))
  }
  const pickMode = (mode: ComposerMode) => { run.current = null; setMode(mode) }
  const cycleMode = () => {
    const before = run.current ? run.current.before : chat.mode
    run.current = { before }
    setMode(nextMode(shown.picked, (m) => !offLine(m, provider, availability)), (m) => cyclePatch(before, m))
  }
  const providerModels = useProviderModels(provider)
  const efforts = effortsOf(chat.model, providerModels)
  const newChatOn = (p: Provider, m: string, x: Effort) => void attempt('Could not open a tab', async () => {
    const c = await call('chats.create', { workspaceId: chat.workspaceId, kind: 'chat', provider: p, model: m, effort: x, ...(chat.threadId ? { threadId: chat.threadId } : {}) })
    await loadWorkspace(chat.workspaceId)
    actions.ui.openTab(chat.workspaceId, c.id)
  })
  const setEffort = (effort: Effort) => { rememberEffort(chat.model, effort); void configure({ effort }) }
  const memory = useEffortMemory()
  const fallback = useDefaultEffort(agent?.effort)
  // Claude's guess at the next message (KERNEL-530) stands in for the placeholder of an empty box, and Tab or → takes it. Only a key does: Enter on an empty box sends nothing.
  const suggested = provider === 'claude' && !d.parts.length && !running && !chat.plan && !plan && !blocked && !queue.length && queueWhy !== 'setup' && !acOpen ? chat.suggestion : undefined
  const sendWith = useSendWith()
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (acOpen && rows.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => (i + 1) % rows.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (i - 1 + rows.length) % rows.length); return }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickRow(at, e.key === 'Enter'); return }
    }
    if (acOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(acKey); return }
    if (suggested && (e.key === 'Tab' || e.key === 'ArrowRight') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); d.setText(suggested); d.focus(); return }
    if (sendsOn(e, sendWith)) { e.preventDefault(); void send(); return }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return }
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) run.current = null
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
    if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i' && roomId) { e.preventDefault(); setMenu('linkIssue') }
  }

  const configure = (patch: { model?: string; effort?: Effort; plan?: boolean; mode?: PermissionMode | undefined }) => attempt('Could not change the chat', async () => { await call('chats.configure', { chatId: chat.id, ...patch }); await loadWorkspace(chat.workspaceId) })
  const editQueued = (q: QueuedMessage) => {
    const id = chat.id
    void attempt('Could not edit the message', async () => {
      actions.chats.setQueue(id, await call('chats.unqueue', { chatId: id, id: q.id }))
      // The call can outlast a switch to another chat, so the message goes back into the chat it was queued in.
      d.reset([...d.snapshot(id), ...q.parts], id)
    })
  }

  const model = modelLabelOf(chat.model, providerModels)
  const effort = effortLabel(chat.effort)
  const hasDraft = !d.empty
  const placeholder = blocked ? 'Paused until this is resolved' : plan ? 'Enter your plan adjustments here' : running || queueWhy === 'setup' ? 'Add a follow up' : suggested || `Ask ${name} to make changes, @mention files, run /skills`

  // ^⌘1 to 4 pick a model (at the effort it last ran at) and ⌘⇧/ cycles the effort, with the picker open or not.
  // The open picker handles them itself and marks the event handled. ⌘L puts the caret in the box. ⌘⇧L is the Lead chat (App.tsx).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || getState().ui.modal) return
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyL') {
        if (blocked) return
        e.preventDefault()
        d.focus()
      } else if (e.ctrlKey && e.metaKey && /^[1-4]$/.test(e.key) && provider === 'claude') {
        const m = MODELS[Number(e.key) - 1]
        if (!m) return
        e.preventDefault()
        pickModel(m.id, m.id === chat.model ? chat.effort : effortFor(m.id, memory, fallback))
      } else if (e.metaKey && e.shiftKey && (e.key === '/' || e.key === '?')) {
        e.preventDefault()
        setEffort(nextEffort(chat.effort, efforts))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Edit on a setup wait's bubble pulls that message back into the box, as Edit on a queue row does.
  useEffect(() => onEditQueued((q) => { if (queue.some((x) => x.id === q.id)) editQueued(q) }))

  // A banner's "Queue message" sends what is typed (main holds it while the limit lasts), "Switch model" opens the picker.
  // Subscribed on every render, so the listener always sees the current draft.
  useEffect(() => onComposerCommand((c) => {
    if (c === 'model') { setMenu('model'); return }
    if (!d.empty) void send()
    else d.focus()
  }))

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {ws && <HunkCard ws={ws} agentName={name} refreshKey={running} />}
        {waiters && <div className="note" role="status"><span className="note-text"><NoteText text={waiters.text} refs={waiters.refs} /></span></div>}
        <QueueList
          queue={queue}
          why={queueWhy}
          held={held}
          onEdit={editQueued}
          onNow={(q) => void attempt('Could not send now', async () => actions.chats.setQueue(chat.id, await call('chats.sendNow', { chatId: chat.id, id: q.id })))}
          onRemove={(q) => void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id })))}
        />
        {banner}
        <div className="cmp-box">
          {acOpen && rows.length > 0 && (
            <div role="listbox" aria-label={mention ? mentionGroups.map((g) => g.label).join(' and ') : slashGroups.map((g) => g.label).join(' and ')} className="cmp-ac">
              {mention
                ? mentionGroups.map((g) => (
                  <Fragment key={g.label}>
                    <p>{g.label}</p>
                    {g.rows.map((r) => {
                      const i = mentionRows.indexOf(r)
                      return r.kind === 'agent' ? (
                        <button key={`agent:${r.agent.id}`} type="button" role="option" aria-selected={i === at} aria-label={`${r.agent.name}, ${r.agent.role}`} className="cmp-ac-row" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i, true)}>
                          <Icon name="user" size={14} /><span className="mono">{r.agent.name}</span><span className="sub ellipsis">{r.agent.role}</span>
                        </button>
                      ) : (
                        <button key={r.entry.path} type="button" role="option" aria-selected={i === at} className="cmp-ac-row" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i, true)}>
                          <FileIcon path={r.entry.path} dir={r.entry.dir} /><span className="mono">{baseName(r.entry.path)}{r.entry.dir && '/'}</span><span className="sub ellipsis">{r.entry.reference ?? dirName(r.entry.path)}</span>
                        </button>
                      )
                    })}
                  </Fragment>
                ))
                : slashGroups.map((g) => (
                  <Fragment key={g.label}>
                    <p>{g.label}</p>
                    {g.rows.map((s) => {
                      const i = slashRows.indexOf(s)
                      return (
                        <button key={s.name} type="button" role="option" aria-selected={i === at} className="cmp-ac-row" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i, true)}>
                          <span className="mono">/{s.name}</span><span className="sub ellipsis">{s.description}</span>
                        </button>
                      )
                    })}
                  </Fragment>
                ))}
            </div>
          )}
          {acOpen && mention && !files.length && !mentionAgents.length && query !== undefined && query.length > 0 && (
            <div className="cmp-ac" role="status"><p style={{ margin: '6px 8px' }}>No files match “{mention.query}”.</p></div>
          )}
          <div className="composer cmp" data-plan={chat.plan || plan ? 'true' : undefined} data-blocked={blocked || undefined} style={{ opacity: blocked ? 0.5 : 1 }} {...d.drop}>
            {plan && <PlanBar a={plan} />}
            <DraftInput d={d} aria-label={`Message ${name}`} aria-autocomplete="list" disabled={blocked} placeholder={placeholder}
              onInput={() => setDismissed('')} onKeyDown={onKey} />
            <div className="row cmp-foot">
              {!agent?.lead && <span className="cmp-agent"><span className="cmp-name">{name}</span><span className="muted cmp-role">{agent?.role}</span></span>}
              <span ref={modelAnchor} style={{ position: 'relative' }}>
                <Button variant="ghost" className="cmp-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{model}<span className="muted" style={{ fontWeight: 400 }}>{effort}</span><Icon name="chevron" size={12} /></Button>
                {menu === 'model' && <ModelPicker anchorRef={modelAnchor} provider={provider} grouped={grouped} started={!!chat.sessionId} onNewChat={(p, m, x) => { setMenu(null); newChatOn(p, m, x) }} model={chat.model} effort={chat.effort} fallback={fallback} onClose={() => setMenu(null)} onModel={(m, x) => { setMenu(null); pickModel(m, x) }} onEffort={setEffort} />}
              </span>
              <span ref={modeAnchor} style={{ position: 'relative' }}>
                <Button variant="ghost" className="cmp-model cmp-mode" data-mode={shown.runs} aria-label={modeAria(shown)} aria-haspopup="menu" aria-expanded={menu === 'mode'} onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>
                  <Icon name={MODE_ICON[shown.runs]} size={14} /><span className="cmp-mode-name">{buttonName(shown.runs)}</span><Icon name="chevron" size={12} />
                </Button>
                {menu === 'mode' && <ModeMenu anchorRef={modeAnchor} provider={provider} availability={availability} shown={shown} onPick={(m) => { setMenu(null); pickMode(m); d.focus() }} onCycle={cycleMode} onClose={() => setMenu(null)} />}
              </span>
              <span className="grow" />
              {chat.context !== undefined && <ContextRing chat={chat} blocked={blocked} open={menu === 'context'} onOpen={(o) => setMenu(o ? 'context' : null)} />}
              <span ref={plusAnchor} style={{ position: 'relative' }}>
                <PlusMenu panel={menu === 'model' || menu === 'context' || menu === 'mode' ? null : menu} onPanel={setMenu} anchorRef={plusAnchor} roomId={roomId} workspaceId={chat.workspaceId}
                  onMode={() => setMenu('mode')} onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
              </span>
              {running && !hasDraft
                ? <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={() => void call('chats.interrupt', { chatId: chat.id })}><span /></button>
                : <button type="button" className="icon-btn send" aria-label={plan ? 'Send plan adjustments' : running ? 'Queue message' : 'Send'} data-ready={hasDraft && !blocked} disabled={blocked} onClick={() => void send()}><Icon name="up" size={14} /></button>}
            </div>
          </div>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
    </div>
  )
}
