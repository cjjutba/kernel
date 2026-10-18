import { useEffect, useState } from 'react'
import type { ScriptLine, Workspace } from '@shared/types'
import { stripAnsi } from '@shared/toolView'
import { onSharedFolder } from '@shared/leadWorkspace'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon, Spinner, useBusy } from '../../ui'
import { attempt } from './MessageActions'
import { bottomKindOf } from './bottomSplit'
import { StepRows } from './SetupRows'
import { useProjectSettings } from '../settings/useSettings'

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
 * The one line a project's later chats ever show about their working copy: making it failed and the message is still held
 * (KERNEL-1053). Try again makes the copy again, Send as Hand off sends the message from the shared folder instead.
 */
export function CopyFailedRow({ ws }: { ws: Workspace }) {
  const [busy, track] = useBusy<'retry' | 'handoff'>()
  const error = ws.worktreePending?.error
  if (!error) return null
  const retry = () => track('retry', () => attempt('Could not try again', () => call('lead.retryCopy', { workspaceId: ws.id })))
  const handoff = () => track('handoff', () => attempt('Could not send as Hand off', () => call('lead.sendAsHandoff', { workspaceId: ws.id })))
  return (
    <div className="su-row su-copy-failed" data-state="fail" role="alert">
      <span className="su-ico"><Icon name="close" size={16} /></span>
      <span className="su-text">
        <span>Couldn't make a working copy</span>
        <span className="su-error">{error}</span>
      </span>
      <span className="grow" />
      <Button size="sm" variant="ghost" busy={busy === 'retry'} busyPattern="rotate" busyLabel="Trying again" disabled={busy !== null} onClick={() => void retry()}>Try again</Button>
      <Button size="sm" variant="ghost" busy={busy === 'handoff'} busyPattern="arrow-right" busyLabel="Sending" disabled={busy !== null} onClick={() => void handoff()}>Send as Hand off</Button>
    </div>
  )
}

/**
 * What Kernel did to start a chat's worktree, as plain rows at the top of the chat
 * (KERNEL-951): the branch, the worktree and its copied files, and the setup script, live while it runs with its last output
 * line, then how long it took. A failed setup offers Run again and Send anyway on its row. The log is one click away, never
 * opened for you. Only a project's first chat shows the block (`firstInProject`, KERNEL-1053). Every later chat, and a chat on the current
 * branch or the Lead's shared worktree, shows nothing unless something fails. A first chat on the shared main folder has no worktree rows,
 * just a banner that says so, then the project's problems and the setup script line. `underQueue` is set by WorktreeWait, which draws
 * the copy failure itself, below the held message.
 */
export function ChatSetupRows({ ws, underQueue }: { ws: Workspace; underQueue?: boolean }) {
  const project = useStore((s) => s.projects.find((p) => p.id === ws.projectId))
  const lines = useStore((s) => s.scripts[ws.id]) ?? NO_LINES
  const run = ws.setupRun
  const since = useSince(run && !run.endedAt ? run.startedAt : undefined)
  const showLog = useShowLog(ws)
  const steps = useStore((s) => s.projectSetup[ws.projectId])
  const settings = useProjectSettings(ws.projectId)
  const [busy, track] = useBusy<'again' | 'skip' | 'stop'>()
  if (ws.lead && !ws.threadId) return null
  const pending = ws.worktreePending
  // A failed copy of a chat that started on the shared folder is its own line, whichever chat it is.
  if (pending?.fromShared) return pending.error && !underQueue ? <CopyFailedRow ws={ws} /> : null
  const shared = onSharedFolder(ws)
  if (!shared && ws.mode !== 'worktree') return null
  const end = endText(ws)
  // Only the project's first chat shows the whole block. A chat without the stamp counts as not first.
  // A later chat shows just a failure, which it needs for Try again, Run again and Send anyway.
  const later = ws.firstInProject !== true
  if (later && !pending?.error && !end?.failed) return null
  const tail = run ? lastLine(lines) : undefined
  // Failed with the chat held, Run again and Send anyway. Failed or stopped with nothing held, the chat works on, so only Rerun setup (KERNEL-1012).
  const held = ws.status === 'failed'
  const rerun = !held && !!end && (end.failed || run?.end === null)
  const again = () => track('again', () => attempt(pending ? 'Could not create the worktree' : 'Could not run setup', () => (pending ? call('workspaces.retryWorktree', { workspaceId: ws.id }) : call('scripts.run', { workspaceId: ws.id, kind: 'setup' }))))
  const skip = () => track('skip', () => attempt('Could not send', () => call('scripts.skipSetup', { workspaceId: ws.id })))
  const stop = () => track('stop', () => attempt('Could not stop setup', () => call('scripts.stop', { workspaceId: ws.id, kind: 'setup' })))
  const logLink = <button type="button" className="su-out" aria-label="Open the setup log" onClick={showLog}><Icon name="ext" size={12} /></button>

  return (
    <section className="su-rows su-chat" aria-label="Chat setup">
      {project && !later && <p className="su-banner">{shared ? <>You're working in the main folder of <code>{project.name}</code>, with no branch of your own yet</> : <>You're in a new copy of <code>{project.name}</code> on its own branch</>}</p>}
      {pending ? (
        <div className="su-row" data-state={pending.error ? 'fail' : 'run'} role="status">
          <span className="su-ico">{pending.error ? <Icon name="close" size={16} /> : <Spinner label={null} pattern="rotate" />}</span>
          <span className="su-text">
            <span>{pending.error ? "Couldn't create the worktree" : <>Creating the worktree from <code>{ws.baseRef}</code></>}</span>
            {pending.error && <span className="su-error">{pending.error}</span>}
          </span>
          {pending.error && <><span className="grow" /><Button size="sm" variant="ghost" busy={busy === 'again'} busyPattern="rotate" busyLabel="Creating" disabled={busy !== null} onClick={() => void again()}>Try again</Button></>}
        </div>
      ) : !later && !shared && (
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
      {/* The project's own steps (hooks, push access, agents, files to copy) speak up only when one warns or fails, with their actions. */}
      {project && steps && !later && !pending && <StepRows project={project} steps={steps} problems />}
      {/* No setup script: one quiet line that opens the Setup tab, where the script is added. It is never a warning. */}
      {!run && !pending && !later && settings && !settings.scripts.setup?.trim() && (
        <button type="button" className="su-row su-link" onClick={showLog}>
          <span className="su-ico"><Icon name="term" size={16} /></span>
          <span className="su-text"><span className="su-link-text">Optional: add a setup script</span></span>
          <Icon name="ext" size={12} />
        </button>
      )}
      {run && !pending && (!run.endedAt ? !later && (
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
          {!end.failed && !rerun && logLink}
          {(end.failed || rerun) && <span className="grow" />}
          {end.failed && held && <>
            <Button size="sm" variant="ghost" busy={busy === 'again'} busyPattern="rotate" busyLabel="Starting" disabled={busy !== null} onClick={() => void again()}>Run again</Button>
            <Button size="sm" variant="ghost" busy={busy === 'skip'} busyPattern="arrow-right" busyLabel="Sending" disabled={busy !== null} onClick={() => void skip()}>Send anyway</Button>
          </>}
          {rerun && <Button size="sm" variant="ghost" busy={busy === 'again'} busyPattern="rotate" busyLabel="Starting" disabled={busy !== null} onClick={() => void again()}>Rerun setup</Button>}
          {(end.failed || rerun) && logLink}
        </div>
      ))}
    </section>
  )
}
