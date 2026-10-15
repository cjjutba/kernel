import { useEffect, useState } from 'react'
import type { Chat, MoveChoice, MoveNotice, Provider, RateLimit } from '@shared/types'
import { chatProvider } from '@shared/providers'
import { accountLabel, dollars, kTokens } from '../../../accountChats'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Banner, Button, useBusy } from '../../../ui'
import { attempt } from '../MessageActions'
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
 * choice, the accounts, and the provider's windows as `windowsKey` reads them. The last notice stays on screen while the next
 * one loads, so it doesn't flicker; another chat starts with none. Null while nothing needs saying.
 */
export function useMoveNotice(chat: Chat | undefined): MoveNotice | null {
  const accounts = useStore((s) => s.accounts)
  const provider = chat ? chatProvider(chat) : 'claude'
  const windows = useStore((s) => windowsKey(s.usage, provider))
  const [shown, setShown] = useState<{ chatId: string; notice: MoveNotice | null } | null>(null)
  const id = chat?.id
  const stamp = chat ? `${chat.ranOn}|${chat.model}|${chat.lastTurn?.at}|${chat.moveChoice?.choice}` : ''
  useEffect(() => {
    let live = true
    if (!id) return
    void call('chats.moveNotice', { chatId: id }).then((notice) => { if (live) setShown({ chatId: id, notice }) }).catch(() => undefined)
    return () => { live = false }
  }, [id, stamp, accounts, windows])
  return shown?.chatId === id ? shown.notice : null
}

const CHOICES: { choice: MoveChoice; label: string; busy: string }[] = [
  { choice: 'summarize', label: 'Continue with a summary', busy: 'Saving' },
  { choice: 'continue', label: 'Continue anyway', busy: 'Saving' }
]

/**
 * The notice above the composer before a long chat's next turn re-reads its history on another account or model (ChatMoveNotice.png,
 * KERNEL-841). Each button is `chats.moveChoice`, which the chat keeps until its next turn starts, so the notice shows once per move.
 * A chat cold only from idling gets a hint with no buttons.
 */
export function ChatMoveNotice({ chat, notice }: { chat: Chat; notice: MoveNotice }) {
  const accounts = useStore((s) => s.accounts)
  const queueWhy = useStore((s) => s.queueWhy[chat.id])
  const [busy, track] = useBusy<MoveChoice>()
  const provider = chatProvider(chat)
  const from = accountLabel(accounts, provider, notice.from)
  const to = accountLabel(accounts, provider, notice.to)
  const read = `${notice.estimated ? 'about ' : ''}${kTokens(notice.tokens)} tokens`
  const choose = (choice: MoveChoice) => void track(choice, () => attempt('Could not save your choice', async () => {
    actions.chats.upsert(await call('chats.moveChoice', { chatId: chat.id, choice }))
  }))

  if (notice.kind === 'idle') {
    return <Banner kind="context" title={`This chat has been idle, so its next turn re-reads ${read}.`}>{notice.price !== undefined ? `On this API key that costs about ${dollars(notice.price)}.` : undefined}</Banner>
  }
  const title = notice.reason === 'model'
    ? `Switching to ${notice.model} re-reads about ${kTokens(notice.tokens)} tokens.`
    : `This chat last ran on ${from}. Its next turn re-reads ${read} on ${to}.`
  const sub = [
    notice.price !== undefined ? `On this API key that costs about ${dollars(notice.price)}.` : '',
    queueWhy === 'move' ? 'Your queued messages wait for this choice.' : ''
  ].filter(Boolean).join(' ')
  const choices = notice.reason === 'model' ? CHOICES.slice(1) : CHOICES
  return (
    <Banner
      kind="context" title={title}
      actions={<span className="wsb-actions">
        {choices.map((c, i) => (
          <Button key={c.choice} variant={i === 0 ? 'primary' : 'secondary'} className="wsb-btn" busy={busy === c.choice} busyLabel={c.busy} disabled={busy !== null} onClick={() => choose(c.choice)}>{c.label}</Button>
        ))}
        {notice.keep && <Button variant="secondary" className="wsb-btn" busy={busy === 'keep'} busyLabel="Saving" disabled={busy !== null} onClick={() => choose('keep')}>Keep on {from}</Button>}
      </span>}
    >{sub || undefined}</Banner>
  )
}
