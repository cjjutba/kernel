import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentDef, Chat, Effort, FileEntry, ModelId, QueuedMessage, Skill } from '@shared/types'
import { MODELS } from '@shared/types'
import { call } from '../../../api'
import { actions, loadWorkspace, useStore } from '../../../store'
import { Button, Icon, IconButton, Menu } from '../../../ui'
import { attempt } from '../MessageActions'
import { baseName, dirName, filterSkills, mentionAt, slashAt } from './autocomplete'
import { onAddToComposer, onComposerCommand } from './bus'
import { DraftInput, useDraft } from './draft'
import { HunkCard } from './HunkCard'
import { EFFORTS, ModelPicker } from './ModelPicker'
import { QueueList } from './QueueList'
import './composer.css'

const EMPTY_QUEUE: QueuedMessage[] = []

type MenuName = null | 'model' | 'plus'

/**
 * The message box under the transcript. The message is a list of parts: typed text and chips (pasted text, images,
 * files, skills, diff hunks) in the order they were added, then the live text box. Enter sends, Shift+Enter breaks the line,
 * Backspace at the start of the box takes the chip before it back. While the agent works, a sent message waits in the queue above the box.
 */
export function Composer({ chat, agent, blocked, running, prefill, banner }: { chat: Chat; agent?: AgentDef; blocked: boolean; running: boolean; prefill?: { text: string; n: number }; /** A failure banner, drawn right above the box (KERNEL-28). */ banner?: ReactNode }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === chat.workspaceId))
  const queue = useStore((s) => s.queue[chat.id]) ?? EMPTY_QUEUE
  const forced = useStore((s) => s.ui.workspace.composer)
  const d = useDraft(forced)
  const { segs, draft, caret, input } = d
  const [menu, setMenu] = useState<MenuName>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [files, setFiles] = useState<FileEntry[]>([])
  const [at, setAt] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const filePick = useRef<HTMLInputElement>(null)
  const imagePick = useRef<HTMLInputElement>(null)
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const name = agent?.name ?? 'the agent'

  const before = draft.slice(0, caret)
  const mention = mentionAt(before)
  const slash = slashAt(before, segs.length > 0)
  const acKey = mention ? `@${mention.query}` : slash ? `/${slash.query}` : ''
  const acOpen = !!acKey && dismissed !== acKey && !blocked
  const skillRows = useMemo(() => (slash ? filterSkills(skills, slash.query, 5) : []), [skills, slash?.query])
  const rows = mention ? files : skillRows
  const roomId = ws?.roomId

  // The queue is also pushed as events; this reads what was queued before the screen opened.
  useEffect(() => { void call('chats.queue', { chatId: chat.id }).then((q) => actions.chats.setQueue(chat.id, q)).catch(() => undefined) }, [chat.id])
  useEffect(() => { if (roomId) void call('skills.list', { roomId }).then(setSkills).catch(() => setSkills([])) }, [roomId])

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

  useEffect(() => { if (prefill) d.setText(prefill.text) }, [prefill])
  useEffect(() => onAddToComposer((part) => d.insert(part)), [])

  const pickRow = (i: number) => {
    if (mention) { const f = files[i]; if (f) d.insert({ type: 'file', name: baseName(f.path), path: f.path }, mention.query.length + 1) }
    else if (slash) { const s = skillRows[i]; if (s) d.insert({ type: 'skill', name: s.name }, slash.query.length + 1) }
  }

  const send = async () => {
    const parts = d.message()
    if (!parts.length || blocked) return
    const kept = d.snapshot()
    d.reset()
    try { await call('chats.send', { chatId: chat.id, parts }) }
    catch (e) {
      d.reset(kept)
      actions.ui.toast({ title: 'Could not send', sub: (e as Error).message })
    }
  }

  const mentionFile = () => d.setText(`${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}@`)
  const togglePlan = () => void configure({ plan: !chat.plan })
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (acOpen && rows.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => (i + 1) % rows.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (i - 1 + rows.length) % rows.length); return }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickRow(at); return }
    }
    if (acOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(acKey); return }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); return }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); togglePlan(); return }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
  }

  const configure = (patch: { model?: ModelId; effort?: Effort; plan?: boolean }) => attempt('Could not change the chat', async () => { await call('chats.configure', { chatId: chat.id, ...patch }); await loadWorkspace(chat.workspaceId) })
  const editQueued = (q: QueuedMessage) => {
    void attempt('Could not edit the message', async () => {
      actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id }))
      const last = q.parts[q.parts.length - 1]
      const text = last?.type === 'text' ? last.text : ''
      d.reset({ segs: [...segs, ...(draft ? [{ type: 'text' as const, text: draft }] : []), ...(text ? q.parts.slice(0, -1) : q.parts)], draft: text })
    })
  }

  const model = MODELS.find((m) => m.id === chat.model)?.label ?? chat.model
  const effort = EFFORTS.find((x) => x.id === chat.effort)?.label ?? chat.effort
  const hasDraft = !d.empty
  const placeholder = blocked ? 'Paused until this is resolved' : running ? 'Add a follow up' : `Ask ${name} to make changes, @mention files, run /skills`

  // A banner's "Queue message" sends what is typed (main holds it while the limit lasts), "Switch model" opens the picker.
  // Subscribed on every render, so the listener always sees the current draft.
  useEffect(() => onComposerCommand((c) => {
    if (c === 'model') { setMenu('model'); return }
    if (!d.empty) void send()
    else input.current?.focus()
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
            <div role="listbox" aria-label={mention ? 'Files' : 'Skills'} className="cmp-ac">
              <p>{mention ? 'Files' : 'Skills'}</p>
              {mention
                ? files.map((f, i) => (
                  <button key={f.path} type="button" role="option" aria-selected={i === at} className="cmp-ac-row" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i)}>
                    <span className="mono">{baseName(f.path)}</span><span className="sub ellipsis">{dirName(f.path)}</span>
                  </button>
                ))
                : skillRows.map((s, i) => (
                  <button key={s.name} type="button" role="option" aria-selected={i === at} className="cmp-ac-row" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i)}>
                    <span className="mono">/{s.name}</span><span className="sub ellipsis">{s.description}</span>
                  </button>
                ))}
            </div>
          )}
          {acOpen && mention && !files.length && query !== undefined && query.length > 0 && (
            <div className="cmp-ac" role="status"><p style={{ margin: '6px 8px' }}>No files match “{mention.query}”.</p></div>
          )}
          <div className="composer cmp" style={{ opacity: blocked ? 0.5 : 1 }} {...d.drop}>
            <DraftInput d={d} aria-label={`Message ${name}`} aria-autocomplete="list" disabled={blocked} placeholder={placeholder}
              onChange={() => setDismissed('')} onKeyDown={onKey} />
            <div className="row" style={{ gap: 6 }}>
              <span className="cmp-agent"><span className="agent-dot" aria-hidden="true">{name[0]?.toUpperCase()}</span>{name}<span className="muted">{agent?.role}</span></span>
              <span className="cmp-sep" />
              <span ref={modelAnchor} style={{ position: 'relative' }}>
                <Button variant="ghost" className="cmp-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{model}<span className="muted" style={{ fontWeight: 400 }}>{effort}</span><Icon name="chevron" size={10} /></Button>
                {menu === 'model' && <ModelPicker anchorRef={modelAnchor} model={chat.model} effort={chat.effort} onClose={() => setMenu(null)} onModel={(m) => { setMenu(null); void configure({ model: m }) }} onEffort={(x) => void configure({ effort: x })} />}
              </span>
              {chat.plan && <Button className="cmp-plan" aria-label="Turn off plan mode" onClick={() => void configure({ plan: false })}>Plan mode<Icon name="close" size={9} stroke={2} /></Button>}
              {chat.context ? <span className="ink2" style={{ fontSize: 12 }}>Context {chat.context}%</span> : null}
              <span className="grow" />
              <span ref={plusAnchor} style={{ position: 'relative' }}>
                <IconButton icon="plus" label="Plan mode and attachments" aria-haspopup="menu" aria-expanded={menu === 'plus'} onClick={() => setMenu(menu === 'plus' ? null : 'plus')} />
                {menu === 'plus' && (
                  <Menu label="Add" anchorRef={plusAnchor} onClose={() => setMenu(null)} style={{ right: 0, bottom: 'calc(100% + 8px)', width: 240 }} items={[
                    { id: 'plan', label: chat.plan ? 'Plan mode is on' : 'Plan mode', shortcut: '⇧Tab', onSelect: togglePlan },
                    { id: 'attach', label: 'Add attachment', shortcut: '⌘U', onSelect: () => filePick.current?.click() },
                    { id: 'image', label: 'Add image', onSelect: () => imagePick.current?.click() },
                    { id: 'mention', label: 'Mention a file', shortcut: '@', onSelect: mentionFile },
                    { id: 'skill', label: 'Run a skill', shortcut: '/', disabled: segs.length > 0 || !!draft, onSelect: () => d.setText('/') }
                  ]} />
                )}
              </span>
              {running && !hasDraft
                ? <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={() => void call('chats.interrupt', { chatId: chat.id })}><span /></button>
                : <button type="button" className="icon-btn send" aria-label={running ? 'Queue message' : 'Send'} data-ready={hasDraft && !blocked} disabled={blocked} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>}
            </div>
          </div>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
        <input ref={imagePick} type="file" accept="image/*" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
    </div>
  )
}
