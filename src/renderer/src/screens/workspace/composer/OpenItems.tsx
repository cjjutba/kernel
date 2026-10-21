import { useCallback, useEffect, useState } from 'react'
import type { Chat, OpenItem } from '@shared/types'
import { call, onPush } from '../../../api'
import { go, useStore } from '../../../store'
import { Button, Icon, LinkButton, useBusy, type IconName } from '../../../ui'
import './composer.css'

/** A question or task is cut to this in a row. The Lead has it whole. */
const TEXT_MAX = 80
const cut = (s = '') => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s)

/** What an item owes, in a few words. `itemLine` in main/features/openItems.ts is the Lead's version of the same lines. */
export function openItemText(i: OpenItem): string {
  switch (i.kind) {
    case 'question': return `${i.name} asked a question${i.text ? `: "${cut(i.text)}"` : ''}`
    case 'blockers': { const n = i.blockers ?? 1; return `${n} ${n === 1 ? 'blocker' : 'blockers'} in ${i.name}'s work not passed on` }
    case 'handoff.proposed': return `${i.name} proposed handing "${cut(i.text)}" to ${i.proposed?.name ?? 'another teammate'}`
    case 'mention': return `You addressed ${i.name}`
  }
}

/** The collapsed line: "2 open: Sean asked a question, blockers in Christian's work". */
const SHORT: Record<OpenItem['kind'], (i: OpenItem) => string> = {
  question: (i) => `${i.name} asked a question`,
  blockers: (i) => `blockers in ${i.name}'s work`,
  'handoff.proposed': (i) => `${i.name} proposed a hand-off`,
  mention: (i) => `you addressed ${i.name}`
}
export const openItemsLine = (items: OpenItem[]) => `${items.length} open: ${items.map((i) => SHORT[i.kind](i)).join(', ')}`

/** A row's mark and the one word of its button (Pen 10.8, 10.12): a question is answered where it was asked, blockers are opened and a proposed hand-off is reviewed. */
const ROW: Record<OpenItem['kind'], { icon: IconName; act: string }> = { question: { icon: 'question', act: 'Answer' }, blockers: { icon: 'info', act: 'Open' }, 'handoff.proposed': { icon: 'fork', act: 'Review' }, mention: { icon: 'info', act: 'Open' } }
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * What the Lead chat still owes (KERNEL-749), above the composer of its tabs: one line, opening to a row per item with Dismiss.
 * Shows nothing when nothing is owed. The list is `openItems.list` for the chat, read again on each `openItems.changed` for it.
 * A mention belongs to the tab that made it, so the other tabs leave it out. A chat deleted or closed pushes no `openItems.changed`,
 * so once the window no longer has the chat, or its thread closed, the list is empty (KERNEL-791).
 */
export function OpenItems({ chat }: { chat: Chat }) {
  const threadId = chat.threadId ?? chat.id
  const [owed, setItems] = useState<OpenItem[]>([])
  const gone = useStore((s) => !s.chats[chat.workspaceId]?.some((c) => c.id === chat.id) || !!(chat.threadId && s.threads[chat.threadId]?.closedAt))
  const items = gone ? [] : owed
  const [open, setOpen] = useState(false)
  const [busy, run] = useBusy<string>()
  const load = useCallback(() => call('openItems.list', { threadId }).then((all) => setItems(all.filter((i) => i.kind !== 'mention' || i.chatId === chat.id)), () => undefined), [threadId, chat.id])
  useEffect(() => {
    void load()
    return onPush((e) => { if (e.type === 'openItems.changed' && e.threadId === threadId) void load() })
  }, [load, threadId])
  if (!items.length) return null
  const dismiss = (i: OpenItem) => run(i.id, async () => { await call('openItems.dismiss', { id: i.id }).catch(() => undefined); await load() })
  return (
    <section className="open-items" aria-label="Open">
      <button type="button" className="open-items-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="info" size={16} />
        <span className="open-items-line ellipsis">{open ? `${items.length} open` : openItemsLine(items)}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <ul className="open-items-list">
          {items.map((i) => (
            <li key={i.id} className="open-items-row">
              <Icon name={ROW[i.kind].icon} size={14} />
              <span className="open-items-text" data-tip={openItemText(i)}>{upper(SHORT[i.kind](i))}</span>
              {i.workspaceId && <Button size="sm" aria-label={`${ROW[i.kind].act}: ${SHORT[i.kind](i)}`} disabled={busy !== null} onClick={() => go({ name: 'workspace', workspaceId: i.workspaceId as string })}>{ROW[i.kind].act}</Button>}
              <LinkButton variant="quiet" size="ui" busy={busy === i.id} busyLabel="Dismissing" disabled={busy !== null} aria-label={`Dismiss: ${SHORT[i.kind](i)}`} onClick={() => void dismiss(i)}>Dismiss</LinkButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
