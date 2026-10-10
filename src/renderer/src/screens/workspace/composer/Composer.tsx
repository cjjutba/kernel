import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentDef, BuiltinCommand, Chat, ChatPart, Effort, FileEntry, ModelId, QueuedMessage, Skill } from '@shared/types'
import { MODELS } from '@shared/types'
import { call } from '../../../api'
import { actions, getState, loadWorkspace, useStore } from '../../../store'
import { Button, Icon } from '../../../ui'
import { attempt } from '../MessageActions'
import { PlanBar } from '../cards/plan'
import { noteFromParts, waitingPlan } from '../cards/steps'
import { baseName, dirName, mentionAt, runsOnEnter, slashAt, slashMenu } from './autocomplete'
import { onAddToComposer, onComposerCommand, takeComposerFocus } from './bus'
import { DraftInput, useDraft } from './draft'
import { ContextRing } from './ContextRing'
import { HunkCard } from './HunkCard'
import { ModelPicker } from './ModelPicker'
import { effortFor } from '@shared/effort'
import { effortLabel, nextEffort, rememberEffort, useDefaultEffort, useEffortMemory } from './modelPrefs'
import { PlusMenu, type PlusPanel } from './PlusMenu'
import { QueueList } from './QueueList'
import './composer.css'

const EMPTY_QUEUE: QueuedMessage[] = []
/**
 * The newest prefill already put in a box, so a composer that remounts doesn't write an old one over a restored draft.
 * It compares `n`, which `Workspace` sets from `Date.now()`, so it only goes up. A per-mount counter would block every edit after the first.
 */
let appliedPrefill = 0

type MenuName = 'model' | 'context' | PlusPanel

/**
 * The message box under the transcript. The message is a list of parts: typed text and chips (pasted text, images,
 * files, skills, diff hunks) inline, in order. Enter sends, Shift+Enter breaks the line, Backspace takes a chip like a
 * character. While the agent works, a sent message waits in the queue above the box.
 */
