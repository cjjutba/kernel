import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { SharedFile, Workspace } from '@shared/types'
import { toolView } from '@shared/toolView'
import { call } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { actions, go, useStore } from '../../store'
import { Button, EmptyState, Icon, Menu, MENU_SEPARATOR, Spinner, SplitButton, type MenuEntry } from '../../ui'
import { useProjectSettings } from '../settings/useSettings'
import { attempt } from './MessageActions'
import { busyLabel, type PrAction } from './pr/model'
import type { PrButton, PrButtonId } from './pr/prStage'
import { copyBranch, usePrActions, usePrFacts } from './pr/usePr'
import { configuredTargets, detectedTarget, detectedUrl, openTarget, type PreviewTarget } from './previewUrls'
import { sessionView, type Stage } from './sessionStages'
import { sharedHere } from './shared/SharedPanel'
import { kindFile, latestOf, typeWord, useOpenShared, useSharer } from './shared/shared'
import { clock } from './shared/shared'
import { fmtClock } from './thread'

/** What the agent is doing now, in its own step's words: the newest step still running in any of the workspace's chats. */
export function useDoing(workspaceId: string): string | undefined {
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

const WORD = { done: 'Done', failed: 'Failed', current: 'In progress', pending: 'Not yet', busy: 'Working', wait: 'Waiting', closed: 'Closed', merged: 'Merged' } as const

/** A finished stage is a plain green check and a failed one a plain red x. One still going is a ring in ink, and one to come a faint ring. A pull request that runs draws the checker loader, one that waits on someone else an hourglass, and a merged one the merge glyph in purple. */
function Mark({ mark }: { mark: Stage['mark'] }) {
  if (mark === 'done') return <span className="stage-ico" role="img" aria-label={WORD.done}><Icon name="check" size={14} /></span>
  if (mark === 'failed') return <span className="stage-ico" role="img" aria-label={WORD.failed}><Icon name="close" size={14} /></span>
  if (mark === 'busy') return <span className="stage-ico" role="img" aria-label={WORD.busy}><Spinner label={null} pattern="checker" /></span>
  if (mark === 'wait') return <span className="stage-ico" role="img" aria-label={WORD.wait}><Icon name="hourglass" size={14} /></span>
  if (mark === 'closed') return <span className="stage-ico" role="img" aria-label={WORD.closed}><Icon name="prClosed" size={14} /></span>
  if (mark === 'merged') return <span className="stage-ico" role="img" aria-label={WORD.merged}><Icon name="merged" size={14} /></span>
  return <span className="stage-ring" role="img" aria-label={WORD[mark]} />
}

/** The action each button starts, so the one that was pressed spins and the rest wait. */
const STARTS: Partial<Record<PrButtonId, PrAction>> = { create: 'create', ready: 'ready', fix: 'resolve', review: 'resolve', resolve: 'resolve', merge: 'merge', update: 'update', reopen: 'reopen' }
const TONE = { ink: 'primary', merge: 'merge', outline: 'secondary' } as const

/**
 * The buttons of a pull request stage, one or two, under its line (Pen 10.9). Create PR is a split button whose menu holds the draft, the instructions, the branch's name and
 * Discard changes (Pen 10.13), and Open PR a button whose menu opens it on GitHub, copies its link or updates the branch. The button that was pressed spins in its word and the
 * rest are off until the call returns, and so is every button while main runs an action on the pull request (KERNEL-520).
 */
function StageButtons({ ws, buttons, run }: { ws: Workspace; buttons: PrButton[]; run: ReturnType<typeof usePrActions> }) {
  const menuOpen = useStore((s) => s.ui.menu === 'pr')
  const anchor = useRef<HTMLSpanElement>(null)
  const pressed = run.busy
  const word = (b: PrButton) => b.busy ?? (pressed && STARTS[b.id] && busyLabel[STARTS[b.id] as PrAction] === pressed ? b.label : undefined)
  const toggle = () => actions.ui.toggleMenu('pr')
  const createMenu: (MenuEntry | typeof MENU_SEPARATOR)[] = [
    { id: 'draft', label: 'Create draft PR', icon: 'prDraft', onSelect: run.createDraft },
    { id: 'edit', label: 'Edit PR instructions', icon: 'pen', onSelect: () => go({ name: 'settings', page: 'project', projectId: ws.projectId, section: 'prs' }) },
    { id: 'copy', label: 'Copy branch name', icon: 'copy', onSelect: () => void copyBranch(ws.branch) },
    MENU_SEPARATOR,
    { id: 'discard', label: 'Discard changes', icon: 'trash', danger: true, disabled: ws.mode === 'current', onSelect: () => actions.ui.openModal({ name: 'confirm', kind: 'discard', workspaceId: ws.id }) }
  ]
  const openMenu: (MenuEntry | typeof MENU_SEPARATOR)[] = [
    { id: 'github', label: 'Open on GitHub', icon: 'ext', onSelect: run.openOnGitHub },
    { id: 'link', label: 'Copy link', icon: 'link', onSelect: run.copyLink },
    { id: 'update', label: 'Update branch', icon: 'refresh', onSelect: () => run.press('update') }
  ]
  return (
    <span className="stage-actions">
      {buttons.map((b) => {
        const busy = word(b)
        const off = !!pressed && !busy
        if (b.menu === 'create') {
          return (
            <SplitButton
              key={b.id} size="md" className="stage-split" icon={b.icon} busy={!!busy} busyLabel={busy} disabled={off}
              onClick={() => run.press(b.id)} caretLabel="More pull request options" expanded={menuOpen} onCaret={toggle} anchorRef={anchor}
              menu={menuOpen && <Menu label="Pull request options" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 'calc(100% + 6px)', width: 240 }} items={createMenu} />}
            >
              {b.label}
            </SplitButton>
          )
        }
        if (b.menu === 'open') {
          return (
            <span key={b.id} ref={anchor} className="stage-anchor">
              <Button variant="secondary" icon={menuOpen ? 'chevron' : b.icon} aria-haspopup="menu" aria-expanded={menuOpen} disabled={off} onClick={toggle}>{b.label}</Button>
              {menuOpen && <Menu label="Pull request" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 240 }} items={openMenu} />}
            </span>
          )
        }
        return (
          <Button
            key={b.id} variant={TONE[b.tone]} icon={b.icon && b.tone !== 'merge' ? b.icon : undefined} busy={!!busy} busyLabel={busy} disabled={off || !!b.disabled}
            data-tip={b.tip ?? b.disabled} onClick={() => run.press(b.id)}
          >
            {b.label}
          </Button>
        )
      })}
    </span>
  )
}

