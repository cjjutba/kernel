import { useEffect, useRef, type ReactNode } from 'react'
import type { Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Icon, Menu, useBusy } from '../../../ui'
import { afterArchive, busyLabel, failTitle, hasChanges, headerView, type PrAction } from './model'
import { openRoom } from '../../../lead'
import { archivedByHand } from '../byHand'
import './pr.css'

const request: Record<PrAction, (workspaceId: string) => Promise<unknown>> = {
  create: (workspaceId) => call('pr.create', { workspaceId }),
  resolve: (workspaceId) => call('pr.resolve', { workspaceId }),
  merge: (workspaceId) => call('pr.merge', { workspaceId }),
  ready: (workspaceId) => call('pr.ready', { workspaceId }),
  reopen: (workspaceId) => call('pr.reopen', { workspaceId })
}

async function copyBranch(branch: string) {
  try { await navigator.clipboard.writeText(branch); actions.ui.toast({ title: 'Copied', sub: branch }) } catch { actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' }) }
}

/** The caret on Create PR (10px, as on the canvas). */
const Caret = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4 5 6.5 7.5 4" /></svg>

/**
 * The pull request actions, one layout per PR state (WorkspacePRMenu, WorkspaceDraftPR, WorkspaceCIFailed, WorkspaceChangesRequested,
 * WorkspaceMerged, WorkspacePRClosed). The agent creates and fixes the PR; Kernel reads state and merges (D-008).
 * They top the right panel, where `spread` keeps the link and status left and the buttons right (D-071), on a band in the
 * state's tone (KERNEL-274). design/redesign/Pr*.png draws every state.
 */
export function PrHeader({ ws, spread }: { ws: Workspace; spread?: boolean }) {
  // The key is the spinner's label, such as "Merging".
  const [busy, run] = useBusy()
  const menuOpen = useStore((s) => s.ui.menu === 'pr')
  const caret = useRef<HTMLSpanElement>(null)
  const id = ws.id
  const changed = hasChanges(ws)
  const view = headerView(ws.prState, changed)

  const act = (label: string, title: string, fn: () => Promise<unknown>) => run(label, async () => {
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: (e as Error).message }) }
  })
  const start = (a: PrAction) => void act(busyLabel[a], failTitle[a], () => request[a](id))
  const createDraft = () => void act(busyLabel.create, failTitle.create, () => call('pr.create', { workspaceId: id, draft: true }))

  // Checks, review comments and conflicts for the Checks tab and the review card. Main pushes fresh ones on every refresh.
  useEffect(() => {
    if (!ws.prNumber) return
    let live = true
    call('pr.get', { workspaceId: id }).then((info) => { if (live && info) actions.prs.set(info) }).catch(() => undefined)
    return () => { live = false }
  }, [id, ws.prNumber])

  // Archive goes through the archive confirmation; once the workspace is archived, it lives in History. A review Kernel
  // archived on its own while on screen, after its work merged, opens the Lead's chat instead, with a toast (KERNEL-132).
  const reviewed = useStore((s) => (ws.reviewOf ? s.workspaces.find((w) => w.id === ws.reviewOf) : undefined))
  const reviewer = useStore((s) => s.agents[ws.roomId]?.find((a) => a.id === ws.agentId)?.name)
  const last = useRef({ id, status: ws.status })
  useEffect(() => {
    const before = last.current
    last.current = { id, status: ws.status }
    if (ws.status !== 'archived') return
    const next = afterArchive(ws, reviewed, reviewer, { seen: before.id === id && before.status !== 'archived', byHand: archivedByHand(id) })
    if (next.to === 'history') { go({ name: 'history' }); return }
    actions.ui.toast(next.toast)
    void openRoom(ws.roomId)
  }, [id, ws.status])

  // ⌘⇧P creates the PR, as the menu says.
  const canCreate = ws.prState === 'none' && changed && !busy
  useEffect(() => {
    if (!canCreate) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); start('create') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canCreate, id])

  const link = view.link && ws.prNumber && ws.prUrl
    ? <a className="pr-link" href={ws.prUrl} target="_blank" rel="noreferrer" aria-label={`Open PR ${ws.prNumber} on GitHub`}><span className="pr-num">#{ws.prNumber}</span><span className="pr-ext"><Icon name="ext" size={11} stroke={1.8} /></span></a>
    : null
  // The state always shows, busy or not: only the busy button spins (KERNEL-274).
  const state = <span className="pr-state"><Icon name={view.state.glyph} size={14} /><span className="pr-label">{view.state.label}</span></span>
  const archive = () => actions.ui.openModal({ name: 'confirm', kind: 'archive', workspaceId: id })
  const spinner = (label: string) => <Button busy>{label}</Button>
  const gap = spread ? <span className="grow" /> : null
  // The band's tone, in the right panel. In the chat header (panel hidden) there's no band, so the header stays neutral,
  // except merged, which was already purple there.
  const band = spread || view.state.tone === 'merged' ? view.state.tone : 'idle'
  // `display: contents` keeps the parent's flex layout and hands the band's tone to everything inside.
  const tone = (children: ReactNode) => <span className="pr-tone" data-tone={band}>{children}</span>

  if (busy) return tone(<>{link}{state}{gap}{spinner(busy)}</>)

  if (view.merged) return tone(
    <>
      {link}
      {state}
      {gap}
      <Button className="continue pr-soft" aria-label="Continue" onClick={() => void act('Continuing', 'Could not continue', () => call('pr.continue', { workspaceId: id }))}><Icon name="forward" size={12} stroke={1.6} /><span className="pr-btn-label">Continue</span></Button>
      <Button className="pr-solid" onClick={archive}><Icon name="archive" size={12} stroke={1.5} />Archive</Button>
    </>
  )

  // Create PR stays ink on the neutral band; Merge PR takes the green solid; everything else is a soft button in the band's tone.
  const b = view.button
  const solid = b?.kind === 'primary' && band === 'ready'
  const ink = b?.kind === 'primary' && band === 'idle'
  const main = !b ? null
    : b.kind === 'busy' ? spinner(b.label)
      : <Button variant={ink ? 'primary' : 'secondary'} className={[view.caret && 'split-main', solid ? 'pr-solid' : !ink && 'pr-soft'].filter(Boolean).join(' ') || undefined} onClick={() => b.action && start(b.action)}>{b.label}</Button>

  return tone(
    <>
      {link}
      {state}
      {gap}
      {view.caret ? (
        <span className="pr-split">
          {main}
          <span ref={caret} className="pr-caret-anchor">
            <button type="button" className="split-caret" aria-label="More pull request options" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.ui.toggleMenu('pr')}><Caret /></button>
            {menuOpen && (
              <Menu label="Pull request options" anchorRef={caret} onClose={actions.ui.closeMenu} style={{ right: 0, top: 'calc(100% + 6px)', width: 260 }} items={[
                { id: 'pr', label: 'Create PR', shortcut: '⌘⇧P', onSelect: () => start('create') },
                { id: 'draft', label: 'Create draft PR', onSelect: createDraft },
                { id: 'edit', label: 'Edit PR instructions', onSelect: () => go({ name: 'settings', page: 'prs' }) },
                { id: 'copy', label: 'Copy branch name', onSelect: () => void copyBranch(ws.branch) },
                { id: 'discard', label: 'Discard changes', disabled: ws.mode === 'current', onSelect: () => actions.ui.openModal({ name: 'confirm', kind: 'discard', workspaceId: id }) }
              ]} />
            )}
          </span>
        </span>
      ) : main}
      {view.archive && <Button className="pr-soft" onClick={archive}><Icon name="archive" size={12} stroke={1.5} />Archive</Button>}
    </>
  )
}
