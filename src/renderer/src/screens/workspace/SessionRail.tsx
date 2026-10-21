import { useMemo, useRef, useState } from 'react'
import type { SharedFile, Workspace } from '@shared/types'
import { toolView } from '@shared/toolView'
import { call } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { actions, useStore } from '../../store'
import { EmptyState, Icon, Menu, MENU_SEPARATOR, Spinner, type MenuEntry } from '../../ui'
import { useProjectSettings } from '../settings/useSettings'
import { attempt } from './MessageActions'
import { copyBranch } from './pr/PrHeader'
import { configuredTargets, detectedTarget, detectedUrl, openTarget, type PreviewTarget } from './previewUrls'
import { sessionStages, type Stage } from './sessionStages'
import { sharedHere } from './shared/SharedPanel'
import { kindFile, latestOf, typeWord, useOpenShared, useSharer } from './shared/shared'
import { clock } from './shared/shared'
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

/** One shared file in the rail's list (Pen 9.19, WorkspaceSharedPanel): its icon, its title, then what it is, its version, who shared it and when. */
function SharedRow({ file, open }: { file: SharedFile; open: boolean }) {
  const by = useSharer(file)
  const openShared = useOpenShared()
  const latest = latestOf(file)
  return (
    <button type="button" className="rail-file" aria-current={open || undefined} onClick={() => openShared(file.id)}>
      <span className="shpanel-icon" aria-hidden="true"><FileIcon path={kindFile[file.kind]} /></span>
      <span className="shpanel-text">
        <span className="ellipsis">{file.title}</span>
        <span className="shpanel-meta ellipsis">{typeWord(file.kind)} · Version {latest.n} · {by} · {clock(latest)}</span>
      </span>
      <Icon name="right" size={12} />
    </button>
  )
}

/** The rail's Preview row: the project's URLs and the one a run script printed, the first of them opened in the browser by the row and the rest by its menu (WorkspacePreview, KERNEL-250). */
function PreviewRow({ ws }: { ws: Workspace }) {
  const rs = useProjectSettings(ws.projectId)
  const configured = rs?.preview?.urls ?? []
  const detected = useStore((s) => detectedUrl(s.scriptUrl[ws.id], (rs?.runScripts ?? []).map((r) => r.name)))
  const menuOpen = useStore((s) => s.ui.menu === 'preview')
  const anchor = useRef<HTMLSpanElement>(null)
  const first = openTarget(configured, ws.port, detected)
  if (!first && !configured.length) return null
  const open = (url: string | null) => { if (url) void attempt('Could not open the preview', () => call('system.openExternal', { url })) }
  const entry = (t: PreviewTarget): MenuEntry => ({ id: t.id, label: t.label, shortcut: t.address, disabled: !t.url, onSelect: () => open(t.url) })
  const items: (MenuEntry | typeof MENU_SEPARATOR)[] = [...configuredTargets(configured, ws.port).map(entry), ...(configured.length ? [MENU_SEPARATOR] : []), entry(detectedTarget(detected))]
  return (
    <span ref={anchor} className="rail-anchor">
      <button type="button" className="rail-row" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu('preview')}>
        <Icon name="eye" size={14} /><span className="grow">Preview</span><span className="mono rail-count">{(first ?? '').replace(/^https?:\/\//, '')}</span><Icon name="chevron" size={12} />
      </button>
      {menuOpen && rs && <Menu label="Open preview" heading="Preview URLs" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 36, width: 300 }} items={items} />}
    </span>
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
  // Shared files are listed once sharing is on or a file has been shared, so a project that never shares one sees nothing of it.
  const files = useStore((s) => sharedHere(s, ws))
  const sharing = useStore((s) => !!s.settings?.experimental.sharing) || files.length > 0
  const shown = useStore((s) => s.ui.tabs[ws.id]?.tab)
  const [listed, setListed] = useState(false)
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
          <PreviewRow ws={ws} />
          <button type="button" className="rail-row" onClick={() => { actions.ui.setWorkspaceView({ bottom: 'run' }); actions.ui.setRightPanel(true) }}>
            <Icon name="term" size={14} /><span className="grow">Scripts</span><Icon name="right" size={12} />
          </button>
          {sharing && (
            <button type="button" className="rail-row" aria-expanded={listed} onClick={() => setListed((o) => !o)}>
              <Icon name="image" size={14} /><span className="grow">Shared files</span>{files.length > 0 && <span className="rail-count">{files.length}</span>}<Icon name={listed ? 'chevron' : 'right'} size={12} />
            </button>
          )}
        </div>
      </section>
      {sharing && listed && (
        <section className="rail-card" aria-label="Shared files">
          <header className="rail-head"><h2>Shared files</h2>{files.length > 0 && <span className="rail-count">{files.length}</span>}</header>
          {files.length
            ? <div className="rail-files">{files.map((f) => <SharedRow key={f.id} file={f} open={shown === `shared:${f.id}`} />)}</div>
            : <div className="rail-nothing"><EmptyState icon="send" title="Nothing shared yet">Pages, images and notes the agent shares show up here.</EmptyState></div>}
        </section>
      )}
    </aside>
  )
}
