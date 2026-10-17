import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Workspace } from '@shared/types'
import { mergeableState } from '@shared/merge'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { leadModeOf } from '@shared/leadMode'
import { call, cleanError } from '../../../api'
import { actions, getState, go, useStore } from '../../../store'
import { Button, LinkButton, Icon, Menu, SplitButton, useBusy } from '../../../ui'
import { NO_RULES, actionIcon, actionKey, blockerFacts, blockersHold, busyLabel, failTitle, hasChanges, headerView, overruleOn, overruleText, type PrAction } from './model'
import { useLocalMerge } from './useLocalMerge'
import { ConfirmMergeAnyway } from '../ConfirmMergeAnyway'
import { ConfirmOverrule } from '../ConfirmOverrule'
import './pr.css'

/** What each action calls on the main process. Shared with `MergeButton`. */
export const request: Record<PrAction,(workspaceId: string) => Promise<unknown>> = {
  create: (workspaceId) => call('pr.create', { workspaceId }),
  resolve: (workspaceId) => call('pr.resolve', { workspaceId }),
  merge: (workspaceId) => call('pr.merge', { workspaceId }),
  ready: (workspaceId) => call('pr.ready', { workspaceId }),
  reopen: (workspaceId) => call('pr.reopen', { workspaceId }),
  update: (workspaceId) => call('pr.update', { workspaceId })
}

