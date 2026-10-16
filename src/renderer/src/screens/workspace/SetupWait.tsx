import { useEffect, useState } from 'react'
import type { Chat, QueuedMessage, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, getState, go, useStore } from '../../store'
import { Button, Spinner, useBusy } from '../../ui'
import { attempt } from './MessageActions'
import { setupCommand } from './banners/model'
import { editQueuedInComposer } from './composer/bus'
import { PartChip } from './Transcript'
import { bottomKindOf } from './bottomSplit'

const NO_QUEUE: QueuedMessage[] = []

/** A duration as M:SS, for the live setup timer and the failed card. */
export const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** Time since `from`, redrawn each second while it counts. The start is main's, from when the setup script started. */
function useSince(from: number | undefined) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!from) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [from])
  return from ? clock(now - from) : undefined
}

/** What the failed card says happened: how long setup ran, and how it ended. A worktree git wouldn't make says so, with git's reason. */
export function setupEnd(ws: Workspace, cmd?: string): { title: string; sub?: string } {
  if (ws.worktreePending) return { title: "Couldn't create the worktree", sub: ws.worktreePending.error }
  const run = ws.setupRun?.endedAt ? ws.setupRun : undefined
  const took = run ? ` after ${clock(run.endedAt! - run.startedAt)}` : ''
  if (run?.end === null) return { title: `Setup stopped${took}`, sub: cmd }
  if (run?.end === 'timeout') return { title: `Setup timed out${took}`, sub: cmd }
  return { title: `Setup failed${took}`, sub: cmd && typeof run?.end === 'number' ? `${cmd} exited with ${run.end}` : cmd }
}

/**
 * A chat whose workspace is still setting up, or whose setup failed or was stopped (KERNEL-430, SetupRunning.png and the screens
 * after it). The messages waiting for setup are bubbles where they will land, and one line or card says where setup stands. Its
 * log stays in the Setup tab, which this opens while it shows. Before setup, a new chat's worktree is made in the background
 * (`worktreePending`, KERNEL-543): the message reads as sent and the line says Creating worktree, or the card says git couldn't.
 */
export function SetupWait({ ws, chat }: { ws: Workspace; chat?: Chat }) {
  const queue = useStore((s) => (chat ? s.queue[chat.id] : undefined)) ?? NO_QUEUE
  const cmd = useStore((s) => setupCommand(s.scripts[ws.id]))
  const panel = useStore((s) => s.ui.rightPanel)
  const kind = useStore((s) => bottomKindOf(s, ws))
  const failed = ws.status === 'failed'
  const making = !!ws.worktreePending && !failed
  // A run left from before this setup started doesn't count: only a run with no end is this one.
  const since = useSince(!failed && !making && ws.setupRun && !ws.setupRun.endedAt ? ws.setupRun.startedAt : undefined)
  const [busy, track] = useBusy<'again' | 'skip'>()

  // The Setup tab is on screen while this is, in a bottom pane that is open whatever the user left it as. The tab you were on comes back when setup is done,
  // and so does the pane's saved state: opening it here is not saved, so a collapse made meanwhile is what comes back (KERNEL-513).
  useEffect(() => {
    const before = getState().ui.workspace.bottom
    actions.ui.setWorkspaceView({ bottom: 'setup' })
    actions.ui.setBottomCollapsed(kind, false, false)
    return () => {
      if (getState().ui.workspace.bottom === 'setup' && before !== 'setup') actions.ui.setWorkspaceView({ bottom: before })
      actions.ui.restoreBottomCollapsed(kind)
    }
  }, [ws.id, kind])

  const showLog = () => { actions.ui.setRightPanel(true); actions.ui.setWorkspaceView({ bottom: 'setup' }); actions.ui.setBottomCollapsed(kind, false, false) }
  const unqueue = (q: QueuedMessage) => { if (chat) void attempt('Could not remove the message', async () => actions.chats.setQueue(chat.id, await call('chats.unqueue', { chatId: chat.id, id: q.id }))) }
  const again = () => track('again', () => attempt(ws.worktreePending ? 'Could not create the worktree' : 'Could not run setup', () => call('scripts.run', { workspaceId: ws.id, kind: 'setup' })))
  const skip = () => track('skip', () => attempt('Could not send', () => call('scripts.skipSetup', { workspaceId: ws.id })))
  const end = failed ? setupEnd(ws, cmd) : undefined

  return (
    <div className="ws-scroll">
      <div className="thread setup-wait">
        {queue.map((q, i) => (
          <div key={q.id} className="msg msg-user" data-queued={making ? undefined : 'true'}>
            <div className="bubble">
              {q.parts.map((p, j) => (p.type === 'text' ? <span key={j}>{p.text} </span> : <PartChip key={j} part={p} />))}
            </div>
            <div className="queued-meta">
              {i === queue.length - 1 && !making && <span>{failed ? 'Not sent yet' : 'Queued, sends after setup'}</span>}
              <button type="button" className="link-btn" onClick={() => editQueuedInComposer(q)}>Edit</button>
              <button type="button" className="link-btn" onClick={() => unqueue(q)}>Cancel</button>
            </div>
          </div>
        ))}
        {end ? (
          <div className="setup-card" role="status">
            <div className="row gap-10">
              <span>{end.title}</span>
              {end.sub && <span className="mono muted ellipsis t-chip">{end.sub}</span>}
            </div>
            <div className="row gap-4">
              {ws.worktreePending ? (
                <Button variant="primary" busy={busy === 'again'} busyPattern="rotate" busyLabel="Creating" disabled={busy !== null} onClick={() => void again()}>Try again</Button>
              ) : (
                <>
                  <Button variant="primary" busy={busy === 'again'} busyPattern="rotate" busyLabel="Starting" disabled={busy !== null} onClick={() => void again()}>Run again</Button>
                  <Button variant="ghost" busy={busy === 'skip'} busyPattern="arrow-right" busyLabel="Sending" disabled={busy !== null} onClick={() => void skip()}>Send anyway</Button>
                  <Button variant="ghost" disabled={busy !== null} onClick={() => go({ name: 'settings', page: 'project', projectId: ws.projectId, section: 'setup' })}>Edit script</Button>
                </>
              )}
            </div>
          </div>
        ) : making ? (
          <div className="setup-line" role="status">
            <Spinner label={null} pattern="snake" />
            <span className="ink2">Creating worktree</span>
            {ws.baseRef && <span className="mono muted ellipsis t-chip">{ws.baseRef}</span>}
          </div>
        ) : (
          <div className="setup-line" role="status">
            <Spinner label={null} pattern="snake" />
            <span className="ink2">Running setup</span>
            {cmd && <span className="mono muted ellipsis t-chip">{cmd}</span>}
            <span className="grow" />
            {since && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{since}</span>}
            {!panel && <button type="button" className="link-btn" onClick={showLog}>Show log</button>}
          </div>
        )}
      </div>
    </div>
  )
}
