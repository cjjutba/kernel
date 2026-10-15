import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentDef, BuiltinCommand, Chat, ChatPart, Decision, Effort, FileEntry, ModelId, PermissionMode, QueuedMessage, Skill, Workspace } from '@shared/types'
import type { LeadMode } from '@shared/types'
import { chatProvider } from '@shared/providers'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { leadModeOf } from '@shared/leadMode'
import { modelLabelOf, useCodexInUse, useProviderModels } from './providerModels'
import { call, cleanError } from '../../../api'
import { bypassConfirmed } from '../../../bypassConfirm'
import { FileIcon } from '../../../components/FileIcon'
import { useModeAvailability } from '../../../permissionModes'
import { actions, getState, loadWorkspace, setLeadMode, useStore } from '../../../store'
import { useProjectSettings } from '../../settings/useSettings'
import { Button, Icon, useBusy } from '../../../ui'
import { attempt } from '../MessageActions'
import { PlanStrip, usePlanStrip } from '../cards/plan'
import { placeAnswerNow } from '../cards/optimisticAnswer'
import { noteFromParts, waitingPlan } from '../cards/steps'
import { baseName, dirName, filterAgents, mentionAt, mentionMenu, mentionPart, runsOnEnter, slashAt, slashMenu } from './autocomplete'
import { onAddToComposer, onComposerCommand, onComposerFocusAsked, onEditQueued, takeComposerFocus } from './bus'
import { useDraft } from './draft'
import { escapeStops, queueBackInBox } from './stop'
import { loadFailureLine, useComposerLoads } from './useComposerLoads'
import { ComposerInput } from './ComposerInput'
import { ContextRing } from './ContextRing'
import { HunkCard } from './HunkCard'
import { ComposerToolbar } from './ComposerToolbar'
import { SWITCH_TOAST, SWITCH_TOAST_MS, lastRanOn, noteOpened, noteSent, warnsOnSwitch } from './modelSwitch'
import { rememberEffort, useDefaultEffort } from './modelPrefs'
import { useModelKeys } from './useModelKeys'
import { cyclePatch, cycleRun, leadDefaultLine, leadPlaceholder, modePatch, type CycleRun, nextMode, offLine, shownMode, type ComposerMode } from './modes'
import { ComposerShell } from './ComposerShell'
import type { PlusPanel } from './PlusMenu'
import { canSendNow, QueueList } from './QueueList'
import { sendMessage, sendQueuedNow } from './sendMessage'
import { sendsOn, useSendWith } from './sendKey'
import { NoteText } from '../NoteText'
import { UncommittedNote } from './UncommittedNote'
import { heldLine, waitersLine } from '../waitLines'

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
export function Composer({ chat, agent, blocked, running, prefill, banner }: { chat: Chat; agent?: AgentDef; blocked: boolean; running: boolean; prefill?: { text: string; n: number }; /** A failure banner, drawn right above the box (KERNEL-28). */ banner?: ReactNode; }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === chat.workspaceId))
  const waiting = useStore((s) => s.queue[chat.id]) ?? EMPTY_QUEUE
  // The messages Stop took out of the tray, and the one Send now drew as a bubble, leave it in the frame of the press, whatever main's queue events say while it takes them out one by one or still lists the one it is about to send.
  const [taken, setTaken] = useState<string[]>([])
  const queue = useMemo(() => (taken.length ? waiting.filter((q) => !taken.includes(q.id)) : waiting), [waiting, taken])
  useEffect(() => { if (taken.length && !waiting.some((q) => taken.includes(q.id))) setTaken([]) }, [waiting, taken])
  const queueWhy = useStore((s) => s.queueWhy[chat.id])
  // What this workspace waits for, and who waits for it, named live as PRs open and merge (KERNEL-259). Only those
  // workspaces are read, so a poll of the project's other PRs doesn't redraw the box.
  const related = useStore((s) => (ws ? s.workspaces.filter((w) => ws.waitsFor?.on.includes(w.id) || w.waitsFor?.on.includes(ws.id)) : EMPTY_WS))
  const team = useStore((s) => (ws ? s.agents[ws.projectId] : undefined)) ?? EMPTY_TEAM
  const held = useMemo(() => (ws ? heldLine(ws, related, team) : undefined), [ws, related, team])
  const waiters = useMemo(() => (ws ? waitersLine(ws, related, team) : undefined), [ws, related, team])
  const forced = useStore((s) => s.ui.workspace.composer)
  // Fixtures open the context popover for a shot.
  const contextForced = useStore((s) => s.ui.workspace.contextOpen)
  // A plan waiting on you here puts Copy and Approve on the box, and what you send goes back as changes to it.
  const plan = useStore((s) => waitingPlan(s.approvals, chat))
  const d = useDraft(forced, chat.id)
  // Approve is a user action, so the strip, the placeholder, the chip and the glow all change in the frame it is pressed (KERNEL-895). After it the caret goes to the box, where the Approve button had the focus.
  const strip = usePlanStrip(plan, () => d.focus())
  // Fixtures open the model picker and the mode menu the same way, through the app's menu, for a shot (WorkspaceModelPicker, KERNEL-406).
  // In a chat with Kernel the mode menu is Hand off and Build here (KERNEL-780).
  const [menu, setMenu] = useState<MenuName>(contextForced ? 'context' : getState().ui.menu === 'model' ? 'model' : getState().ui.menu === 'mode' ? 'mode' : null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [commands, setCommands] = useState<BuiltinCommand[]>([])
  const [files, setFiles] = useState<FileEntry[]>([])
  const [at, setAt] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const filePick = useRef<HTMLInputElement>(null)
  const run = useRef<CycleRun | null>(null)
  const name = agent?.name ?? 'the agent'
  // Only a chat with Kernel has a mode, Hand off or Build here (KERNEL-780).
  const withKernel = !!ws && isLeadChatWorkspace(ws)
  const leadMode = leadModeOf(ws)
  const projectLeadMode = useProjectSettings(withKernel ? ws.projectId : undefined)?.agents?.leadMode
  const appLeadMode = useStore((s) => s.settings?.team.leadMode)
  const pickLeadMode = (mode: LeadMode) => {
    d.focus()
    if (!ws || mode === leadMode) return
    void attempt('Could not switch', async () => {
      await setLeadMode(ws.id, mode)
      // Build here is a teammate's panel, with its changes first. Hand off goes back to the Lead's PR list.
      actions.ui.setWorkspaceView({ leadRight: mode === 'build' ? 'changes' : 'prs' })
    })
  }
  // The edits Kernel can't carry into a hand-off: teammates start from main and won't see them.
  const [dirty, setDirty] = useState<string[]>([])
  useEffect(() => {
    if (!withKernel || leadMode !== 'handoff' || !ws || ws.mode !== 'worktree') { setDirty([]); return }
    let live = true
    call('workspaces.changes', { workspaceId: ws.id, target: { kind: 'uncommitted' } })
      .then((files) => { if (live) setDirty(files.map((f) => f.path).filter((p) => !p.startsWith('.kernel/'))) })
      .catch(() => { if (live) setDirty([]) })
    return () => { live = false }
  }, [withKernel, leadMode, ws?.id, ws?.mode, running])

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
  const projectId = ws?.projectId

  // The queue, what it waits for and the run mode are also pushed as events; this reads what was set before the screen opened.
  // A read that failed says so above the box, with Retry, and is read again when the network is back.
  const { failed, retry } = useComposerLoads(chat.id)
  const [retrying, runRetry] = useBusy<'retry'>()
  useEffect(() => { if (projectId) void call('skills.list', { projectId }).then(setSkills).catch(() => setSkills([])) }, [projectId])
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
    // Back into the chat it came from, ahead of anything typed there since.
    const restore = (e: unknown) => {
      const since = d.snapshot(id)
      d.reset(since.length ? [...kept, ...since] : kept, id)
      actions.ui.toast({ title: 'Could not send', sub: cleanError(e) })
    }
    if (plan && !picked) {
      // Images go as files the agent reads, since a denial carries text only (D-134).
      const images = parts.flatMap((p) => p.type === 'image' && p.dataUrl ? [{ name: p.name, dataUrl: p.dataUrl }] : [])
      const decision: Decision = { behavior: 'deny', message: noteFromParts(parts), ...(images.length ? { images } : {}) }
      const undo = placeAnswerNow(plan, decision)
      try { await call('approvals.decide', { id: plan.id, decision }); noteSent(id, chat.model) }
      catch (e) { undo(); restore(e) }
      return
    }
    if (await sendMessage(id, parts, { onFail: restore })) noteSent(id, chat.model)
  }

  noteOpened(chat.id, chat.model)
  const pickModel = (m: string, effort: Effort) => {
    const warn = warnsOnSwitch(!!chat.sessionId, lastRanOn(chat.id), m)
    void configure({ model: m, effort }, warn ? () => actions.ui.toast(SWITCH_TOAST, SWITCH_TOAST_MS) : undefined)
  }
  // KERNEL-406: the chat's provider, its models, and a new tab on the other provider for a chat that has started.
  const provider = chatProvider(chat)
  const grouped = useCodexInUse(provider)
  // KERNEL-456: the mode the chat runs in comes from main (KERNEL-572), which the window reads once for a chat it hasn't heard of and then hears of each change.
  const runMode = useStore((s) => s.runModes[chat.id])
  const projectMode = useStore((s) => s.projects.find((r) => r.id === projectId)?.permissionMode)
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const availability = useModeAvailability()
  const shown = shownMode(chat.plan, runMode, chat.mode ?? projectMode ?? appMode ?? 'default')
  /** Plan sets `plan` and leaves the chat's `mode`. Every other mode sets `mode` and leaves plan. Bypass permissions asks once first, and what it saves is this chat's mode. */
  const setMode = (mode: ComposerMode, patch: (m: ComposerMode) => ReturnType<typeof modePatch> | ReturnType<typeof cyclePatch> = modePatch) => {
    if (mode === shown.picked) return
    if (mode === 'bypassPermissions' && !bypassConfirmed()) { run.current = null; setMenu(null); return actions.ui.openModal({ name: 'confirm', kind: 'bypass', chatId: chat.id }) }
    void configure(patch(mode))
  }
  const pickMode = (mode: ComposerMode) => { run.current = null; setMode(mode) }
  const cycleMode = () => {
    const { before } = (run.current = cycleRun(run.current, chat.id, chat.mode))
    setMode(nextMode(shown.picked, (m) => !offLine(m, provider, availability)), (m) => cyclePatch(before, m))
  }
  const providerModels = useProviderModels(provider)
  // The button reads the new effort at once, so ⌘⇧/ pressed again steps on from it. A change main refuses puts the old one back.
  const setEffort = (effort: Effort) => {
    const was = chat.effort
    rememberEffort(chat.model, effort)
    actions.chats.upsert({ ...chat, effort })
    void configure({ effort }).then((ok) => { if (!ok) actions.chats.upsert({ ...chat, effort: was }) })
  }
  const fallback = useDefaultEffort(agent?.effort)
  // Claude's guess at the next message (KERNEL-530) stands in for the placeholder of an empty box, and Tab or → takes it. Only a key does: Enter on an empty box sends nothing.
  const suggested = provider === 'claude' && !d.parts.length && !running && !chat.plan && !plan && !blocked && !queue.length && queueWhy !== 'setup' && !acOpen ? chat.suggestion : undefined
  const sendWith = useSendWith()
  const [sendingNow, runNow] = useBusy<string>()
  const sendNow = (q: QueuedMessage) => void runNow(q.id, () => attempt('Could not send now', async () => {
    setTaken((t) => [...t, q.id])
    try { await sendQueuedNow(chat.id, q) } catch (e) { setTaken((t) => t.filter((x) => x !== q.id)); throw e }
  }))
  const [stopping, runStop] = useBusy<'stop'>()
  /**
   * Stop clears the queue (D-030), so the messages it drops go back into the box, in order, after what was typed. All of it happens in the frame of the press (KERNEL-895): the
   * Working line leaves, Stop becomes Send, the tray empties and the text is in the box. The messages leave the queue first, so the turn can't send the next one as it ends,
   * and they are put back even when the interrupt fails. A stop that fails brings the Working line back, unless main has already said the turn ended.
   */
  const stop = () => void runStop('stop', async () => {
    const id = chat.id
    const dropped = [...(getState().queue[id] ?? [])]
    const wasRunning = !!getState().running[id]
    setTaken(dropped.map((q) => q.id))
    actions.chats.draw(id, { running: false })
    if (dropped.length) { d.reset(queueBackInBox(d.snapshot(id), dropped), id); d.focus() }
    try {
      for (const q of dropped) actions.chats.setQueue(id, await call('chats.unqueue', { chatId: id, id: q.id }))
      await call('chats.interrupt', { chatId: id })
    }
    catch (e) {
      actions.chats.undraw(id, { running: wasRunning })
      actions.ui.toast({ title: 'Could not stop', sub: cleanError(e) })
    }
  })
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (acOpen && rows.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => (i + 1) % rows.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (i - 1 + rows.length) % rows.length); return }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickRow(at, e.key === 'Enter'); return }
    }
    if (acOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(acKey); return }
    // After the menu, the pickers and the chips have had their Escape, it stops a running turn. It never clears or edits the draft.
    if (e.key === 'Escape' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && escapeStops({ running, stopping: stopping !== null, menuOpen: menu !== null, autocompleteOpen: acOpen })) { e.preventDefault(); stop(); return }
    if (suggested && (e.key === 'Tab' || e.key === 'ArrowRight') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); d.setText(suggested); d.focus(); return }
    // ⌘⇧ Enter sends the first queued message now, whatever Send messages with says.
    if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey) && queue.length && canSendNow(queueWhy)) { e.preventDefault(); sendNow(queue[0]); return }
    // Up in an empty box pulls the last queued message back, as clicking its text does.
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && d.empty && queue.length && queueWhy !== 'setup') { e.preventDefault(); editQueued(queue[queue.length - 1]); return }
    if (sendsOn(e, sendWith)) { e.preventDefault(); void send(); return }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return }
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) run.current = null
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
    if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i' && projectId) { e.preventDefault(); setMenu('linkIssue') }
  }

  const configure = (patch: { model?: string; effort?: Effort; plan?: boolean; mode?: PermissionMode | undefined }, onDone?: () => void) => attempt('Could not change the chat', async () => { await call('chats.configure', { chatId: chat.id, ...patch }); onDone?.(); await loadWorkspace(chat.workspaceId) })
  const editQueued = (q: QueuedMessage) => {
    const id = chat.id
    void attempt('Could not edit the message', async () => {
      actions.chats.setQueue(id, await call('chats.unqueue', { chatId: id, id: q.id }))
      // The call can outlast a switch to another chat, so the message goes back into the chat it was queued in.
      d.reset([...d.snapshot(id), ...q.parts], id)
    })
  }

  const model = modelLabelOf(chat.model, providerModels)
  const hasDraft = !d.empty
  const placeholder = blocked ? 'Paused until this is resolved' : plan ? 'Enter your plan adjustments here' : running || queueWhy === 'setup' ? 'Add a follow up' : suggested || (withKernel ? leadPlaceholder(leadMode, name) : `Ask ${name} to make changes, @mention files, run /skills`)

  // ^⌘1 to 9 pick the Nth current model of the chat's provider and ⌘⇧/ cycles the effort, with the picker open or not (useModelKeys).
  useModelKeys({ provider, model: chat.model, effort: chat.effort, fallback, onModel: pickModel, onEffort: setEffort })
  // ⌘L puts the caret in the box. ⌘⇧L is the Lead chat (App.tsx).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || getState().ui.modal) return
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyL') {
        if (blocked) return
        e.preventDefault()
        d.focus()
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
    if (c === 'linkIssue') { setMenu('linkIssue'); return }
    if (!d.empty) void send()
    else d.focus()
  }))

  return (
    <ComposerShell
      above={<>
        {ws && <HunkCard ws={ws} agentName={name} refreshKey={running} />}
        {waiters && <div className="note" role="status"><span className="note-text"><NoteText text={waiters.text} refs={waiters.refs} /></span></div>}
        <span className="sr-only" role="status" aria-live="polite">{strip.said}</span>
        {banner}
        {dirty.length > 0 && <UncommittedNote files={dirty} />}
        {loadFailureLine(failed) && (
          <div className="note" role="status">
            <span className="note-text grow">{loadFailureLine(failed)}</span>
            <Button variant="ghost" busy={retrying === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void runRetry('retry', retry)}>Retry</Button>
          </div>
        )}
        <QueueList
          queue={queue}
          why={queueWhy}
          held={held}
          running={running}
          sending={sendingNow}
          onEdit={editQueued}
          onNow={sendNow}
          onRemove={(q) => void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id })))}
        />
      </>}
      popup={<>
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
          <div className="cmp-ac" role="status"><p style={{ margin: '6px 8px' }}>{agent?.lead ? `No files or teammates match “${mention.query}”.` : `No files match “${mention.query}”.`}</p></div>
        )}
      </>}
      box={{ 'data-plan': chat.plan || plan ? 'true' : undefined, 'data-blocked': blocked || undefined, 'data-drop': d.over || undefined, style: { opacity: blocked ? 0.5 : 1 } }}
      top={<PlanStrip strip={strip} hasText={hasDraft} onSendChanges={() => void send()} onBack={d.focus} />}
      input={<ComposerInput d={d} aria-label={`Message ${name}`} aria-autocomplete="list" disabled={blocked} placeholder={placeholder} onInput={() => setDismissed('')} onKeyDown={onKey} />}
      foot={<ComposerToolbar
        lead={withKernel ? { mode: leadMode, footer: leadDefaultLine(projectLeadMode, appLeadMode), onPick: pickLeadMode } : undefined}
        agent={!agent?.lead && <span className="cmp-agent"><span className="cmp-name">{name}</span><span className="muted cmp-role">{agent?.role}</span></span>}
        model={{ label: model, provider, open: menu === 'model', onOpen: (o) => setMenu(o ? 'model' : null), picker: { provider, grouped, started: !!chat.sessionId, model: chat.model, effort: chat.effort, fallback, onClose: () => setMenu(null), onModel: (m, x) => { setMenu(null); pickModel(m, x) }, onEffort: setEffort } }}
        mode={{ provider, availability, shown, open: menu === 'mode', onOpen: (o) => setMenu(o ? 'mode' : null), onPick: (m) => { setMenu(null); pickMode(m); d.focus() }, onCycle: cycleMode }}
        context={chat.context !== undefined && <ContextRing chat={chat} blocked={blocked} open={menu === 'context'} onOpen={(o) => setMenu(o ? 'context' : null)} />}
        plus={{ panel: menu === 'model' || menu === 'context' || menu === 'mode' || menu === 'runIn' || menu === 'branch' ? null : menu, onPanel: setMenu, projectId, workspaceId: chat.workspaceId, onMode: () => setMenu('mode'), onAttach: () => filePick.current?.click(), onInsert: (parts) => { for (const p of parts) d.insert(p); d.focus() } }}
        send={{ label: plan ? 'Send plan adjustments' : running ? 'Queue message' : 'Send', ready: hasDraft && !blocked && !d.pending, disabled: blocked, busy: d.pending > 0, busyLabel: 'Attaching', stop: running, stopping: stopping !== null, onSend: () => void send(), onStop: stop }} />}
      hidden={<input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />}
    />
  )
}
