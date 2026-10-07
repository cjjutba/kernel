import { useState } from 'react'
import type { AgentDef } from '@shared/types'
import { call } from '../../api'
import { Icon } from '../../ui'
import { actions } from '../../store'

/** Brief the Lead, or message one agent. The Lead is the default recipient. */
export function Brief({ roomId, agents }: { roomId: string; agents: AgentDef[] }) {
  const [draft, setDraft] = useState('')
  const [to, setTo] = useState('')
  const lead = agents.find((a) => a.lead)
  const target = agents.find((a) => a.id === to)
  const placeholder = target ? `Message ${target.name}` : lead ? `Brief ${lead.name} on what to build` : 'Brief the Lead on what to build'
  const text = draft.trim()
  const send = async () => {
    if (!text) return
    setDraft('')
    try { await call('rooms.brief', { roomId, text, agentId: to || undefined }) } catch (e) {
      setDraft(text)
      actions.ui.toast({ title: 'Could not send that', sub: (e as Error).message })
    }
  }
  return (
    <div className="floor-brief">
      <label htmlFor="floor-brief" className="sr-only">Message</label>
      <input id="floor-brief" type="text" autoComplete="off" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
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
        <button type="button" className="brief-send" aria-label="Send" disabled={!text} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>
      </div>
    </div>
  )
}
