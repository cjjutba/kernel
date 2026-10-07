import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { MODELS, type AgentDef, type Chat, type ChatPart, type Effort, type ModelId } from '@shared/types'
import { call } from '../../api'
import { loadWorkspace } from '../../store'
import { Button, Chip, Icon, IconButton, Menu, MENU_SEPARATOR } from '../../ui'
import { attempt } from './MessageActions'

const EFFORTS: { id: Effort; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }]
let pasteCount = 1

/**
 * The message box under the transcript. KERNEL-11 replaces this file with the full composer
 * (@ files, / skills, queue, more chips). This one sends text and chips, switches model and effort, and turns plan mode on.
 */
export function Composer({ chat, agent, blocked, running, prefill }: { chat: Chat; agent?: AgentDef; blocked: boolean; running: boolean; prefill?: { text: string; n: number } }) {
  const [draft, setDraft] = useState('')
  const [chips, setChips] = useState<ChatPart[]>([])
  const [menu, setMenu] = useState<null | 'model' | 'plus'>(null)
  const input = useRef<HTMLInputElement>(null)
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const name = agent?.name ?? 'the agent'

  useEffect(() => { if (prefill) { setDraft(prefill.text); input.current?.focus() } }, [prefill])

  const send = async () => {
    const parts: ChatPart[] = [...chips, ...(draft.trim() ? [{ type: 'text' as const, text: draft.trim() }] : [])]
    if (!parts.length || blocked) return
    setDraft(''); setChips([])
    await attempt('Could not send', () => call('chats.send', { chatId: chat.id, parts }))
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
    if (e.key === 'Backspace' && !draft && chips.length) setChips(chips.slice(0, -1))
  }
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      const reader = new FileReader()
      reader.onload = () => setChips((c) => [...c, { type: 'image', name: file.name || 'image.png', dataUrl: String(reader.result) }])
      reader.readAsDataURL(file)
      return
    }
    const text = e.clipboardData.getData('text')
    const lines = text.split('\n').length
    if (text.length > 280 || lines > 4) { e.preventDefault(); setChips((c) => [...c, { type: 'file', name: `pasted_text_${pasteCount++}.txt`, lines, text }]) }
  }
  const configure = (patch: { model?: ModelId; effort?: Effort; plan?: boolean }) => attempt('Could not change the chat', async () => { await call('chats.configure', { chatId: chat.id, ...patch }); await loadWorkspace(chat.workspaceId) })
  const model = MODELS.find((m) => m.id === chat.model)?.label ?? chat.model
  const effort = EFFORTS.find((x) => x.id === chat.effort)?.label ?? chat.effort
  const hasDraft = !!draft.trim() || chips.length > 0
  const placeholder = chips.length ? '' : blocked ? 'Paused until this is resolved' : running ? 'Add a follow up' : `Ask ${name} to make changes, @mention files, run /skills`

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="composer cmp" style={{ opacity: blocked ? 0.5 : 1 }}>
          <div className="cmp-input">
            {chips.map((c, i) => (
              <Chip key={i} kind={c.type === 'image' ? 'image' : 'file'} onRemove={() => setChips(chips.filter((_, j) => j !== i))}>{'name' in c ? c.name : ''}</Chip>
            ))}
            <input ref={input} aria-label={`Message ${name}`} autoComplete="off" disabled={blocked} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste} placeholder={placeholder} />
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="cmp-agent"><span className="agent-dot" aria-hidden="true">{name[0]?.toUpperCase()}</span>{name}<span className="muted">{agent?.role}</span></span>
            <span className="cmp-sep" />
            <span ref={modelAnchor} style={{ position: 'relative' }}>
              <Button variant="ghost" className="cmp-model" aria-haspopup="menu" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{model}<span className="muted" style={{ fontWeight: 400 }}>{effort}</span><Icon name="chevron" size={10} /></Button>
              {menu === 'model' && (
                <Menu label="Model" anchorRef={modelAnchor} onClose={() => setMenu(null)} style={{ left: 0, bottom: 'calc(100% + 8px)', width: 300 }} items={[
                  ...MODELS.map((m) => ({ id: m.id, label: m.label, shortcut: m.id === chat.model ? effort : undefined, onSelect: () => void configure({ model: m.id }) })),
                  MENU_SEPARATOR,
                  { id: 'effort', label: `Effort: ${effort}`, onSelect: () => { const i = EFFORTS.findIndex((x) => x.id === chat.effort); void configure({ effort: EFFORTS[(i + 1) % EFFORTS.length].id }) } }
                ]} />
              )}
            </span>
            {chat.plan && <Button className="cmp-plan" aria-label="Turn off plan mode" onClick={() => void configure({ plan: false })}>Plan mode<Icon name="close" size={9} stroke={2} /></Button>}
            {chat.context ? <span className="ink2" style={{ fontSize: 12 }}>Context {chat.context}%</span> : null}
            <span className="grow" />
            <span ref={plusAnchor} style={{ position: 'relative' }}>
              <IconButton icon="plus" label="Plan mode and attachments" aria-haspopup="menu" aria-expanded={menu === 'plus'} onClick={() => setMenu(menu === 'plus' ? null : 'plus')} />
              {menu === 'plus' && (
                <Menu label="Add" anchorRef={plusAnchor} onClose={() => setMenu(null)} style={{ right: 0, bottom: 'calc(100% + 8px)', width: 240 }} items={[
                  { id: 'plan', label: chat.plan ? 'Plan mode is on' : 'Plan mode', shortcut: '⇧Tab', onSelect: () => void configure({ plan: !chat.plan }) }
                ]} />
              )}
            </span>
            {running
              ? <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={() => void call('chats.interrupt', { chatId: chat.id })}><span /></button>
              : <button type="button" className="icon-btn send" aria-label="Send" data-ready={hasDraft && !blocked} disabled={blocked} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>}
          </div>
        </div>
      </div>
    </div>
  )
}
