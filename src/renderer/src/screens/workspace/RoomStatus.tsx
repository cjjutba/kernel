import { Fragment, useMemo, type ReactNode } from 'react'
import type { Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { allOverlaps, inboxItems, needsYou } from '../inbox/model'
import { useLeadPrs } from './pr/leadPrList'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Several PRs ready to merge open the PRs tab in the room's newest Lead chat, where Merge all is. One opens its own
 * workspace, and so does the first when the room has no Lead chat open.
 */
async function openReady(roomId: string, ready: Workspace[]): Promise<void> {
  if (ready.length > 1) {
    try {
      const ws = await call('lead.open', { roomId })
      if (ws) {
        actions.workspaces.upsert(ws)
        actions.ui.setWorkspaceView({ leadRight: 'prs' })
        actions.ui.setRightPanel(true)
        go({ name: 'workspace', workspaceId: ws.id })
        return
      }
    } catch { /* the first PR's workspace below */ }
  }
  go({ name: 'workspace', workspaceId: ready[0].id })
}

/**
 * The line under New chat's title: what the room is doing, from the same signals the sidebar reads. Agents working are the
 * workspaces with a turn running, the rows that spin. Waiting on you are the room's Inbox rows that need you. PRs ready to merge are
 * the PRs tab's ready rows. Each part shows only when it has something, and the line keeps its height when none does, so the
 * composer under it never moves.
 */
export function RoomStatus({ roomId }: { roomId: string }) {
  const working = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && (s.chats[w.id] ?? []).some((c) => s.running[c.id])).length)
  const notifications = useStore((s) => s.notifications)
  const approvals = useStore((s) => s.approvals)
  const rooms = useStore((s) => s.rooms)
  const overlaps = useStore((s) => s.overlaps)
  const workspaces = useStore((s) => s.workspaces)
  const waiting = useMemo(() => inboxItems(notifications, approvals, rooms, allOverlaps(overlaps), workspaces).filter((i) => needsYou(i) && i.n.roomId === roomId).length, [notifications, approvals, rooms, overlaps, workspaces, roomId])
  const ready = useLeadPrs(roomId).filter((r) => r.ready).map((r) => r.ws)

  const parts: ReactNode[] = []
  if (working) parts.push(<span key="working">{plural(working, 'agent working', 'agents working')}</span>)
  if (waiting) parts.push(<button key="waiting" type="button" className="lead-status-link" onClick={() => go({ name: 'inbox' })}>{waiting} waiting on you</button>)
  if (ready.length) parts.push(<button key="ready" type="button" className="lead-status-link" onClick={() => void openReady(roomId, ready)}>{plural(ready.length, 'PR ready to merge', 'PRs ready to merge')}</button>)
  return (
    <p className="lead-status">
      {parts.map((p, i) => <Fragment key={i}>{i > 0 && <span className="lead-status-sep" aria-hidden="true">·</span>}{p}</Fragment>)}
    </p>
  )
}
