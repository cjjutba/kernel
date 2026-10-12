import { useRef, type RefObject } from 'react'
import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { openLeadChat } from '../../lead'
import { askWhen } from './askWhen'

/**
 * The clock at the far right of the footer (KERNEL-589): Ask Rowan's history, the questions asked from Ask Rowan, newest first. Each
 * question became a chat with the room's Lead, so picking one opens that chat, with the answer in it.
 */
export function AskHistoryButton() {
  const open = useStore((s) => s.ui.menu === 'askHistory')
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <span ref={anchor} className="qa-anchor">
      <button type="button" className="icon-btn ft-icon" aria-label="Ask Rowan history" data-tip="Ask Rowan history" aria-haspopup="dialog" aria-expanded={open} onClick={() => actions.ui.toggleMenu('askHistory')}><Icon name="history" size={14} /></button>
      {open && <AskHistory anchor={anchor} />}
    </span>
  )
}

function AskHistory({ anchor }: { anchor: RefObject<HTMLSpanElement | null> }) {
  const list = useStore((s) => s.askHistory)
  const rooms = useStore((s) => s.rooms)
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: actions.ui.closeMenu, onOutside: actions.ui.closeMenu, ref, anchorRef: anchor })
  const now = Date.now()
  const pick = (roomId: string, chatId: string) => { actions.ui.closeMenu(); void openLeadChat(roomId, chatId) }
  return (
    <div ref={ref} role="dialog" aria-label="Ask Rowan history" className="qa ah">
      <div className="qa-head"><span className="qa-name">Ask Rowan history</span>{list.length > 0 && <span className="qa-room">{list.length === 1 ? '1 question' : `${list.length} questions`}</span>}</div>
      {list.length ? (
        <div className="ah-list">
          {list.map((e) => (
            <button key={`${e.chatId}:${e.at}`} type="button" className="ah-row" onClick={() => pick(e.roomId, e.chatId)}>
              <span className="ah-q">{e.question}</span>
              <span className="ah-meta">{rooms.find((r) => r.id === e.roomId)?.name ?? 'A removed room'} · {askWhen(e.at, now)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="ah-empty">No questions yet. What you ask Rowan from here shows up in this list.</p>
      )}
    </div>
  )
}
