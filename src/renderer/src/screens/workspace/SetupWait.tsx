import type { Chat, QueuedMessage, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Button, useBusy } from '../../ui'
import { attempt } from './MessageActions'
import { editQueuedInComposer } from './composer/bus'
import { PartChip } from './Transcript'
import { ChatSetupRows } from './ChatSetupRows'

const NO_QUEUE: QueuedMessage[] = []

/**
 * A chat whose workspace is still setting up, or whose setup failed or was stopped (KERNEL-430), drawn as Conductor draws a new
 * workspace (KERNEL-951): the setup rows, then the messages waiting for setup, dimmed where they will land, with Send now. Before
 * setup, a new chat's worktree is made in the background (`worktreePending`, KERNEL-543): the message reads as sent meanwhile.
 */
export function SetupWait({ ws, chat }: { ws: Workspace; chat?: Chat }) {
  const queue = useStore((s) => (chat ? s.queue[chat.id] : undefined)) ?? NO_QUEUE
  const failed = ws.status === 'failed'
  const making = !!ws.worktreePending && !failed
  // Send now while setup runs stops it and sends (KERNEL-951). With no worktree yet, there is nothing to send to.
  const running = !!ws.setupRun && !ws.setupRun.endedAt && !ws.worktreePending
  const [busy, track] = useBusy<'now'>()
  const unqueue = (q: QueuedMessage) => { if (chat) void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id }))) }
  const now = () => track('now', () => attempt('Could not send', () => call('scripts.skipSetup', { workspaceId: ws.id })))

  return (
    <div className="ws-scroll">
      <ChatSetupRows ws={ws} />
      <div className="thread setup-wait">
        {queue.map((q, i) => (
          <div key={q.id} className="msg msg-user" data-queued={making ? undefined : 'true'}>
            <div className="bubble">
              {q.parts.map((p, j) => (p.type === 'text' ? <span key={j}>{p.text} </span> : <PartChip key={j} part={p} />))}
            </div>
            <div className="queued-meta">
              {i === queue.length - 1 && !making && <span>{failed ? 'Waiting for setup' : 'Sends when setup finishes'}</span>}
              {i === queue.length - 1 && running && <Button size="sm" variant="ghost" busy={busy === 'now'} busyPattern="arrow-right" busyLabel="Sending" onClick={() => void now()}>Send now</Button>}
              <span className="queued-edit">
                <button type="button" className="link-btn" onClick={() => editQueuedInComposer(q)}>Edit</button>
                <button type="button" className="link-btn" onClick={() => unqueue(q)}>Cancel</button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
