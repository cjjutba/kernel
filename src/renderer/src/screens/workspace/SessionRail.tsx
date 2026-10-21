import { useMemo } from 'react'
import type { Workspace } from '@shared/types'
import { toolView } from '@shared/toolView'
import { actions, useStore } from '../../store'
import { Icon, Spinner } from '../../ui'
import { useProjectSettings } from '../settings/useSettings'
import { copyBranch } from './pr/PrHeader'
import { sessionStages, type Stage } from './sessionStages'
import { fmtClock } from './thread'

/** What the agent is doing now, in its own step's words: the newest step still running in any of the workspace's chats. */
function useDoing(workspaceId: string): string | undefined {
  return useStore((s) => {
    for (const chat of s.chats[workspaceId] ?? []) {
      const items = s.items[chat.id] ?? []
      for (let n = items.length - 1; n >= 0; n--) {
        const i = items[n]
        if (i.kind !== 'tool' || i.status !== 'running') continue
        const v = toolView(i)
        if (v.hidden) return undefined
        // A command with no description of its own says what it ran.
        return !i.input?.description && v.mono && v.object ? `Running ${v.object}` : v.verb
      }
    }
    return undefined
  })
}

const WORD = { done: 'Done', failed: 'Failed', current: 'In progress', pending: 'Not yet' } as const

/** A finished stage is a plain green check and a failed one a plain red x. One still going is a ring in ink, and one to come a faint ring. */
function Mark({ mark }: { mark: Stage['mark'] }) {
  if (mark === 'done') return <span className="stage-ico" role="img" aria-label={WORD.done}><Icon name="check" size={14} /></span>
  if (mark === 'failed') return <span className="stage-ico" role="img" aria-label={WORD.failed}><Icon name="close" size={14} /></span>
  return <span className="stage-ring" role="img" aria-label={WORD[mark]} />
}

function StageRow({ stage, last }: { stage: Stage; last: boolean }) {
  return (
    <li className="stage" data-mark={stage.mark} data-id={stage.id} aria-current={stage.mark === 'current' ? 'step' : undefined}>
      <span className="stage-rail"><Mark mark={stage.mark} />{!last && <span className="stage-conn" aria-hidden="true" />}</span>
      <span className="stage-body">
        <span className="stage-top"><span className="stage-name">{stage.label}</span>{stage.at !== undefined && <span className="stage-at">{fmtClock(stage.at)}</span>}</span>
        {(stage.sub || stage.stat) && (
          <span className="stage-sub" data-needs={stage.needs || undefined}>
            {stage.busy && <Spinner label={null} pattern="snake" />}
            {stage.stat
              ? <>{stage.stat.files} {stage.stat.files === 1 ? 'file' : 'files'}<span className="add">+{stage.stat.added}</span><span className="del">-{stage.stat.removed}</span></>
              : stage.sub}
          </span>
        )}
      </span>
    </li>
  )
}

/**
 * The Session rail (KERNEL-1094): where an agent's session stands, as stages that finish one after another, then the workspace's branch, port and scripts. It takes the right
 * side while the right panel is closed, and the panel's toggle swaps one for the other. A teammate's workspace has one; the Lead's chats have none.
 */
export function SessionRail({ ws }: { ws: Workspace }) {
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => !!s.running[c.id]))
  const waiting = useStore((s) => {
    const pending = s.approvals.filter((a) => a.status === 'pending' && a.workspaceId === ws.id)
    return pending.length ? (pending.some((a) => a.kind === 'question') ? 'answer' : 'approval') : undefined
  })
  const doing = useDoing(ws.id)
  const rs = useProjectSettings(ws.projectId)
  const stages = useMemo(() => sessionStages({ ws, running, waiting, doing, hasSetup: rs ? !!rs.scripts.setup : undefined }), [ws, running, waiting, doing, rs])
  return (
    <aside className="ws-rail" aria-label="Session">
      <section className="rail-card">
        <header className="rail-head"><h2>Session</h2><span className="rail-id">{ws.name}</span></header>
        <ol className="rail-stages">{stages.map((s, i) => <StageRow key={s.id} stage={s} last={i === stages.length - 1} />)}</ol>
        <div className="rail-rows">
          <button type="button" className="rail-row" aria-label={`Copy branch name ${ws.branch}`} data-tip="Copy branch name" onClick={() => void copyBranch(ws.branch)}>
            <Icon name="branch" size={14} /><span className="mono ellipsis">{ws.branch}</span>
          </button>
          <span className="rail-row"><Icon name="computer" size={14} />Runs on port {ws.port}</span>
          <button type="button" className="rail-row" onClick={() => { actions.ui.setWorkspaceView({ bottom: 'run' }); actions.ui.setRightPanel(true) }}>
            <Icon name="term" size={14} /><span className="grow">Scripts</span><Icon name="right" size={12} />
          </button>
        </div>
      </section>
    </aside>
  )
}
