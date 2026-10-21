import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Chat, MoveChoice, MoveNotice, Provider, RateLimit } from '@shared/types'
import { chatProvider } from '@shared/providers'
import { accountLabel, dollars, kTokens } from '../../../accountChats'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { AgentAvatar, Button, useBusy } from '../../../ui'
import { attempt } from '../MessageActions'
import '../cards/cards.css'
import './banners.css'

/**
 * The parts of the provider's usage windows that change whether an account can run a chat: which window, whether it was
 * rejected, and whether it crossed the move threshold (5 hour 90%, weekly 95%). Every rate-limit event pushes new usage,
 * and most change none of these, so the notice doesn't ask again for them.
 */
const windowsKey = (usage: RateLimit[], provider: Provider) => usage
  .filter((l) => (l.provider ?? 'claude') === provider)
  .map((l) => `${l.type}:${l.accountId ?? ''}:${l.model ?? ''}:${l.status}:${(l.utilization ?? 0) >= 0.9 ? 'hi' : 'lo'}${(l.utilization ?? 0) >= 0.95 ? 'hi' : ''}`)
  .join('|')

/**
 * What the chat's next turn re-reads, asked from main when something it depends on changes: the chat's last turn, model and
 * choice, the accounts, the provider's windows as `windowsKey` reads them, and whether the chat waits for a move. The last notice stays on screen while the next
 * one loads, so it doesn't flicker; another chat starts with none. Null while nothing needs saying.
 */
export function useMoveNotice(chat: Chat | undefined): MoveNotice | null {
  const accounts = useStore((s) => s.accounts)
  const provider = chat ? chatProvider(chat) : 'claude'
  const windows = useStore((s) => windowsKey(s.usage, provider))
  // Only a chat held for a move has a notice (KERNEL-941), so the hold starting or ending asks again.
  const held = useStore((s) => (chat ? s.queueWhy[chat.id] === 'move' : false))
  const [shown, setShown] = useState<{ chatId: string; notice: MoveNotice | null } | null>(null)
  const id = chat?.id
  const stamp = chat ? `${chat.ranOn}|${chat.model}|${chat.lastTurn?.at}|${chat.moveChoice?.choice}` : ''
  useEffect(() => {
    let live = true
    if (!id) return
    void call('chats.moveNotice', { chatId: id }).then((notice) => { if (live) setShown({ chatId: id, notice }) }).catch(() => undefined)
    return () => { live = false }
  }, [id, stamp, accounts, windows, held])
  return shown && shown.chatId === id ? shown.notice : null
}

/** What a choice reads as on the card: its label, a line on what happens, and whether it is the one Kernel suggests. */
interface MovePick { choice: MoveChoice; label: string; desc: string; recommended?: boolean }

/**
 * Kernel's choice for a long chat that waits to move to another account (KERNEL-841, KERNEL-941, KERNEL-1094): a chat card in the transcript with numbered rows, like a question.
 * Pick one and press the button, or press its number and ⌘↵. The choice is `chats.moveChoice`, which the chat keeps until its next turn starts, so the card shows once per move.
 * Nothing runs until it is made, and messages typed meanwhile wait behind it.
 */
export function ChatMoveNotice({ chat, notice, agentName }: { chat: Chat; notice: MoveNotice; agentName: string }) {
  const accounts = useStore((s) => s.accounts)
  const [busy, track] = useBusy<MoveChoice>()
  const provider = chatProvider(chat)
  const from = accountLabel(accounts, provider, notice.from)
  const to = accountLabel(accounts, provider, notice.to)
  const read = `${notice.estimated ? 'about ' : ''}${kTokens(notice.tokens)} tokens`
  const model = notice.reason === 'model'
  const cost = notice.price !== undefined ? ` About ${dollars(notice.price)} on this API key.` : ''
  const picks = ([
    { choice: 'summarize', label: 'Continue with a summary', desc: `Kernel summarizes the chat first, so ${agentName} reads a short summary and not ${read}.`, recommended: true },
    { choice: 'continue', label: 'Continue anyway', desc: `${agentName} re-reads ${read}${model ? ` on ${notice.model}` : ` on ${to}`}.${cost}` },
    ...(notice.keep && !model ? [{ choice: 'keep', label: `Keep on ${from}`, desc: `The next turn runs on ${from}, and nothing is re-read.` }] : [])
  ] as MovePick[]).filter((p) => !(model && p.choice === 'summarize'))
  const [picked, setPicked] = useState<MoveChoice>(picks[0].choice)
  const group = useRef<HTMLDivElement>(null)
  const send = () => {
    if (busy !== null) return
    void track(picked, () => attempt('Could not save your choice', async () => {
      actions.chats.upsert(await call('chats.moveChoice', { chatId: chat.id, choice: picked }))
    }))
  }
  const title = model ? `Switching to ${notice.model} re-reads this chat` : `This chat last ran on ${from}`
  const body = model ? `${agentName}'s next turn re-reads ${read} on ${notice.model}. Nothing runs until you choose.` : `${agentName}'s next turn re-reads this chat's ${read} on the account you pick. Nothing runs until you choose.`
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (busy !== null || e.ctrlKey || e.altKey) return
    if (e.metaKey && e.key === 'Enter') { e.preventDefault(); return send() }
    if (e.metaKey || !/^[1-9]$/.test(e.key) || (e.target as HTMLElement).closest('textarea, input')) return
    const next = picks[Number(e.key) - 1]
    if (next) { e.preventDefault(); setPicked(next.choice) }
  }
  return (
    <section aria-label={title} className="card tcard" onKeyDown={keys}>
      <div className="tc-head"><AgentAvatar name="Kernel" size={18} /><h3>{title}</h3></div>
      <div className="tc-body"><span className="sub">{body}</span></div>
      <div ref={group} role="radiogroup" aria-label="How the chat moves" className="qrows">
        {picks.map((p, i) => (
          <button key={p.choice} type="button" role="radio" aria-checked={p.choice === picked} className="qrow" data-desc="true" disabled={busy !== null} onClick={() => setPicked(p.choice)}>
            <span className="n mono">{i + 1}</span>
            <span className="qtext"><span className="qlabel">{p.label}{p.recommended && <span className="qtag">Recommended</span>}</span><span className="qdesc">{p.desc}</span></span>
          </button>
        ))}
      </div>
      <div className="tc-foot">
        <span className="tc-hint">{agentName} waits until you choose</span>
        <Button variant="primary" aria-keyshortcuts="Meta+Enter" busy={busy !== null} busyPattern="ripple" busyLabel="Saving" onClick={send}>{picked === 'keep' ? 'Keep chat' : 'Move chat'}<span className="tc-kbd" aria-hidden="true">⌘↵</span></Button>
      </div>
    </section>
  )
}
