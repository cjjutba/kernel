import { useEffect, useRef, useState } from 'react'
import type { Checkpoint } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { IconButton, useBusy } from '../../../ui'
import { attempt } from '../MessageActions'
import './checkpoints.css'

const EMPTY: Checkpoint[] = []
const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ts: number) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

/** "4 files · +412 -38", "no file changes", or "start of chat" under each turn. */
export function checkpointDetail(c: Checkpoint): string {
  if (c.start) return 'start of chat'
  if (!c.stat.files) return 'no file changes'
  return `${c.stat.files} ${c.stat.files === 1 ? 'file' : 'files'} · +${c.stat.added} -${c.stat.removed}`
}

/**
 * The Checkpoints drawer (WorkspaceCheckpoints.png): every turn of the workspace, newest first. Revert asks inline,
 * then the engine saves the current state on a backup branch and restores the files. The chat is not touched.
 */
export function CheckpointsDrawer({ workspaceId }: { workspaceId: string }) {
  const list = useStore((s) => s.checkpoints[workspaceId] ?? EMPTY)
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const ref = useRef<HTMLDivElement>(null)
  const close = () => actions.ui.setWorkspaceView({ checkpoints: false })

  useEffect(() => {
    void call('checkpoints.list', { workspaceId }).then((l) => actions.workspaces.setCheckpoints(workspaceId, l)).catch(() => undefined)
  }, [workspaceId])
  useEffect(() => { ref.current?.focus() }, [])

  const sorted = [...list].sort((a, b) => b.ts - a.ts || Number(b.id) - Number(a.id))
  const revert = (c: Checkpoint) => run('revert', () => attempt('Could not revert', async () => {
    await call('checkpoints.revert', { workspaceId, checkpointId: c.id })
    setAsking(null)
    close()
  }))

  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-label="Checkpoints" className="ck-drawer" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (asking) setAsking(null); else close() } }}>
      <div className="ck-head">
        <span className="grow">Checkpoints</span>
        <IconButton icon="close" size={14} label="Close checkpoints" onClick={close} />
      </div>
      <p className="ck-intro">Every turn saves the worktree. Reverting restores files, your chat stays.</p>
      <ul className="ck-list">
        {sorted.length === 0 && <li className="ck-empty">No checkpoints yet. One is saved when the agent finishes a turn.</li>}
        {sorted.map((c) => {
          const time = clock(c.ts)
          const confirming = asking === c.id
          return (
            <li key={c.id} className="ck-row" data-asking={confirming || undefined}>
              <div className="ck-line">
                <span className="ck-time">{time}</span>
                <span className="ck-title" title={c.title}>{c.title}</span>
                {c.current
                  ? <span className="ck-now">Now</span>
                  : <button type="button" className="ck-revert" aria-expanded={confirming} aria-label={`Revert to ${time}, ${c.title}`} onClick={() => setAsking(confirming ? null : c.id)}>Revert</button>}
              </div>
              <span className="ck-detail">{checkpointDetail(c)}</span>
              {confirming && (
                <div className="ck-confirm" role="group" aria-label={`Revert to ${time}`}>
                  <span>Restore files to {time}? Changes after this turn move to a backup branch.</span>
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="ck-cancel" onClick={() => setAsking(null)}>Cancel</button>
                    <button type="button" className="ck-go" disabled={!!busy} aria-busy={!!busy || undefined} onClick={() => void revert(c)}>{busy && <span className="spin" aria-hidden="true" />}{busy ? 'Reverting' : 'Revert'}</button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
