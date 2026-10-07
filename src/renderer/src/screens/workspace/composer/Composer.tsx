import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import type { AgentDef, Chat, ChatPart, Effort, FileEntry, ModelId, QueuedMessage, Skill } from '@shared/types'
import { MODELS } from '@shared/types'
import { call } from '../../../api'
import { actions, loadWorkspace, useStore } from '../../../store'
import { Button, Icon, IconButton, Menu, Spinner } from '../../../ui'
import { attempt } from '../MessageActions'
import { baseName, dirName, filterSkills, isLongPaste, mentionAt, pasteLines, slashAt } from './autocomplete'
import { onAddToComposer } from './bus'
import { HunkCard } from './HunkCard'
import { EFFORTS, ModelPicker } from './ModelPicker'
import { QueueList } from './QueueList'
import './composer.css'

const EMPTY_QUEUE: QueuedMessage[] = []
const MAX_ATTACH_BYTES = 1024 * 1024
let pasteCount = 1

type MenuName = null | 'model' | 'plus'

/** A short label under a chip: lines of a pasted text, or the size of an image. */
function chipMeta(p: ChatPart): string {
  if (p.type === 'file' && p.lines && !p.path) return `${p.lines} lines`
  if (p.type === 'image' && p.width && p.height) return `${p.width}×${p.height}`
  return ''
}

function ComposerChip({ part, onRemove }: { part: ChatPart; onRemove: () => void }) {
  if (part.type === 'text') return null
  const label = part.type === 'skill' ? `/${part.name}` : part.name
  const meta = chipMeta(part)
  return (
    <span className="chip cmp-chip" data-kind={part.type === 'skill' ? 'skill' : part.type === 'image' ? 'image' : 'file'}>
      {part.type === 'image' && part.dataUrl ? <img src={part.dataUrl} alt="" /> : <Icon name={part.type === 'image' ? 'image' : 'doc'} size={12} />}
      <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
      {meta && <span className="chip-meta">{meta}</span>}
      <button type="button" className="chip-x" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="close" size={10} /></button>
    </span>
  )
}

const readAsDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(new Error('Could not read that file.'))
  r.readAsDataURL(file)
})

const imageSize = (src: string) => new Promise<{ width: number; height: number } | undefined>((resolve) => {
  const img = new Image()
  img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
  img.onerror = () => resolve(undefined)
  img.src = src
})

/**
 * The message box under the transcript. The message is a list of parts: typed text and chips (pasted text, images,
 * files, skills, diff hunks) in the order they were added, then the live text box. Enter sends, Shift+Enter breaks the line,
 * Backspace in an empty box takes the last chip back. While the agent works, a sent message waits in the queue above the box.
 */
