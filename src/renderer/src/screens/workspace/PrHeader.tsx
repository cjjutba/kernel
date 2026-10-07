import { useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go } from '../../store'
import { Button, Icon, Menu } from '../../ui'
import { attempt } from './MessageActions'

/**
 * The pull request area of the header. KERNEL-15 replaces this file with every state in the canvas
 * (WorkspacePRMenu, DraftPR, CIFailed, ChangesRequested, Merged, Closed). This one drives the existing pr.* channels.
 */
export function PrHeader({ ws }: { ws: Workspace }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const caret = useRef<HTMLSpanElement>(null)
  const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await attempt(`${label} failed`, fn) } finally { setBusy(null) } }
  const merged = ws.prState === 'merged'
  const link = ws.prNumber && ws.prUrl
    ? <a className="pr-link" data-merged={merged || undefined} href={ws.prUrl} target="_blank" rel="noreferrer" aria-label={`Open PR ${ws.prNumber} on GitHub`}>#{ws.prNumber}<Icon name="ext" size={11} stroke={1.8} /></a>
    : null
  const spin = (label: string) => <Button disabled><span className="spin" />{label}</Button>
  const id = ws.id
  if (busy) return <>{link}{spin(busy)}</>
  switch (ws.prState) {
    case 'none': return (
      <span className="row" style={{ gap: 0 }}>
        <Button variant="primary" className="split-main" onClick={() => void act('Creating PR', () => call('pr.create', { workspaceId: id }))}>Create PR</Button>
        <span ref={caret} style={{ position: 'relative' }}>
          <Button variant="primary" className="split-caret" aria-label="More pull request options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><span className="caret-down"><Icon name="right" size={12} stroke={1.8} /></span></Button>
          {menu && (
            <Menu label="Pull request options" anchorRef={caret} onClose={() => setMenu(false)} style={{ right: 0, top: 'calc(100% + 6px)', width: 260 }} items={[
              { id: 'pr', label: 'Create PR', shortcut: '⌘⇧P', onSelect: () => void act('Creating PR', () => call('pr.create', { workspaceId: id })) },
              { id: 'draft', label: 'Create draft PR', onSelect: () => void act('Creating PR', () => call('pr.create', { workspaceId: id, draft: true })) }
            ]} />
          )}
        </span>
      </span>
    )
    case 'creating': case 'resolving': case 'merging': return <>{link}{spin(ws.prState === 'creating' ? 'Creating PR' : ws.prState === 'merging' ? 'Merging' : 'Resolving')}</>
    case 'checks': return <>{link}{spin('Checks running')}</>
    case 'draft': return <>{link}<span className="muted">Draft</span><Button onClick={() => void act('Marking ready', () => call('pr.ready', { workspaceId: id }))}>Ready for review</Button></>
    case 'cifail': return <>{link}<span className="del">Checks failed</span><Button variant="primary" onClick={() => void act('Sending', () => call('pr.resolve', { workspaceId: id }))}>Fix checks</Button></>
    case 'changes': return <>{link}<span className="ink2">Changes requested</span><Button variant="primary" onClick={() => void act('Sending', () => call('pr.resolve', { workspaceId: id }))}>Address review</Button></>
    case 'conflict': return <>{link}<Button onClick={() => void act('Resolving', () => call('pr.resolve', { workspaceId: id }))}>Resolve conflicts</Button></>
    case 'ready': case 'open': return <>{link}<Button variant="primary" onClick={() => void act('Merging', () => call('pr.merge', { workspaceId: id }))}>Merge PR</Button></>
    case 'merged': return (
      <>{link}<span className="merged-label">Merged</span>
        <Button className="continue" onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: ws.roomId })}>Continue</Button>
        <Button variant="merged" onClick={() => void act('Archiving', async () => { await call('workspaces.archive', { workspaceId: id }); go({ name: 'floor', roomId: ws.roomId }) })}>Archive</Button></>
    )
    case 'closed': return <>{link}<span className="muted">Closed</span><Button onClick={() => void act('Reopening', () => call('pr.reopen', { workspaceId: id }))}>Reopen</Button></>
  }
}
