import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Icon, Menu } from '../../../ui'
import { busyLabel, failTitle, headerView, type PrAction } from './model'
import './pr.css'

const run: Record<PrAction, (workspaceId: string) => Promise<unknown>> = {
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
 * The pull request end of the workspace header, one layout per PR state (WorkspacePRMenu, WorkspaceDraftPR, WorkspaceCIFailed,
 * WorkspaceChangesRequested, WorkspaceMerged, WorkspacePRClosed). The agent creates and fixes the PR; Kernel reads state and merges (D-008).
 */
export function PrHeader({ ws }: { ws: Workspace }) {
  const [busy, setBusy] = useState<string | null>(null)
  const menuOpen = useStore((s) => s.ui.menu === 'pr')
  const caret = useRef<HTMLSpanElement>(null)
  const id = ws.id
  const view = headerView(ws.prState)

  const act = async (label: string, title: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: (e as Error).message }) } finally { setBusy(null) }
  }
  const start = (a: PrAction) => void act(busyLabel[a], failTitle[a], () => run[a](id))
  const createDraft = () => void act(busyLabel.create, failTitle.create, () => call('pr.create', { workspaceId: id, draft: true }))

  // Checks, review comments and conflicts for the Checks tab and the review card. Main pushes fresh ones on every refresh.
  useEffect(() => {
    if (!ws.prNumber) return
    let live = true
    call('pr.get', { workspaceId: id }).then((info) => { if (live && info) actions.prs.set(info) }).catch(() => undefined)
    return () => { live = false }
  }, [id, ws.prNumber])

  // Archive goes through the archive confirmation; once the workspace is archived, it lives in History.
  useEffect(() => { if (ws.status === 'archived') go({ name: 'history' }) }, [ws.status])

  // ⌘⇧P creates the PR, as the menu says.
  const canCreate = ws.prState === 'none' && !busy
  useEffect(() => {
    if (!canCreate) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); start('create') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canCreate, id])

  const link = view.link && ws.prNumber && ws.prUrl
    ? <a className="pr-link" data-merged={view.merged || undefined} href={ws.prUrl} target="_blank" rel="noreferrer" aria-label={`Open PR ${ws.prNumber} on GitHub`}>#{ws.prNumber}<Icon name="ext" size={11} stroke={1.8} /></a>
    : null
  const archive = () => actions.ui.openModal({ name: 'confirm', kind: 'archive', workspaceId: id })
  const spinner = (label: string) => <Button className="pr-busy" disabled><span className="spin" aria-hidden="true" />{label}</Button>

  if (busy) return <>{link}{spinner(busy)}</>

  if (view.merged) return (
    <>
      {link}
      <span className="pr-status merged-label">Merged</span>
      <Button className="continue" onClick={() => void act('Continuing', 'Could not continue', () => call('pr.continue', { workspaceId: id }))}><Icon name="forward" size={12} stroke={1.6} />Continue</Button>
      <Button variant="merged" onClick={archive}><Icon name="archive" size={12} stroke={1.5} />Archive</Button>
    </>
  )

  const b = view.button
  const main = !b ? null
    : b.kind === 'busy' ? spinner(b.label)
      : <Button variant={b.kind === 'primary' ? 'primary' : 'secondary'} className={[view.caret && 'split-main', b.kind === 'strong' && 'pr-strong'].filter(Boolean).join(' ') || undefined} onClick={() => b.action && start(b.action)}>{b.label}</Button>

  return (
    <>
      {link}
      {view.status && <span className="pr-status" data-tone={view.status.tone}>{view.status.text}</span>}
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
                { id: 'copy', label: 'Copy branch name', onSelect: () => void copyBranch(ws.branch) }
              ]} />
            )}
          </span>
        </span>
      ) : main}
      {view.archive && <Button onClick={archive}>Archive</Button>}
    </>
  )
}