export function Composer({ chat, agent, blocked, running, prefill, banner }: { chat: Chat; agent?: AgentDef; blocked: boolean; running: boolean; prefill?: { text: string; n: number }; /** A failure banner, drawn right above the box (KERNEL-28). */ banner?: ReactNode }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === chat.workspaceId))
  const queue = useStore((s) => s.queue[chat.id]) ?? EMPTY_QUEUE
  const forced = useStore((s) => s.ui.workspace.composer)
  // Fixtures open the context popover for a shot.
  const contextForced = useStore((s) => s.ui.workspace.contextOpen)
  // A plan waiting on you here puts Copy and Approve on the box, and what you send goes back as changes to it.
  const plan = useStore((s) => waitingPlan(s.approvals, chat))
  const d = useDraft(forced, chat.id)
  const [menu, setMenu] = useState<MenuName>(contextForced ? 'context' : null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [commands, setCommands] = useState<BuiltinCommand[]>([])
  const [files, setFiles] = useState<FileEntry[]>([])
  const [at, setAt] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const filePick = useRef<HTMLInputElement>(null)
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const name = agent?.name ?? 'the agent'

  const mention = mentionAt(d.before)
  const slash = slashAt(d.before, !d.first)
  const acKey = mention ? `@${mention.query}` : slash ? `/${slash.query}` : ''
  const acOpen = !!acKey && dismissed !== acKey && !blocked
  const groups = useMemo(() => (slash ? slashMenu(skills, commands, slash.query) : []), [skills, commands, slash?.query])
  const slashRows = groups.flatMap((g) => g.rows)
  const rows = mention ? files : slashRows
  const roomId = ws?.roomId

  // The queue is also pushed as events; this reads what was queued before the screen opened.
  useEffect(() => { void call('chats.queue', { chatId: chat.id }).then((q) => actions.chats.setQueue(chat.id, q)).catch(() => undefined) }, [chat.id])
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

  // A chat that was just created takes the caret. The frame lets a closing dialog hand focus back to its trigger first.
  useEffect(() => {
    if (blocked || !takeComposerFocus(chat.id)) return
    const f = requestAnimationFrame(() => d.focus())
    return () => cancelAnimationFrame(f)
  }, [chat.id])

  /** `run` is Enter or a click: a / row that needs nothing more is sent at once. Tab only completes it. */
  const pickRow = (i: number, run: boolean) => {
    if (mention) { const f = files[i]; if (f) d.insert({ type: 'file', name: baseName(f.path), path: f.path }, mention.query.length + 1) }
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
      actions.ui.toast({ title: 'Could not send', sub: (e as Error).message })
    }
  }

  const togglePlan = () => void configure({ plan: !chat.plan })
  const pickModel = (m: ModelId, effort: Effort) => void configure({ model: m, effort })
  const setEffort = (effort: Effort) => { rememberEffort(chat.model, effort); void configure({ effort }) }
  const memory = useEffortMemory()
  const fallback = useDefaultEffort(agent?.effort)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (acOpen && rows.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => (i + 1) % rows.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (i - 1 + rows.length) % rows.length); return }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickRow(at, e.key === 'Enter'); return }
    }
    if (acOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(acKey); return }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); return }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); togglePlan(); return }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
    if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i' && roomId) { e.preventDefault(); setMenu('linkIssue') }
  }

  const configure = (patch: { model?: ModelId; effort?: Effort; plan?: boolean }) => attempt('Could not change the chat', async () => { await call('chats.configure', { chatId: chat.id, ...patch }); await loadWorkspace(chat.workspaceId) })
  const editQueued = (q: QueuedMessage) => {
    const id = chat.id
    void attempt('Could not edit the message', async () => {
      actions.chats.setQueue(id, await call('chats.unqueue', { chatId: id, id: q.id }))
      // The call can outlast a switch to another chat, so the message goes back into the chat it was queued in.
      d.reset([...d.snapshot(id), ...q.parts], id)
    })
  }

  const model = MODELS.find((m) => m.id === chat.model)?.label ?? chat.model
  const effort = effortLabel(chat.effort)
  const hasDraft = !d.empty
  const placeholder = blocked ? 'Paused until this is resolved' : plan ? 'Enter your plan adjustments here' : running ? 'Add a follow up' : `Ask ${name} to make changes, @mention files, run /skills`

  // ^⌘1 to 4 pick a model (at the effort it last ran at) and ⌘⇧/ cycles the effort, with the picker open or not.
  // The open picker handles them itself and marks the event handled. ⌘L puts the caret in the box. ⌘⇧L is the Lead chat (App.tsx).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || getState().ui.modal) return
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyL') {
        if (blocked) return
        e.preventDefault()
        d.focus()
      } else if (e.ctrlKey && e.metaKey && /^[1-4]$/.test(e.key)) {
        const m = MODELS[Number(e.key) - 1]
        if (!m) return
        e.preventDefault()
        pickModel(m.id, m.id === chat.model ? chat.effort : effortFor(m.id, memory, fallback))
      } else if (e.metaKey && e.shiftKey && (e.key === '/' || e.key === '?')) {
        e.preventDefault()
        setEffort(nextEffort(chat.effort))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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
        <QueueList
          queue={queue}
          onEdit={editQueued}
          onNow={(q) => void attempt('Could not send now', async () => actions.chats.setQueue(chat.id, await call('chats.sendNow', { chatId: chat.id, id: q.id })))}
          onRemove={(q) => void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id })))}
        />
        {banner}
        <div className="cmp-box">
          {acOpen && rows.length > 0 && (
            <div role="listbox" aria-label={mention ? 'Files' : groups.map((g) => g.label).join(' and ')} className="cmp-ac">
              {mention
                ? <><p>Files</p>{files.map((f, i) => (
                  <button key={f.path} type="button" role="option" aria-selected={i === at} className="cmp-ac-row" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i, true)}>
                    <span className="mono">{baseName(f.path)}</span><span className="sub ellipsis">{dirName(f.path)}</span>
                  </button>
                ))}</>
                : groups.map((g) => (
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
          {acOpen && mention && !files.length && query !== undefined && query.length > 0 && (
            <div className="cmp-ac" role="status"><p style={{ margin: '6px 8px' }}>No files match “{mention.query}”.</p></div>
          )}
          <div className="composer cmp" data-plan={chat.plan || plan ? 'true' : undefined} style={{ opacity: blocked ? 0.5 : 1 }} {...d.drop}>
            {plan && <PlanBar a={plan} />}
            <DraftInput d={d} aria-label={`Message ${name}`} aria-autocomplete="list" disabled={blocked} placeholder={placeholder}
              onInput={() => setDismissed('')} onKeyDown={onKey} />
            <div className="row" style={{ gap: 6 }}>
              <span className="cmp-agent"><span className="agent-dot" aria-hidden="true">{name[0]?.toUpperCase()}</span><span className="cmp-name">{name}</span><span className="muted cmp-role">{agent?.role}</span></span>
              <span className="cmp-sep" />
              <span ref={modelAnchor} style={{ position: 'relative' }}>
                <Button variant="ghost" className="cmp-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{model}<span className="muted" style={{ fontWeight: 400 }}>{effort}</span><Icon name="chevron" size={11} stroke={1.9} /></Button>
                {menu === 'model' && <ModelPicker anchorRef={modelAnchor} model={chat.model} effort={chat.effort} fallback={fallback} onClose={() => setMenu(null)} onModel={(m, x) => { setMenu(null); pickModel(m, x) }} onEffort={setEffort} />}
              </span>
              <span className="grow" />
              {chat.context !== undefined && <ContextRing chat={chat} blocked={blocked} open={menu === 'context'} onOpen={(o) => setMenu(o ? 'context' : null)} />}
              <span ref={plusAnchor} style={{ position: 'relative' }}>
                <PlusMenu panel={menu === 'model' || menu === 'context' ? null : menu} onPanel={setMenu} anchorRef={plusAnchor} roomId={roomId} workspaceId={chat.workspaceId}
                  plan={chat.plan} onPlan={togglePlan} onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
              </span>
              {running && !hasDraft
                ? <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={() => void call('chats.interrupt', { chatId: chat.id })}><span /></button>
                : <button type="button" className="icon-btn send" aria-label={plan ? 'Send plan adjustments' : running ? 'Queue message' : 'Send'} data-ready={hasDraft && !blocked} disabled={blocked} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>}
            </div>
          </div>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
    </div>
  )
}
