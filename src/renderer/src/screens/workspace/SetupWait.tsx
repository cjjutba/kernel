import { useEffect } from 'react'
import type { Chat, QueuedMessage, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Button, LinkButton, useBusy } from '../../ui'
import { attempt } from './MessageActions'
import { editQueuedInComposer } from './composer/bus'
import { PartChip, TurnLine } from './Transcript'
import { sentAt } from './composer/sendMessage'
import { ChatSetupRows, CopyFailedRow } from './ChatSetupRows'

const NO_QUEUE: QueuedMessage[] = []

/**
 * A chat whose workspace is still setting up, or whose setup failed or was stopped (KERNEL-430), drawn like a new
 * workspace (KERNEL-951): the setup rows, then the messages waiting for setup, dimmed where they will land, with Send now. Before
 * setup, a new chat's worktree is made in the background (`worktreePending`, KERNEL-543): the message reads as sent meanwhile, with the
 * working line under it from the press of Send, as the turn that follows draws it.
 */
export function SetupWait({ ws, chat }: { ws: Workspace; chat?: Chat }) {
  const queue = useStore((s) => (chat ? s.queue[chat.id] : undefined)) ?? NO_QUEUE
  const failed = ws.status === 'failed'
  // Whether setup really holds a first message in main: Wait for setup is on (the project's own choice, else Settings) and a setup script runs on create (KERNEL-490). Until
  // the project's settings have loaded nothing is known to hold it, so the message reads as sent.
  const appSettings = useStore((s) => s.settings)
  const rs = useStore((s) => s.projectSettings[ws.projectId])
  useEffect(() => { if (!rs) void call('settings.project', { projectId: ws.projectId }).then((v) => actions.settings.setProject(ws.projectId, v)).catch(() => undefined) }, [rs, ws.projectId])
  const holds = !!rs && !!appSettings && !!(rs.workspace.leadWaitForSetup ?? appSettings.workspace.leadWaitForSetup) && !!rs.scripts.setup?.trim() && appSettings.scripts.setupOnCreate
  // A message a window sent from New chat (it has the id the window gave it, and `sentAt` while this window remembers the press) reads as sent until main really holds it for
  // setup. With Wait for setup off it never waits for setup: main sends it as soon as the worktree exists, so a setup run starting first doesn't make it wait, and the handover
  // never shows it as waiting. A failed setup is main holding it too.
  const going = (q: QueuedMessage) => !failed && (!!ws.worktreePending || (!holds && (sentAt(q.id) !== undefined || !!q.clientId)))
  // Send now while setup runs stops it and sends (KERNEL-951). With no worktree yet, there is nothing to send to.
  const running = !!ws.setupRun && !ws.setupRun.endedAt && !ws.worktreePending
  const [busy, track] = useBusy<'now'>()
  const unqueue = (q: QueuedMessage) => { if (chat) void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id }))) }
  const now = () => track('now', () => attempt('Could not send', () => call('scripts.skipSetup', { workspaceId: ws.id })))

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
              {i === queue.length - 1 && <span>{failed ? (ws.worktreePending?.fromShared ? 'Not sent yet' : 'Waiting for setup') : 'Sends when setup finishes'}</span>}
              {i === queue.length - 1 && running && <Button size="sm" variant="ghost" busy={busy === 'now'} busyPattern="arrow-right" busyLabel="Sending" onClick={() => void now()}>Send now</Button>}
              <span className="queued-edit">
                <LinkButton variant="quiet" size="meta" onClick={() => editQueuedInComposer(q)}>Edit</LinkButton>
                <LinkButton variant="quiet" size="meta" onClick={() => unqueue(q)}>Cancel</LinkButton>
              </span>
            </div>
            )}
          </div>
        ))}
        {queue.length > 0 && going(queue[0]) && !ws.worktreePending?.error && <TurnLine since={Math.min(queue[0].ts, sentAt(queue[0].id) ?? Infinity)} waiting={false} />}
        <CopyFailedRow ws={ws} />
      </div>
    </div>
  )
}
