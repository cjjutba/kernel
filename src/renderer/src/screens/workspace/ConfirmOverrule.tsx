import { useId, useState } from 'react'
import type { Workspace } from '@shared/types'
import { reviewsText } from '@shared/merge'
import { call, cleanError } from '../../api'
import { actions } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import type { BlockerFacts } from './pr/model'
import './confirm.css'

export function ConfirmOverrule({ ws, facts, onClose }: { ws: Pick<Workspace, 'id' | 'prNumber'>; facts: BlockerFacts; onClose: () => void }) {
  const [busy, run] = useBusy()
  const [note, setNote] = useState('')
  const id = useId()
  const pr = ws.prNumber ? `#${ws.prNumber}` : 'this pull request'
  const who = reviewsText(facts.kinds)
  const owner = `${who.charAt(0).toLowerCase()}${who.slice(1)}${who.endsWith('s') ? "'" : "'s"}`
  const overrule = () => run('overrule', async () => {
    try { await call('reviews.overrule', { workspaceId: ws.id, ...(note.trim() && { note: note.trim() }) }); onClose() } catch (e) { actions.ui.toast({ title: 'Could not overrule', sub: cleanError(e) }) }
  })

  return (
    <ConfirmDialog
      title={`Overrule ${owner} ${facts.count} ${facts.count === 1 ? 'blocker' : 'blockers'} on ${pr}?`}
      body="The PR reads ready and merges as any other. A new commit brings the blockers back, and Undo takes this back."
      confirmLabel="Overrule" busy={!!busy} busyPattern="pulse" busyLabel="Overruling"
      onConfirm={() => void overrule()} onCancel={onClose}
    >
      {facts.items.length > 0 && (
        <ul className="wsc-blockers" aria-label="Blockers">
          {facts.items.map((b, i) => (
            <li key={i}>{b.text}{b.file && <span className="mono wsc-blocker-at"> {b.file}{b.line ? `:${b.line}` : ''}</span>}</li>
          ))}
        </ul>
      )}
      <label className="wsc-note" htmlFor={`${id}n`}>Note
        <input id={`${id}n`} className="input" value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} disabled={!!busy} />
      </label>
    </ConfirmDialog>
  )
}
