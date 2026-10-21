import type { PushEvent } from '@shared/ipc'
import type { Toast, Workspace } from '@shared/types'
import { actions, getState, go, loadProject } from '../../store'
import { bottomKindOf } from './bottomSplit'
import { clock } from './setupClock'

type SetupFailed = Extract<PushEvent, { type: 'setup.failed' }>
type WorktreeFailed = Extract<PushEvent, { type: 'worktree.failed' }>

/** Who keeps working: the teammate by name, or Kernel for the Lead's own chats. */
export function whoWorks(ws: Workspace): string {
  if (ws.lead) return 'Kernel'
  const s = getState()
  return s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name ?? ws.agentId
}

/** The third line: the chat the toast is about, so one that came from another tab says which. */
export function chatTitle(ws: Workspace, chatId: string | undefined): string | undefined {
  const chat = chatId ? getState().chats[ws.id]?.find((c) => c.id === chatId) : undefined
  return chat?.title ?? ws.title
}

/** Opens the Setup tab of the workspace's bottom drawer. Nothing is rerun. */
export function openSetupLog(workspaceId: string) {
  const ws = getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return
  go({ name: 'workspace', workspaceId })
  actions.ui.setWorkspaceView({ bottom: 'setup' })
  actions.ui.setBottomCollapsed(bottomKindOf(getState(), ws), false, false)
}

/**
 * A setup run that didn't pass (KERNEL-1086, Pen 6.5 and 6.11). Setup never holds anything, so the toast says the agent keeps working and offers
 * the log and another run. A stop by hand has no log to read, so it offers only the run. The Session rail and the Setup tab carry the rest.
 */
export function setupFailedToast(e: SetupFailed): Omit<Toast, 'id'> | undefined {
  const ws = getState().workspaces.find((w) => w.id === e.workspaceId)
  if (!ws) return undefined
  const who = whoWorks(ws)
  const run = ws.setupRun
  const took = run?.endedAt ? clock(run.endedAt - run.startedAt) : undefined
  const rerun = { label: 'Rerun setup', rerunSetup: ws.id, primary: true }
  const detail = chatTitle(ws, e.chatId)
  if (e.kind === 'stopped') return { title: 'Setup stopped', sub: `You stopped setup${took ? ` after ${took}` : ''}. ${who} keeps working.`, glyph: 'error', ...(detail ? { detail } : {}), action: rerun }
  return {
    title: e.kind === 'timeout' ? 'Setup script timed out' : 'Setup script failed',
    sub: `${who} keeps working. Check the Setup tab for logs.`,
    glyph: 'error',
    ...(detail ? { detail } : {}),
    other: { label: 'Open Setup tab', openSetup: ws.id },
    action: rerun
  }
}

/** git couldn't make the worktree (Pen 6.7). The message stays in the chat as Not sent, and Try again makes the worktree and sends it. */
export function worktreeFailedToast(e: WorktreeFailed): Omit<Toast, 'id'> {
  const ws = getState().workspaces.find((w) => w.id === e.workspaceId)
  const detail = ws ? chatTitle(ws, e.chatId) : undefined
  return { title: "Couldn't create the worktree", sub: e.error, glyph: 'error', ...(detail ? { detail } : {}), action: { label: 'Try again', retryWorktree: e.workspaceId, primary: true } }
}

/** The agent's name comes from the project's team, which a window that just opened may not have yet. */
async function teamLoaded(workspaceId: string) {
  const ws = getState().workspaces.find((w) => w.id === workspaceId)
  if (ws && !getState().agents[ws.projectId]) await loadProject(ws.projectId).catch(() => undefined)
}

/** `setup.failed` as the store hears it: one toast. */
export async function raiseSetupFailed(e: SetupFailed) {
  await teamLoaded(e.workspaceId)
  const toast = setupFailedToast(e)
  if (toast) actions.ui.toast(toast)
}

/** `worktree.failed` as the store hears it: one toast. */
export function raiseWorktreeFailed(e: WorktreeFailed) {
  actions.ui.toast(worktreeFailedToast(e))
}
