import { useEffect, useRef, useState, type RefObject } from 'react'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { isLeadWorkspace, openLead } from '../../lead'
import { Avatar, Button, Icon, Spinner, useBusy } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { roomInView } from '../../screens/search/model'

/** The Lead's answer to the question just asked: text items after it, until the turn ends. */
function answerOf(items: { kind: string; ts: number; text?: string }[], since: number): string {
  return items.filter((i) => i.kind === 'text' && i.ts >= since).map((i) => i.text).join('\n\n').trim()
}

/** QuickAsk.png: a question to the room's Lead from anywhere. The answer shows here, with a way into the full chat. */
export function QuickAsk({ onClose, anchorRef }: { onClose: () => void; anchorRef: RefObject<HTMLElement | null> }) {
  const route = useStore((s) => s.ui.route)
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const room = roomInView(route, rooms, workspaces)
  const lead = room ? agents[room.id]?.find((a) => a.lead) : undefined
  // The popover unmounts when it closes, so the draft and the question live in the store, by room.
  const text = useStore((s) => (room ? s.quickAsk[room.id]?.draft : undefined)) ?? ''
  const asked = useStore((s) => (room ? s.quickAsk[room.id]?.asked : undefined))
  const sending = useStore((s) => (room ? !!s.quickAsk[room.id]?.sending : false))
  const [error, setError] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  const items = useStore((s) => (asked ? s.items[asked.chatId] : undefined))
  const running = useStore((s) => (asked ? !!s.running[asked.chatId] : false))
  const failed = items?.some((i) => i.kind === 'result' && i.ts >= (asked?.since ?? 0) && !i.ok)
  const answer = asked ? answerOf(items ?? [], asked.since) : ''
  const done = !!asked && !running && !!answer

  const name = lead?.name ?? 'the Lead'
  const openChat = async () => {
    if (!room) return
    onClose()
    await openLead(room.id)
    if (!asked) return
    // After a question, land on the chat it went to rather than the tab last selected. The tab is set after `openLead`
    // navigates: the workspace screen clears the tab when the workspace changes, so setting it first would be wiped.
    // `openLead` swallows its errors, so check the Lead's workspace is on screen before pointing a tab at its chat.
    const { route } = getState().ui
    const shown = route.name === 'workspace' ? getState().workspaces.find((w) => w.id === route.workspaceId) : undefined
    if (shown && isLeadWorkspace(shown, room.id, lead?.id)) actions.ui.openTab(shown.id, asked.chatId)
  }
  const ask = () => {
    if (!room || !text.trim()) return
    const question = text.trim()
    void run('ask', async () => {
      setError(null)
      actions.quickAsk.setSending(room.id, true)
      const since = Date.now()
      try {
        const { chatId } = await call('lead.ask', { roomId: room.id, text: question })
        actions.chats.setItems(chatId, await call('chats.items', { chatId }))
        actions.quickAsk.setAsked(room.id, { chatId, since, question })
      } catch (e) { setError((e as Error).message) }
      finally { actions.quickAsk.setSending(room.id, false) }
    })
  }
  useEffect(() => { ref.current?.querySelector('textarea')?.focus() }, [asked])

  return (
    <div ref={ref} role="dialog" aria-label={`Ask ${name}`} className="qa">
      <div className="qa-head">
        <Avatar name={name} size={20} solid />
        <span className="qa-name">Ask {name}</span>
        {room && <span className="qa-room">{room.name}</span>}
        <span className="grow" />
        {/* Not on QuickAsk.png: the chat without asking first (D-072). After a question, the footer has it. */}
        {!asked && lead && <button type="button" className="qa-open" onClick={() => void openChat()}>Open chat<Icon name="right" size={12} stroke={1.6} /></button>}
      </div>
      {asked ? (
        <div className="qa-thread" aria-live="polite">
          <p className="qa-q">{asked.question}</p>
          {answer ? <p className="qa-a selectable">{answer}</p> : failed ? <p className="qa-a">{name} could not answer. Open the chat to retry.</p> : <p className="qa-wait"><Spinner label={`${name} is answering`} />{name} is answering</p>}
        </div>
      ) : (
        <textarea
          className="qa-text" aria-label={`Your question for ${name}`} placeholder="What's the status of T-15? Who is blocked?" value={text} disabled={!room}
          onChange={(e) => room && actions.quickAsk.setDraft(room.id, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
        />
      )}
      {error && <p className="qa-err" role="alert">{error}</p>}
      <div className="qa-foot">
        <span className="qa-note">{asked ? '' : 'Answers here without opening a workspace'}</span>
        <span className="grow" />
        {asked ? (
          <>
            <Button variant="ghost" onClick={() => { if (room) actions.quickAsk.clearAsked(room.id); setError(null) }}>Ask another</Button>
            <Button variant="primary" disabled={!lead} onClick={() => void openChat()}>{done ? 'Open full chat' : 'Open chat'}</Button>
          </>
        ) : (
          <Button variant="primary" busy={!!busy || sending} busyLabel="Asking" disabled={!room || !text.trim()} onClick={ask}>Ask</Button>
        )}
      </div>
    </div>
  )
}

/** The footer's Ask Rowan button and its popover. */
export function AskRowanButton() {
  const open = useStore((s) => s.ui.menu === 'quickAsk')
  const route = useStore((s) => s.ui.route)
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const room = roomInView(route, rooms, workspaces)
  const name = (room && agents[room.id]?.find((a) => a.lead)?.name) ?? 'Rowan'
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <span ref={anchor} className="qa-anchor">
      <button type="button" className="ft-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => actions.ui.toggleMenu('quickAsk')}><Icon name="send" size={12} />Ask {name}</button>
      {open && <QuickAsk onClose={actions.ui.closeMenu} anchorRef={anchor} />}
    </span>
  )
}
