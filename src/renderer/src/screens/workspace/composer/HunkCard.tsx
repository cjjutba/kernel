import { useEffect, useMemo, useState } from 'react'
import type { Hunk, Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { diffTab } from '../ChatTabs'
import { attempt } from '../MessageActions'

/**
 * Shown when a file holds changes from before the workspace started as well as the agent's (WorkspaceHunks.png).
 * The agent's hunks are ticked, the earlier ones are not and stay uncommitted unless picked.
 */
export function HunkCard({ ws, agentName, refreshKey }: { ws: Workspace; agentName: string; refreshKey: unknown }) {
  const [hunks, setHunks] = useState<Hunk[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, run] = useBusy()

  useEffect(() => {
    let live = true
    call('workspaces.hunks', { workspaceId: ws.id }).then((all) => {
      if (!live) return
      setHunks(all)
      setPicked(new Set(all.filter((h) => h.owner === 'agent').map((h) => h.id)))
    }).catch(() => { if (live) setHunks([]) })
    return () => { live = false }
  }, [ws.id, refreshKey])

  // The first file that has both kinds of change.
  const file = useMemo(() => {
    const mine = new Set(hunks.filter((h) => h.owner === 'mine').map((h) => h.path))
    return hunks.find((h) => h.owner === 'agent' && mine.has(h.path))?.path
  }, [hunks])
  if (!file) return null

  const rows = hunks.filter((h) => h.path === file).sort((a, b) => (a.owner === b.owner ? 0 : a.owner === 'agent' ? -1 : 1))
  const name = file.slice(file.lastIndexOf('/') + 1)
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const ids = rows.filter((h) => picked.has(h.id)).map((h) => h.id)
  const commit = () => run('commit', () => attempt('Could not commit', async () => {
    await call('workspaces.commit', { workspaceId: ws.id, hunkIds: ids })
    actions.ui.toast({ title: 'Committed', sub: `${ids.length} ${ids.length === 1 ? 'change' : 'changes'} from ${name}` })
    setHunks((all) => all.filter((h) => !ids.includes(h.id)))
  }))

  return (
    <section className="hunk-card" aria-label={`Changes in ${name}`}>
      <p style={{ margin: 0, fontWeight: 500 }}>{name} has your changes and {agentName}’s</p>
      <p className="ink2" style={{ margin: 0 }}>You edited this file before the workspace started. Pick what goes in the commit.</p>
      <div className="col" style={{ gap: 6 }}>
        {rows.map((h) => (
          <label key={h.id} className="hunk-row">
            <input type="checkbox" checked={picked.has(h.id)} onChange={() => toggle(h.id)} />
            <span className="col" style={{ gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{h.owner === 'agent' ? `${agentName}’s change` : 'Your change from before'}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>lines {h.lines} · +{h.added} -{h.removed}{h.owner === 'mine' ? ' · stays uncommitted' : ''}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Button onClick={() => actions.ui.setWorkspaceView({ tab: diffTab(file) })}>Open diff</Button>
        <Button variant="primary" busy={!!busy} busyLabel="Committing" disabled={!ids.length} onClick={() => void commit()}>Commit selected</Button>
      </div>
    </section>
  )
}
