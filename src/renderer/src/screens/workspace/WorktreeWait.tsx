import type { Chat, QueuedMessage, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Icon, LinkButton, useBusy } from '../../ui'
import { attempt } from './MessageActions'
import { editQueuedInComposer } from './composer/bus'
import { PartChip, TurnLine } from './Transcript'
import { sentAt } from './composer/sendMessage'

const NO_QUEUE: QueuedMessage[] = []

/**
 * A chat whose worktree isn't made yet, or that git couldn't make one for (KERNEL-430, KERNEL-1086, KERNEL-1093). Its message reads as sent
 * meanwhile, with the Working line under it saying what is under way, as the turn that follows draws it. When git couldn't make the worktree
 * the message stays in the chat as Not sent, and the toast carries git's line and Try again. The setup script never holds a message, so no row
 * here waits for it. A workspace an older Kernel failed with its brief held keeps Run again and Send anyway, which send it at once.
 */
export function WorktreeWait({ ws, chat }: { ws: Workspace; chat?: Chat }) {
  const queue = useStore((s) => (chat ? s.queue[chat.id] : undefined)) ?? NO_QUEUE
  const [busy, track] = useBusy<'again' | 'skip'>()
  const failed = ws.status === 'failed'
  // A message a window sent (it has the id the window gave it, and `sentAt` while this window remembers the press) reads as sent while
  // the workspace is made: main sends it as soon as the worktree exists. A failure is main holding it until Try again.
  const going = (q: QueuedMessage) => !failed && (!!ws.worktreePending || sentAt(q.id) !== undefined || !!q.clientId)
  const unqueue = (q: QueuedMessage) => { if (chat) void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id }))) }
  const legacy = failed && !ws.worktreePending
  const again = () => track('again', () => attempt('Could not run setup', () => call('scripts.run', { workspaceId: ws.id, kind: 'setup' })))
  const skip = () => track('skip', () => attempt('Could not send', () => call('scripts.skipSetup', { workspaceId: ws.id })))

  return (
    <div className="ws-scroll">
      <div className="thread setup-wait">
        {queue.map((q, i) => (
          <div key={q.id} className="msg msg-user" data-queued={going(q) ? undefined : 'true'} data-failed={failed || undefined}>
            <div className="bubble">
              {q.parts.map((p, j) => (p.type === 'text' ? <span key={j}>{p.text} </span> : <PartChip key={j} part={p} />))}
            </div>
            {going(q) ? <div className="msg-acts-space" aria-hidden /> : (
              <div className="queued-meta">
                {i === queue.length - 1 && (failed
                  ? <span className="not-sent"><Icon name="alertCircle" size={12} />Not sent</span>
                  : <span>Sends when the workspace is ready</span>)}
                {legacy && i === queue.length - 1 && <>
                  <LinkButton variant="quiet" size="meta" busy={busy === 'again'} busyLabel="Starting" disabled={busy !== null} onClick={() => void again()}>Run again</LinkButton>
                  <LinkButton variant="quiet" size="meta" busy={busy === 'skip'} busyLabel="Sending" disabled={busy !== null} onClick={() => void skip()}>Send anyway</LinkButton>
                </>}
                <span className="queued-edit">
                  <LinkButton variant="quiet" size="meta" onClick={() => editQueuedInComposer(q)}>Edit</LinkButton>
                  <LinkButton variant="quiet" size="meta" onClick={() => unqueue(q)}>Cancel</LinkButton>
                </span>
              </div>
            )}
          </div>
        ))}
        {queue.length > 0 && going(queue[0]) && !ws.worktreePending?.error && <TurnLine since={Math.min(queue[0].ts, sentAt(queue[0].id) ?? Infinity)} note={ws.worktreePending ? 'Creating the worktree' : undefined} />}
      </div>
    </div>
  )
}