export function StageRow({ stage, last, ws, run }: { stage: Stage; last: boolean; ws: Workspace; run: ReturnType<typeof usePrActions> }) {
  return (
    <li className="stage" data-mark={stage.mark} data-id={stage.id} aria-current={stage.mark === 'current' ? 'step' : undefined}>
      <span className="stage-rail"><Mark mark={stage.mark} />{!last && <span className="stage-conn" aria-hidden="true" />}</span>
      <span className="stage-body">
        <span className="stage-top">
          <span className="stage-name">{stage.label}</span>
          {stage.pill && <span className="stage-pill mono"><Icon name="arrowRight" size={12} />{stage.pill}</span>}
          {stage.at !== undefined && <span className="stage-at">{fmtClock(stage.at)}</span>}
        </span>
        {(stage.sub || stage.stat) && (
          <span className="stage-sub" data-needs={stage.needs || undefined}>
            {stage.busy && <Spinner label={null} pattern="snake" />}
            {stage.loader && <Spinner label={null} pattern={stage.loader} />}
            {stage.stat
              ? <>{stage.stat.files} {stage.stat.files === 1 ? 'file' : 'files'}<span className="add">+{stage.stat.added}</span><span className="del">-{stage.stat.removed}</span></>
              : stage.sub}
          </span>
        )}
        {stage.buttons && stage.buttons.length > 0 && <StageButtons ws={ws} buttons={stage.buttons} run={run} />}
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

/** The rail's rows under its stages: the branch to copy, the port, the preview and the scripts. `children` follow them. */
export function WorkspaceRows({ ws, children }: { ws: Workspace; children?: ReactNode }) {
  return (
    <>
      <button type="button" className="rail-row" aria-label={`Copy branch name ${ws.branch}`} data-tip="Copy branch name" onClick={() => void copyBranch(ws.branch)}>
        <Icon name="branch" size={14} /><span className="mono ellipsis">{ws.branch}</span>
      </button>
      <span className="rail-row"><Icon name="computer" size={14} />Runs on port {ws.port}</span>
      <PreviewRow ws={ws} />
      <button type="button" className="rail-row" onClick={() => { actions.ui.setWorkspaceView({ bottom: 'run' }); actions.ui.setRightPanel(true) }}>
        <Icon name="term" size={14} /><span className="grow">Scripts</span><Icon name="right" size={12} />
      </button>
      {children}
    </>
  )
}

/**
 * The Session rail (KERNEL-1094): where an agent's session stands, as stages that finish one after another, then the workspace's branch, port and scripts. It takes the right
 * side while the right panel is closed, and the panel's toggle swaps one for the other. A teammate's workspace has one, and a chat with Kernel has its own (LeadRail).
 */
export function SessionRail({ ws }: { ws: Workspace }) {
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => !!s.running[c.id]))
  const waiting = useStore((s) => {
    const pending = s.approvals.filter((a) => a.status === 'pending' && a.workspaceId === ws.id)
    return pending.length ? (pending.some((a) => a.kind === 'question') ? 'answer' : 'approval') : undefined
  })
  const doing = useDoing(ws.id)
  const rs = useProjectSettings(ws.projectId)
  const facts = usePrFacts(ws)
  const { stages } = useMemo(() => sessionView({ ws, running, waiting, doing, hasSetup: rs ? !!rs.scripts.setup : undefined, pr: facts }), [ws, running, waiting, doing, rs, facts])
  // The main button's key and Archive's, while they show: ⌘⇧ and the letter of Create PR, Merge or Fix checks, and ⌘⇧A (KERNEL-341).
  const main = stages.flatMap((s) => s.buttons ?? []).find((b) => b.tone !== 'outline' && !b.busy)
  const run = usePrActions(ws, { key: main?.id, archivable: ws.prState === 'merged' || ws.prState === 'closed' })
  // Shared files are listed once sharing is on or a file has been shared, so a project that never shares one sees nothing of it.
  const files = useStore((s) => sharedHere(s, ws))
  const sharing = useStore((s) => !!s.settings?.experimental.sharing) || files.length > 0
  const shown = useStore((s) => s.ui.tabs[ws.id]?.tab)
  const [listed, setListed] = useState(false)
  return (
    <aside className="ws-rail" aria-label="Session">
      <section className="rail-card">
        <header className="rail-head"><h2>Session</h2><span className="rail-id">{ws.name}</span></header>
        <ol className="rail-stages">{stages.map((s, i) => <StageRow key={s.id} stage={s} last={i === stages.length - 1} ws={ws} run={run} />)}</ol>
        <div className="rail-rows">
          <WorkspaceRows ws={ws}>
            {sharing && (
              <button type="button" className="rail-row" aria-expanded={listed} onClick={() => setListed((o) => !o)}>
                <Icon name="image" size={14} /><span className="grow">Shared files</span>{files.length > 0 && <span className="rail-count">{files.length}</span>}<Icon name={listed ? 'chevron' : 'right'} size={12} />
              </button>
            )}
          </WorkspaceRows>
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
