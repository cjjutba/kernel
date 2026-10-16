import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ResolvedFile, ResolvedPath } from '@shared/types'
import { ConfirmDialog, Menu } from '../../ui'
import { actions } from '../../store'
import { linkLabel, openMention, resolveMatch } from './fileLinks'

/**
 * A path an agent mentioned that exists in the workspace: it reads like inline code and underlines on hover. A click opens the
 * file in a tab, Shift-click its diff. A bare name that several files have lists them in a menu first, and a file that may hold
 * secrets asks before it shows.
 */
export function FileLink({ workspaceId, raw, hit, children }: { workspaceId: string; raw: string; hit: NonNullable<ResolvedPath>; children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [menu, setMenu] = useState(false)
  const [ask, setAsk] = useState<{ file: ResolvedFile; diff: boolean } | null>(null)
  const open = (file: ResolvedFile, diff: boolean) => { if (file.sensitive) setAsk({ file, diff }); else void openMention(workspaceId, file, { diff }) }
  const matches = 'matches' in hit ? hit.matches : null
  return (
    <span ref={anchor} className="md-file-wrap">
      <button
        type="button" className="md-code md-file" aria-label={linkLabel(hit, raw)} aria-haspopup={matches ? 'menu' : undefined} aria-expanded={matches ? menu : undefined}
        onClick={(e) => { if (matches) setMenu(!menu); else open(hit as ResolvedFile, e.shiftKey) }}
      >{children}</button>
      {matches && menu && (
        <Menu
          label={`Files named ${raw}`} anchorRef={anchor} onClose={() => setMenu(false)} style={{ left: 0, top: 'calc(100% + 4px)', minWidth: 240 }}
          items={matches.map((m) => ({ id: m, label: m, onSelect: () => { setMenu(false); void resolveMatch(workspaceId, m, raw).then((file) => { if (file) open(file, false); else actions.ui.toast({ title: 'This file no longer exists' }) }) } }))}
        />
      )}
      {ask && createPortal(
        <ConfirmDialog
          title="Show this file?" body="This file may contain secrets. Show it?" confirmLabel="Show file"
          onCancel={() => setAsk(null)} onConfirm={() => { const a = ask; setAsk(null); void openMention(workspaceId, a.file, { diff: a.diff }) }}
        />,
        document.body
      )}
    </span>
  )
}
