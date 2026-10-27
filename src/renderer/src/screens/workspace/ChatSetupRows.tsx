import { useEffect, useState } from 'react'
import type { Workspace } from '@shared/types'
import { onSharedFolder } from '@shared/leadWorkspace'
import { actions, go, useStore } from '../../store'
import { Icon, Spinner } from '../../ui'
import { bottomKindOf } from './bottomSplit'
import { clock } from './setupClock'
import { useProjectSettings } from '../settings/useSettings'

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

/** How a finished setup run reads on its row. It is a quiet line: the toast carries the error and its actions (KERNEL-1086). */
function endText(ws: Workspace): string | undefined {
  const run = ws.setupRun
  if (!run?.endedAt) return undefined
  const took = clock(run.endedAt - run.startedAt)
  if (run.end === 0) return `Completed setup script in ${took}`
  if (run.end === null) return `Stopped setup script after ${took}`
  if (run.end === 'timeout') return `Setup script timed out after ${took}`
  return `Setup script failed after ${took}`
}

/** Opens the Setup tab of the bottom drawer. `open` says it already is. */
function useShowLog(ws: Workspace) {
  const kind = useStore((s) => bottomKindOf(s, ws))
  const open = useStore((s) => s.ui.workspace.bottom === 'setup' && !s.ui.bottomCollapsed[kind])
  return { open, show: () => { actions.ui.setWorkspaceView({ bottom: 'setup' }); actions.ui.setBottomCollapsed(kind, false, false) } }
}

/** A chat that still works in the main folder, not in a copy of its own, says so once (a Lead chat from before every chat got a folder of its own). */
export function SharedFolderNote({ ws }: { ws: Workspace }) {
  if (ws.firstInProject === true || !ws.lead || ws.worktreePending || !onSharedFolder(ws)) return null
  return <p className="su-shared"><Icon name="folder" size={14} />This chat works in the main folder. Changes and Run have nothing of their own until you send your next message, which gives it a copy of its own.</p>
}

/**
 * What Kernel did to start a project's first chat, before its first message (KERNEL-951, KERNEL-1053, KERNEL-1093). A right-side bubble says where
 * the chat is, and plain rows follow with no card: the branch, the worktree and its copied files, and the setup script, which is optional.
 * Sending the first message clears the whole block, so the message moves to the top and the agent's turn follows. Every later chat shows nothing.
 * A setup run that doesn't pass is a toast, never a row here, and a worktree git can't make keeps its message in the chat as Not sent.
 */
export function ChatSetupRows({ ws }: { ws: Workspace }) {
  const project = useStore((s) => s.projects.find((p) => p.id === ws.projectId))
  const settings = useProjectSettings(ws.projectId)
  const run = ws.setupRun
  const since = useSince(run && !run.endedAt ? run.startedAt : undefined)
  const log = useShowLog(ws)
  if ((ws.lead && !ws.threadId) || ws.firstInProject !== true || ws.worktreePending) return null
  const shared = onSharedFolder(ws)
  if (!shared && ws.mode !== 'worktree') return null
  const end = endText(ws)
  const hasScript = !!settings?.scripts.setup?.trim()
  const copied = ws.copied ?? 0
  return (
    <section className="su-rows su-chat" aria-label="Chat setup">
      {project && (
        <div className="msg msg-user">
          <p className="bubble su-bubble">{shared ? <>You're working in the main folder of <code>{project.name}</code>, with no branch of your own yet</> : <>You're in a new copy of <code>{project.name}</code> on its own branch</>}</p>
        </div>
      )}
      <div className="su-list">
        {!shared && (
          <>
            <div className="su-row">
              <span className="su-ico"><Icon name="branch" size={16} /></span>
              <span className="su-text">Branched <code>{ws.branch}</code> from <code>{ws.baseRef}</code></span>
            </div>
            <div className="su-row">
              <span className="su-ico"><Icon name="folder" size={16} /></span>
              <span className="su-text">{copied ? `Created the worktree and copied ${copied.toLocaleString('en-US')} ${copied === 1 ? 'file' : 'files'}` : 'Created the worktree'}</span>
              {!!copied && <button type="button" className="su-out" aria-label="Review files to copy" onClick={() => go({ name: 'settings', page: 'project', projectId: ws.projectId, section: 'environment' })}><Icon name="ext" size={12} /></button>}
            </div>
          </>
        )}
        {run && !run.endedAt ? (
          <button type="button" className="su-row su-link" data-state="run" data-on={log.open || undefined} aria-label="Setup script running, open the Setup tab" onClick={log.show}>
            <span className="su-ico"><Spinner label={null} pattern="snake" /></span>
            <span className="su-text">Setup script running</span>
            <span className="su-clock">{since}</span>
            <span className="su-go">Setup tab<Icon name="right" size={12} /></span>
          </button>
        ) : end ? (
          <button type="button" className="su-row su-link" data-on={log.open || undefined} aria-label={`${end}, open the Setup tab`} onClick={log.show}>
            <span className="su-ico"><Icon name="term" size={16} /></span>
            <span className="su-text">{end}</span>
            <Icon name="ext" size={12} />
          </button>
        ) : !hasScript && settings && (
          // No setup script: one quiet line that opens the Setup tab, where the script is added. It is never a warning.
          <button type="button" className="su-row su-link" data-on={log.open || undefined} onClick={log.show}>
            <span className="su-ico"><Icon name="term" size={16} /></span>
            <span className="su-text">Optional: add a setup script</span>
            <Icon name="right" size={12} />
          </button>
        )}
      </div>
    </section>
  )
}