export function Composer({ chat, agent, blocked, running, prefill }: { chat: Chat; agent?: AgentDef; blocked: boolean; running: boolean; prefill?: { text: string; n: number } }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === chat.workspaceId))
  const queue = useStore((s) => s.queue[chat.id]) ?? EMPTY_QUEUE
  const forced = useStore((s) => s.ui.workspace.composer)
  const [segs, setSegs] = useState<ChatPart[]>(() => forced?.parts ?? [])
  const [draft, setDraft] = useState(() => forced?.draft ?? '')
  const [caret, setCaret] = useState(() => forced?.draft.length ?? 0)
  const [menu, setMenu] = useState<MenuName>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [files, setFiles] = useState<FileEntry[]>([])
  const [at, setAt] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
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

  useEffect(() => { if (prefill) { setDraft(prefill.text); setCaret(prefill.text.length); input.current?.focus() } }, [prefill])
  useEffect(() => { const el = input.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [draft])
  useEffect(() => onAddToComposer((part) => { setSegs((s) => [...s, part]); input.current?.focus() }), [])

  /** Add a chip where the caret is. `drop` is how much typed text right before the caret the chip replaces (the @ or / word). */
  const insert = useCallback((part: ChatPart, drop = 0) => {
    const head = draft.slice(0, caret - drop)
    const tail = draft.slice(caret)
    setSegs((s) => [...s, ...(head ? [{ type: 'text' as const, text: head }] : []), part])
    setDraft(tail); setCaret(0)
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(0, 0) })
  }, [draft, caret])

  const pickRow = (i: number) => {
    if (mention) { const f = files[i]; if (f) insert({ type: 'file', name: baseName(f.path), path: f.path }, mention.query.length + 1) }
    else if (slash) { const s = skillRows[i]; if (s) insert({ type: 'skill', name: s.name }, slash.query.length + 1) }
  }

  const attachFile = async (file: File) => {
    try {
      if (file.type.startsWith('image/')) {
        const dataUrl = await readAsDataUrl(file)
        const size = await imageSize(dataUrl)
        setSegs((s) => [...s, { type: 'image', name: file.name || 'image.png', dataUrl, ...size }])
      } else {
        if (file.size > MAX_ATTACH_BYTES) throw new Error(`${file.name} is too large to attach (${Math.round(file.size / 1024)} KB).`)
        const text = await file.text()
        if (text.includes('\0')) throw new Error(`${file.name} is a binary file. Attach an image or a text file.`)
        setSegs((s) => [...s, { type: 'file', name: file.name, lines: pasteLines(text), text }])
      }
    } catch (e) { actions.ui.toast({ title: 'Could not attach', sub: (e as Error).message }) }
  }

  const sendParts = (): ChatPart[] => {
    const parts: ChatPart[] = [...segs, ...(draft ? [{ type: 'text' as const, text: draft }] : [])]
    const first = parts.findIndex((p) => p.type !== 'text' || p.text.trim())
    return first < 0 ? [] : parts.slice(first).map((p, i) => (p.type === 'text' ? { ...p, text: i === parts.length - first - 1 ? p.text.trimEnd() : p.text } : p))
  }
  const send = async () => {
    const parts = sendParts()
    if (!parts.length || blocked) return
    const kept = { segs, draft }
    setSegs([]); setDraft(''); setCaret(0)
    try { await call('chats.send', { chatId: chat.id, parts }) }
    catch (e) {
      setSegs(kept.segs); setDraft(kept.draft)
      actions.ui.toast({ title: 'Could not send', sub: (e as Error).message })
    }
  }

  const mentionFile = () => {
    const next = `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}@`
    setDraft(next); setCaret(next.length)
    requestAnimationFrame(() => input.current?.focus())
  }
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click(); return }
    if (e.key === 'Backspace' && !draft && segs.length) {
      e.preventDefault()
      const last = segs[segs.length - 1]
      setSegs(segs.slice(0, -1))
      if (last.type === 'text') { setDraft(last.text); setCaret(last.text.length) }
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (images.length) { e.preventDefault(); images.forEach((f) => void attachFile(f)); return }
    const text = e.clipboardData.getData('text')
    if (isLongPaste(text)) {
      e.preventDefault()
      insert({ type: 'file', name: `pasted_text_${pasteCount++}.txt`, lines: pasteLines(text), text })
    }
  }
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    ;[...e.dataTransfer.files].forEach((f) => void attachFile(f))
  }

  const configure = (patch: { model?: ModelId; effort?: Effort; plan?: boolean }) => attempt('Could not change the chat', async () => { await call('chats.configure', { chatId: chat.id, ...patch }); await loadWorkspace(chat.workspaceId) })
  const editQueued = (q: QueuedMessage) => {
    void attempt('Could not edit the message', async () => {
      actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id }))
      const last = q.parts[q.parts.length - 1]
      const text = last?.type === 'text' ? last.text : ''
      setSegs([...segs, ...(draft ? [{ type: 'text' as const, text: draft }] : []), ...(text ? q.parts.slice(0, -1) : q.parts)])
      setDraft(text); setCaret(text.length)
      input.current?.focus()
    })
  }

  const model = MODELS.find((m) => m.id === chat.model)?.label ?? chat.model
  const effort = EFFORTS.find((x) => x.id === chat.effort)?.label ?? chat.effort
  const hasDraft = !!draft.trim() || segs.length > 0
  const placeholder = segs.length || draft ? '' : blocked ? 'Paused until this is resolved' : running ? 'Add a follow up' : `Ask ${name} to make changes, @mention files, run /skills`
  const retry = useStore((s) => s.retry[chat.id])

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
          <div className="composer cmp" style={{ opacity: blocked ? 0.5 : 1 }} onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={onDrop}>
            <div className="cmp-input" onClick={(e) => { if (e.target === e.currentTarget) input.current?.focus() }}>
              {segs.map((p, i) => (p.type === 'text'
                ? <span key={i} className="cmp-text">{p.text}</span>
                : <ComposerChip key={i} part={p} onRemove={() => setSegs(segs.filter((_, j) => j !== i))} />))}
              <textarea
                ref={input} rows={1} aria-label={`Message ${name}`} aria-autocomplete="list" autoComplete="off" spellCheck
                disabled={blocked} value={draft} placeholder={placeholder}
                onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); setDismissed('') }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyDown={onKey} onPaste={onPaste}
              />
            </div>
            <div className="row" style={{ gap: 6 }}>
              <span className="cmp-agent"><span className="agent-dot" aria-hidden="true">{name[0]?.toUpperCase()}</span>{name}<span className="muted">{agent?.role}</span></span>
              <span className="cmp-sep" />
              <span ref={modelAnchor} style={{ position: 'relative' }}>
                <Button variant="ghost" className="cmp-model" aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{model}<span className="muted" style={{ fontWeight: 400 }}>{effort}</span><Icon name="chevron" size={10} /></Button>
                {menu === 'model' && <ModelPicker anchorRef={modelAnchor} model={chat.model} effort={chat.effort} onClose={() => setMenu(null)} onModel={(m) => { setMenu(null); void configure({ model: m }) }} onEffort={(x) => void configure({ effort: x })} />}
              </span>
              {chat.plan && <Button className="cmp-plan" aria-label="Turn off plan mode" onClick={() => void configure({ plan: false })}>Plan mode<Icon name="close" size={9} stroke={2} /></Button>}
              {chat.context ? <span className="ink2" style={{ fontSize: 12 }}>Context {chat.context}%</span> : null}
              {retry && <span className="ink2" style={{ fontSize: 12 }}><Spinner label="Retrying" /> Retrying {retry.attempt} of {retry.of}</span>}
              <span className="grow" />
              <span ref={plusAnchor} style={{ position: 'relative' }}>
                <IconButton icon="plus" label="Plan mode and attachments" aria-haspopup="menu" aria-expanded={menu === 'plus'} onClick={() => setMenu(menu === 'plus' ? null : 'plus')} />
                {menu === 'plus' && (
                  <Menu label="Add" anchorRef={plusAnchor} onClose={() => setMenu(null)} style={{ right: 0, bottom: 'calc(100% + 8px)', width: 240 }} items={[
                    { id: 'plan', label: chat.plan ? 'Plan mode is on' : 'Plan mode', shortcut: '⇧Tab', onSelect: togglePlan },
                    { id: 'attach', label: 'Add attachment', shortcut: '⌘U', onSelect: () => filePick.current?.click() },
                    { id: 'image', label: 'Add image', onSelect: () => imagePick.current?.click() },
                    { id: 'mention', label: 'Mention a file', shortcut: '@', onSelect: mentionFile },
                    { id: 'skill', label: 'Run a skill', shortcut: '/', disabled: segs.length > 0 || !!draft, onSelect: () => { setDraft('/'); setCaret(1); requestAnimationFrame(() => input.current?.focus()) } }
                  ]} />
                )}
              </span>
              {running && !hasDraft
                ? <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={() => void call('chats.interrupt', { chatId: chat.id })}><span /></button>
                : <button type="button" className="icon-btn send" aria-label={running ? 'Queue message' : 'Send'} data-ready={hasDraft && !blocked} disabled={blocked} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>}
            </div>
          </div>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { [...(e.target.files ?? [])].forEach((f) => void attachFile(f)); e.target.value = '' }} />
        <input ref={imagePick} type="file" accept="image/*" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { [...(e.target.files ?? [])].forEach((f) => void attachFile(f)); e.target.value = '' }} />
      </div>
    </div>
  )
}
