import { useEffect } from 'react'
import { archiveDestination } from '../../nav'
import { actions, getState, go, subscribe } from '../../store'
import { archivedByHand } from './byHand'
import { archiveToast } from './pr/model'

/**
 * Follows the store for the life of the app and moves the route when the workspace on screen turns archived (KERNEL-596). It is the one place
 * that decides where an archive takes you, so every way to archive lands the same: the row's Archive, a chat's last tab, ConfirmArchive,
 * ConfirmArchiveChat, a banner, a PR's Archive, a review once its work merged, and Kernel archiving after a merge. The destination is
 * `archiveDestination`, the project's front door, and never History or another chat.
 *
 * It is a listener and not an effect, so the archived status and the move are one synchronous step and no screen has to be mounted for it:
 * no frame shows the workspace stripped of its tabs, and nothing waits for main to answer, which is after the pushes. A failed archive never
 * stores the status, so it never moves you. A workspace Kernel archived on its own gets its toast; one the user archived gets none (KERNEL-495).
 */
export function followArchives(): () => void {
  let last = getState()
  return subscribe(() => {
    const s = getState()
    const before = last
    last = s
    if (s.workspaces === before.workspaces) return
    const archivedNow = (id: string) => {
      const was = before.workspaces.find((w) => w.id === id)
      return !!was && was.status !== 'archived' && s.workspaces.find((w) => w.id === id)?.status === 'archived'
    }
    const route = s.ui.route
    const to = archiveDestination(route, s, archivedNow)
    if (!to || route.name !== 'workspace') return
    const ws = s.workspaces.find((w) => w.id === route.workspaceId)
    if (ws && !archivedByHand(ws.id)) {
      const toast = archiveToast(ws, ws.reviewOf ? s.workspaces.find((w) => w.id === ws.reviewOf) : undefined, s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name)
      if (toast) actions.ui.toast(toast)
    }
    go(to)
  })
}

/** Starts following the archives while the app is mounted. App calls it once. */
export function useArchiveLanding(): void {
  useEffect(() => followArchives(), [])
}
