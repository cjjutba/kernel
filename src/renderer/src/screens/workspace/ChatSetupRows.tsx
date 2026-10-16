import { useEffect, useState } from 'react'
import type { ScriptLine, Workspace } from '@shared/types'
import { stripAnsi } from '@shared/toolView'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon, Spinner, useBusy } from '../../ui'
import { attempt } from './MessageActions'
import { bottomKindOf } from './bottomSplit'

const NO_LINES: ScriptLine[] = []

/** A duration as M:SS, for the live setup timer and the rows after it. */
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

/** Kernel's own closing lines in the setup log, which the row already says in its own words. */
const KERNEL_NOTE = /^Setup (failed with exit code|didn't finish in|was stopped)/

/** The setup log's last line worth showing: the one being printed while setup runs, or the script's last word once it ended. */
function lastLine(lines: ScriptLine[]): string | undefined {
  return lines.filter((l) => l.kind === 'setup').map((l) => stripAnsi(l.line).trim()).filter((l) => l && !l.startsWith('$ ') && !KERNEL_NOTE.test(l)).at(-1)
}

/** How a finished setup run reads on its row (KERNEL-951). A stop that Send now asked for isn't a failure. */
function endText(ws: Workspace): { text: string; failed: boolean } | undefined {
  const run = ws.setupRun
  if (!run?.endedAt) return undefined
  const took = clock(run.endedAt - run.startedAt)
  if (run.end === 0) return { text: `Completed setup script in ${took}`, failed: false }
  if (run.end === null) return { text: `Stopped setup script after ${took}`, failed: ws.status === 'failed' }
  if (run.end === 'timeout') return { text: `Setup script timed out after ${took}`, failed: true }
  return { text: `Setup script failed after ${took}`, failed: true }
}

/** Opens the Setup tab of the bottom pane, with the right panel open. */
function useShowLog(ws: Workspace) {
  const kind = useStore((s) => bottomKindOf(s, ws))
  return () => { actions.ui.setRightPanel(true); actions.ui.setWorkspaceView({ bottom: 'setup' }); actions.ui.setBottomCollapsed(kind, false, false) }
}

/**
 * What Kernel did to start a chat's worktree, as plain rows at the top of the chat, the way Conductor shows a new workspace
 * (KERNEL-951): the branch, the worktree and its copied files, and the setup script, live while it runs with its last output
 * line, then how long it took. A failed setup offers Run again and Send anyway on its row. The log is one click away, never
 * opened for you. A chat on the current branch, the Lead's shared worktree, or a later worktree chat in the project has none of this, so it shows nothing.
 */
export function ChatSetupRows({ ws }: { ws: Workspace }) {
  const project = useStore((s) => s.projects.find((p) => p.id === ws.projectId))
  const lines = useStore((s) => s.scripts[ws.id]) ?? NO_LINES
  const run = ws.setupRun
  const since = useSince(run && !run.endedAt ? run.startedAt : undefined)
  const showLog = useShowLog(ws)
  const [busy, track] = useBusy<'again' | 'skip' | 'stop'>()
  // Only the project's first worktree chat shows the block. Chats from before the stamp have none and count as first.
  if (ws.mode !== 'worktree' || (ws.lead && !ws.threadId) || ws.firstInProject === false) return null
  const pending = ws.worktreePending
  const end = endText(ws)
  const tail = run ? lastLine(lines) : undefined
  const again = () => track('again', () => attempt(pending ? 'Could not create the worktree' : 'Could not run setup', () => call('scripts.run', { workspaceId: ws.id, kind: 'setup' })))
  const skip = () => track('skip', () => attempt('Could not send', () => call('scripts.skipSetup', { workspaceId: ws.id })))
  const stop = () => track('stop', () => attempt('Could not stop setup', () => call('scripts.stop', { workspaceId: ws.id, kind: 'setup' })))
  const logLink = <button type="button" className="su-out" aria-label="Open the setup log" onClick={showLog}><Icon name="ext" size={12} /></button>

  return (
    <section className="su-rows su-chat" aria-label="Chat setup">
      {project && <p className="su-banner">You're in a new copy of <code>{project.name}</code> on its own branch</p>}
      {pending ? (
        <div className="su-row" data-state={pending.error ? 'fail' : 'run'} role="status">
          <span className="su-ico">{pending.error ? <Icon name="close" size={16} /> : <Spinner label={null} pattern="rotate" />}</span>
          <span className="su-text">
            <span>{pending.error ? "Couldn't create the worktree" : <>Creating the worktree from <code>{ws.baseRef}</code></>}</span>
            {pending.error && <span className="su-error">{pending.error}</span>}
          </span>
          {pending.error && <><span className="grow" /><Button size="sm" variant="ghost" busy={busy === 'again'} busyPattern="rotate" busyLabel="Creating" disabled={busy !== null} onClick={() => void again()}>Try again</Button></>}
        </div>
      ) : (
        <>
          <div className="su-row">
            <span className="su-ico"><Icon name="branch" size={16} /></span>
            <span className="su-text"><span>Branched <code>{ws.branch}</code> from <code>{ws.baseRef}</code></span></span>
          </div>
          <div className="su-row">
            <span className="su-ico"><Icon name="folder" size={16} /></span>
            <span className="su-text"><span>{ws.copied ? `Created the worktree and copied ${ws.copied} ${ws.copied === 1 ? 'file' : 'files'}` : 'Created the worktree'}</span></span>
            {!!ws.copied && <button type="button" className="su-out" aria-label="Review files to copy" onClick={() => go({ name: 'settings', page: 'project', projectId: ws.projectId, section: 'environment' })}><Icon name="ext" size={12} /></button>}
          </div>
        </>
      )}
      {run && !pending && (!run.endedAt ? (
        <div className="su-row su-tall" data-state="run" role="status">
          <span className="su-ico"><Spinner label={null} pattern="rotate" /></span>
          <span className="su-text">
            <span className="su-head"><span className="su-ink">Running setup script</span><span className="su-clock">{since}</span></span>
            {tail && <span className="su-tail">{tail}</span>}
          </span>
          <span className="grow" />
          <Button size="sm" variant="ghost" busy={busy === 'stop'} busyPattern="rotate" busyLabel="Stopping" disabled={busy !== null} onClick={() => void stop()}>Stop</Button>
          {logLink}
        </div>
      ) : end && (
        <div className="su-row su-tall" data-state={end.failed ? 'fail' : 'ok'} role="status">
          <span className="su-ico">{end.failed ? <Icon name="close" size={16} /> : <Icon name="term" size={16} />}</span>
          <span className="su-text">
            <span className={end.failed ? 'su-ink' : undefined}>{end.text}</span>
            {end.failed && tail && <span className="su-error">{tail}</span>}
          </span>
          {!end.failed && logLink}
          {end.failed && <span className="grow" />}
          {end.failed && ws.status === 'failed' && <>
            <Button size="sm" variant="ghost" busy={busy === 'again'} busyPattern="rotate" busyLabel="Starting" disabled={busy !== null} onClick={() => void again()}>Run again</Button>
            <Button size="sm" variant="ghost" busy={busy === 'skip'} busyPattern="arrow-right" busyLabel="Sending" disabled={busy !== null} onClick={() => void skip()}>Send anyway</Button>
          </>}
          {end.failed && logLink}
        </div>
      ))}
    </section>
  )
}
