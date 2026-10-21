import { useMemo } from 'react'
import { go, useStore } from '../../store'
import { Icon } from '../../ui'
import { archivedList } from '../../screens/history/model'

/**
 * The row above the footer that opens History (Pen 12.4): "Archived", how many workspaces and chats wait there, a hairline and a chevron. It
 * stays where it is whatever is hidden, and shows as the open page while History is on screen.
 */
export function ArchivedRow() {
  const workspaces = useStore((s) => s.workspaces)
  const here = useStore((s) => s.ui.route.name === 'history')
  const count = useMemo(() => archivedList(workspaces).length, [workspaces])
  return (
    <button type="button" className="sb-archived" aria-current={here ? 'page' : undefined} aria-label={`Archived, ${count}. Open History`} onClick={() => go({ name: 'history' })}>
      <span className="sb-archived-label">Archived ({count})</span>
      <span className="sb-archived-rule" aria-hidden="true" />
      <Icon name="chevron" size={12} />
    </button>
  )
}
