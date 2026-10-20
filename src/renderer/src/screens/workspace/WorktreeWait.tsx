import type { Chat, QueuedMessage, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { LinkButton } from '../../ui'
import { attempt } from './MessageActions'
import { editQueuedInComposer } from './composer/bus'
import { PartChip, TurnLine } from './Transcript'
import { sentAt } from './composer/sendMessage'
import { ChatSetupRows, CopyFailedRow } from './ChatSetupRows'

const NO_QUEUE: QueuedMessage[] = []

/**
 * A chat whose workspace isn't made yet, or failed to start (KERNEL-430), drawn like a new workspace (KERNEL-951): the setup rows,
 * then the messages waiting for it, dimmed where they will land. A new chat's worktree is made in the background (`worktreePending`,
 * KERNEL-543): the message reads as sent meanwhile, with the working line under it from the press of Send, as the turn that follows
 * draws it. When git couldn't make it, the message reads as not sent until Try again. The setup script never holds a message, so
 * nothing here waits for it (KERNEL-1086).
 */
export function WorktreeWait({ ws, chat }: { ws: Workspace; chat?: Chat }) {
  const queue = useStore((s) => (chat ? s.queue[chat.id] : undefined)) ?? NO_QUEUE
  const failed = ws.status === 'failed'
  // A message a window sent (it has the id the window gave it, and `sentAt` while this window remembers the press) reads as sent while
  // the workspace is made: main sends it as soon as the worktree exists. A failure is main holding it until Try again.
  const going = (q: QueuedMessage) => !failed && (!!ws.worktreePending || sentAt(q.id) !== undefined || !!q.clientId)
  const unqueue = (q: QueuedMessage) => { if (chat) void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id }))) }

  return (
    <div className="ws-scroll">
      <ChatSetupRows ws={ws} underQueue />
      <div className="thread setup-wait">
        {queue.map((q, i) => (
          <div key={q.id} className="msg msg-user" data-queued={going(q) ? undefined : 'true'}>
            <div className="bubble">
              {q.parts.map((p, j) => (p.type === 'text' ? <span key={j}>{p.text} </span> : <PartChip key={j} part={p} />))}
            </div>
            {going(q) ? <div className="msg-acts-space" aria-hidden /> : (
            <div className="queued-meta">
              {i === queue.length - 1 && <span>{failed ? 'Not sent' : 'Sends when the workspace is ready'}</span>}
              <span className="queued-edit">
                <LinkButton variant="quiet" size="meta" onClick={() => editQueuedInComposer(q)}>Edit</LinkButton>
                <LinkButton variant="quiet" size="meta" onClick={() => unqueue(q)}>Cancel</LinkButton>
              </span>
            </div>
            )}
          </div>
        ))}
        {queue.length > 0 && going(queue[0]) && !ws.worktreePending?.error && <TurnLine since={Math.min(queue[0].ts, sentAt(queue[0].id) ?? Infinity)} waiting={false} />}
        {ws.worktreePending?.fromShared && <CopyFailedRow ws={ws} />}
      </div>
    </div>
  )
}