/** Also what the workspace header's title does on click. */
export async function copyBranch(branch: string) {
  try {
    await navigator.clipboard.writeText(branch)
    actions.ui.toast({ title: 'Branch copied', sub: branch })
  } catch { actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' }) }
}

/**
 * The pull request actions, one layout per PR state (WorkspacePRMenu, WorkspaceDraftPR, WorkspaceCIFailed, WorkspaceChangesRequested,
 * WorkspaceMerged, WorkspacePRClosed). The agent creates and fixes the PR; Kernel reads state and merges (D-008).
 * They top the right panel, where `spread` keeps the link and status left and the buttons right (D-071), on a band in the
 * state's tone (KERNEL-274). With the panel hidden they move into the chat header, where `capsule` wraps them in a pill that takes
 * the band's own tint and line (KERNEL-413). `toggle` is the panel toggle, which ends the first row of the spread band (KERNEL-799). The PrMergedHidden and Pr* fixtures show every state.
 */
export function PrHeader({ ws, spread, capsule, toggle }: { ws: Workspace; spread?: boolean; capsule?: boolean; toggle?: ReactNode }) {
  // The key is the spinner's label, such as "Merging".
  const [busy, run] = useBusy()
  const menuOpen = useStore((s) => s.ui.menu === 'pr')
  const caret = useRef<HTMLSpanElement>(null)
  const id = ws.id
  const changed = hasChanges(ws)
  // A project with no GitHub merges the branch on the Mac, and its header keeps the band with a `→ main` pill in place of the PR link (KERNEL-478).
  const local = useLocalMerge(ws)
  // Blockers on the latest commit are all that holds the merge: the band reads red and Merge anyway asks first (KERNEL-501).
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const pr = useStore((s) => s.prs[ws.id])
  const agents = useStore((s) => s.agents[ws.projectId])
  const held = blockersHold(ws, pr, rules, (agentId) => agents?.find((a) => a.id === agentId)?.name ?? agentId)
  const [confirm, setConfirm] = useState<NonNullable<typeof held> | null>(null)
  const [overruling, setOverruling] = useState(false)
  const facts = held ? blockerFacts(ws, pr) : undefined
  const overruled = !held && mergeableState(ws.prState) ? overruleOn(ws, pr) : undefined
  // An action started from another button or by a tool spins this band too, and turns its keys off (KERNEL-520).
  const pending = useStore((s) => s.prPending[ws.id])
  const view = headerView(ws.prState, changed, !!ws.prBlocked, local, !!held, pending)
  const override = !!view.button?.override

  const act = (label: string, title: string, fn: () => Promise<unknown>) => run(label, async () => {
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
  })
  const start = (a: PrAction) => void act(busyLabel[a], failTitle[a], () => request[a](id))
  // The main button, or its key: Merge anyway opens its confirm, which merges.
  const press = (a: PrAction) => (override && held ? setConfirm(held) : start(a))
  const createDraft = () => void act(busyLabel.create, failTitle.create, () => call('pr.create', { workspaceId: id, draft: true }))

  // Checks, review comments and conflicts for the Checks tab and the review card. Main pushes fresh ones on every refresh.
  // A local merge has no number, and its read is what says ahead, behind and what is in the way.
  const reads = !!ws.prNumber || !!local
  useEffect(() => {
    if (!reads) return
    let live = true
    call('pr.get', { workspaceId: id }).then((info) => { if (live && info) actions.prs.set(info) }).catch(() => undefined)
    return () => { live = false }
  }, [id, reads, ws.prState])

  // Archive goes through the archive confirmation. Where the app goes once the workspace is archived is decided in one place (archiveLanding.ts).
  const archive = () => actions.ui.openModal({ name: 'confirm', kind: 'archive', workspaceId: id })

  // ⌘⇧ and the action's letter press the main button, and ⌘⇧A presses Archive, only while that button shows (KERNEL-341).
  // A busy button has no action, so it has no key, whether its own press or a pending action spins it, and an open modal turns them all off.
  const action = view.button?.action
  const key = action && actionKey[action]
  const canArchive = view.merged || view.archive
  const listen = !busy && (!!key || canArchive)
  useEffect(() => {
    if (!listen) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey || getState().ui.modal) return
      const k = e.key.toLowerCase()
      if (action && k === key) { e.preventDefault(); press(action) }
      else if (canArchive && k === 'a') { e.preventDefault(); archive() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [listen, action, override, held?.reviewer, held?.count, canArchive, id])

  // Where the PR number was: its link to GitHub, or for a branch that merges here, a plain pill with nothing to open.
  const link = view.link && ws.prNumber && ws.prUrl
    ? <a className="pr-link" href={ws.prUrl} target="_blank" rel="noreferrer" aria-label={`Open PR ${ws.prNumber} on GitHub`}><span className="pr-num">#{ws.prNumber}</span><span className="pr-ext"><Icon name="ext" size={12} /></span></a>
    : view.pill ? <span className="pr-pill" role="img" aria-label={`Merges into ${view.pill}`}><Icon name="arrowRight" size={12} /><span className="mono">{view.pill}</span></span> : null
  // The state always shows, busy or not: only the busy button spins (KERNEL-274).
  const state = <span className="pr-state"><Icon name={view.state.glyph} size={14} /><span className="pr-label">{view.state.label}</span></span>
  const undo = () => void act('Undoing', 'Could not undo the overrule', () => call('reviews.overrule', { workspaceId: id, clear: true }))
  const spinner = (label: string) => <Button busy>{label}</Button>
  const gap = spread ? <span className="grow" /> : null
  // The band's tone: the right panel's head is the band, and in the chat header the capsule has the same tint and line.
  const band = view.state.tone
  // `display: contents` keeps the parent's flex layout and hands the band's tone to everything inside. The capsule is the one
  // wrapper that is a box of its own.
  const tone = (children: ReactNode) => <span className={capsule ? 'pr-tone pr-cap' : 'pr-tone'} data-tone={band}>{children}</span>
  // In the right panel the head is one block in two rows: the state with the link at its right, in line with the chat header, then
  // the actions at full width, in line with the chat's tab row. The capsule keeps one row: the state, the link, then the actions
  // (KERNEL-528). `extra` renders outside the rows, as the Merge anyway confirmation does.
  const line = overruled && (
    <div className="pr-overruled"><span className="pr-overruled-text" data-tip={overruleText(overruled)}>{overruleText(overruled)}</span><LinkButton className="pr-undo" onClick={undo}>Undo</LinkButton></div>
  )
  const out = (buttons: ReactNode, extra?: ReactNode) => spread
    ? tone(<><div className="pr-r1">{state}{gap}{link}{toggle}</div>{buttons && <div className="pr-r2">{buttons}</div>}{line}{extra}</>)
    : tone(<>{state}{link}{buttons}{overruled && <LinkButton className="pr-undo" data-tip={overruleText(overruled)} onClick={undo}>Undo</LinkButton>}{extra}</>)

  if (busy) return out(spinner(busy))

  // A chat with Kernel in Build here stays open after its PR merges: the band says so and its next change starts a new branch from main (KERNEL-780).
  const building = isLeadChatWorkspace(ws) && leadModeOf(ws) === 'build'
  if (view.merged && building) {
    const merged = <span className="pr-state"><Icon name={view.state.glyph} size={14} /><span className="pr-label">PR #{ws.prNumber} merged</span></span>
    const next = <span className="pr-next">The next change starts a new branch from main.</span>
    return spread
      ? tone(<><div className="pr-r1">{merged}{gap}{toggle}</div><div className="pr-r2 pr-r2-text">{next}</div></>)
      : tone(<>{merged}{next}</>)
  }
  if (view.merged) return out(
    <>
      <Button className="continue pr-soft" aria-label="Continue" onClick={() => void act('Continuing', 'Could not continue', () => call('pr.continue', { workspaceId: id }))}><Icon name="forward" size={12} /><span className="pr-btn-label">Continue</span></Button>
      <Button className="pr-solid" data-tip="Archive" data-tip-kbd="⌘⇧A" onClick={archive}><Icon name="archive" size={12} />Archive</Button>
    </>
  )

  // Merge PR takes the green solid; everything else is a soft button in the band's tone, Create PR on the neutral band included, so a
  // lone action is no full-width white bar (KERNEL-528). Each leads with its icon.
  const b = view.button
  const solid = b?.kind === 'primary' && band === 'ready'
  const icon = b && actionIcon(b.label, b.action)
  const split = !!b && b.kind !== 'busy' && view.caret
  const main = !b ? null
    : b.kind === 'busy' ? spinner(b.label)
      : split ? null
        : <Button variant="secondary" className={solid ? 'pr-solid' : 'pr-soft'} data-tip={key && b.label} data-tip-kbd={key && `⌘⇧${key.toUpperCase()}`} onClick={() => b.action && press(b.action)}>{icon && <Icon name={icon} size={12} />}{b.label}</Button>

  const overrule = facts && <Button className="pr-soft" onClick={() => setOverruling(true)}>Overrule</Button>
  const buttons = !main && !split && !view.archive ? null : (
    <>
      {split ? (
        <SplitButton
          size="sm"
          className={['pr-split', solid ? 'pr-solid' : 'pr-soft'].join(' ')}
          icon={icon}
          mainProps={{ 'data-tip': key && b?.label, 'data-tip-kbd': key && `⌘⇧${key.toUpperCase()}` }}
          onClick={() => b?.action && press(b.action)}
          caretLabel="More pull request options"
          expanded={menuOpen}
          onCaret={() => actions.ui.toggleMenu('pr')}
          anchorRef={caret}
          menu={menuOpen && (
            <Menu label="Pull request options" anchorRef={caret} onClose={actions.ui.closeMenu} style={{ right: 0, top: 'calc(100% + 6px)', width: 260 }} items={[
              { id: 'pr', label: 'Create PR', shortcut: '⌘⇧P', onSelect: () => start('create') },
              { id: 'draft', label: 'Create draft PR', onSelect: createDraft },
              { id: 'edit', label: 'Edit PR instructions', onSelect: () => go({ name: 'settings', page: 'project', projectId: ws.projectId, section: 'prs' }) },
              { id: 'copy', label: 'Copy branch name', onSelect: () => void copyBranch(ws.branch) },
              { id: 'discard', label: 'Discard changes', disabled: ws.mode === 'current', onSelect: () => actions.ui.openModal({ name: 'confirm', kind: 'discard', workspaceId: id }) }
            ]} />
          )}
        >
          {b?.label}
        </SplitButton>
      ) : main}
      {overrule}
      {view.archive && <Button className="pr-soft" data-tip="Archive" data-tip-kbd="⌘⇧A" onClick={archive}><Icon name="archive" size={12} />Archive</Button>}
    </>
  )
  return out(buttons, <>
    {confirm && createPortal(<ConfirmMergeAnyway ws={ws} {...confirm} onClose={() => setConfirm(null)} />, document.body)}
    {overruling && facts && createPortal(<ConfirmOverrule ws={ws} facts={facts} onClose={() => setOverruling(false)} />, document.body)}
  </>)
}
