import { useRef, useState, type KeyboardEvent } from 'react'
import type { AgentDef } from '@shared/types'
import { call } from '../../api'
import { Icon, IconButton, Menu } from '../../ui'
import { actions } from '../../store'
import { DraftInput, useDraft } from '../workspace/composer/draft'
import '../workspace/composer/composer.css'

/**
 * Brief the Lead, or message one agent. The Lead is the default recipient. Attachments land inline where the caret is,
 * as in the workspace composer. Enter sends, Shift+Enter breaks the line.
 */
export function Brief({ roomId, agents }: { roomId: string; agents: AgentDef[] }) {
  const [to, setTo] = useState('')
  const [menu, setMenu] = useState(false)
  const d = useDraft()
  const filePick = useRef<HTMLInputElement>(null)
  const imagePick = useRef<HTMLInputElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const lead = agents.find((a) => a.lead)
  const target = agents.find((a) => a.id === to)
  const placeholder = target ? `Message ${target.name}` : lead ? `Brief ${lead.name} on what to build` : 'Brief the Lead on what to build'

  const send = async () => {
    const parts = d.message()
    if (!parts.length) return
    const kept = d.snapshot()
    const text = d.plain()
    d.reset()
    try { await call('rooms.brief', { roomId, text, parts, agentId: to || undefined }) } catch (e) {
      d.reset(kept)
      actions.ui.toast({ title: 'Could not send that', sub: (e as Error).message })
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
  }

  return (
    <div className="floor-brief" {...d.drop}>
      <label htmlFor="floor-brief" className="sr-only">Message</label>
      <DraftInput d={d} id="floor-brief" placeholder={placeholder} onKeyDown={onKey} />
      <div className="row" style={{ gap: 8 }}>
        <span className="brief-to">
          <label htmlFor="floor-to" className="sr-only">Send to</label>
          <select id="floor-to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{lead ? `To ${lead.name} · Lead` : 'To the Lead'}</option>
            {agents.filter((a) => !a.lead).map((a) => <option key={a.id} value={a.id}>To {a.name} · {a.role}</option>)}
          </select>
          <Icon name="chevron" size={10} stroke={1.4} />
        </span>
        <span className="grow" />
        <span ref={plusAnchor} style={{ position: 'relative' }}>
          <IconButton icon="plus" label="Attachments" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} />
          {menu && (
            <Menu label="Add" anchorRef={plusAnchor} onClose={() => setMenu(false)} style={{ right: 0, bottom: 'calc(100% + 8px)', width: 240 }} items={[
              { id: 'attach', label: 'Add attachment', shortcut: '⌘U', onSelect: () => filePick.current?.click() },
              { id: 'image', label: 'Add image', onSelect: () => imagePick.current?.click() }
            ]} />
          )}
        </span>
        <button type="button" className="brief-send" aria-label="Send" disabled={d.empty} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>
      </div>
      <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      <input ref={imagePick} type="file" accept="image/*" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
    </div>
  )
}
