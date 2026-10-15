import { useRef, useState } from 'react'
import type { Thread } from '@shared/types'
import { call, cleanError } from '../../api'
import { isLeadWorkspace, leadOf } from '../../lead'
import { archiveDestination, tabOf, threadIdOf } from '../../nav'
import { actions, getState, go, loadWorkspace, useStore, type State } from '../../store'
import { sidebarRows, type Slot } from '../../components/sidebar/slots'
import { ConfirmDialog, useBusy } from '../../ui'
import { dropDrafts } from './composer/draftStore'
import { dropPlace } from './chatPlace'
import { nextTab } from './nextTab'
import { sharedTab } from './shared/shared'
import { archiveChatFromSidebar } from './archiveChat'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import './confirm.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * The Lead chat these tabs are all the open tabs of, or nothing. Closing them closes that chat (KERNEL-338), which asks first when it is running and
 * leaves the sidebar for the next chat. Only the Lead's workspace has such chats.
 */
export function closesThread(s: State, workspaceId: string, ids: string[]): Thread | undefined {
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  if (!ws || !isLeadWorkspace(ws, ws.projectId, leadOf(s.agents, ws.projectId)?.id)) return undefined
  const open = (s.chats[workspaceId] ?? []).filter((c) => c.kind === 'chat' && !c.closed)
  const first = open.find((c) => ids.includes(c.id))
  if (!first) return undefined
  const id = threadIdOf(first)
  if (!open.filter((c) => threadIdOf(c) === id).every((c) => ids.includes(c.id))) return undefined
  return s.threads[id] ?? { id, projectId: ws.projectId, title: first.title, createdAt: first.createdAt }
}

/** What the "Close this chat?" dialog says about the chat these tabs close. Flat, so a live read compares equal until something in it changes. */
export type WholeChat = { id: string; title: string; started: number }

export function wholeChat(s: State, workspaceId: string, ids: string[]): WholeChat | undefined {
  const thread = closesThread(s, workspaceId, ids)
  const projectId = s.workspaces.find((w) => w.id === workspaceId)?.projectId
  if (!thread || !projectId) return undefined
  return { id: thread.id, title: thread.title, started: chatRows(s, projectId).find((r) => r.thread.id === thread.id)?.owned.length ?? 0 }
}

/** The first chat a live read finds, kept from then on, so the dialog does not change once its tabs close. */
export const frozenWhole = (kept: WholeChat | undefined, live: WholeChat | undefined) => kept ?? live

/** The Lead's chat rows as the sidebar lists them, top to bottom. */
function chatRows(s: State, projectId: string) {
  const project = s.projects.find((r) => r.id === projectId)
  return project ? sidebarRows(project, s.agents, s.workspaces, s.chats, s.threads, s.ui.foldedChats).filter((r): r is Extract<Slot, { kind: 'chat' }> => r.kind === 'chat') : []
}

/**
 * Close chat tabs. Main stops each chat's session, which ends a running turn and drops its queued messages, and opens a
 * new chat when no chat tab is left. When the open tab is one of them, the tab used before it opens (`nextTab`), like any other tab.
 * `order` is the tabs on screen left to right, so a file, diff or shared tab can be the one returned to; without it the chat tabs and the
 * store's file, diff and shared tabs are used. In the Lead's workspace that is the tabs of the same chat. Closing a chat's
 * last tab closes the chat, and the shared Lead workspace it was in sends you to the project's front door, as archiving any chat on screen does (KERNEL-596).
 */
export async function closeChats(workspaceId: string, ids: string[], active: string | undefined, select: (id: string) => void, order?: string[]) {
  const s = getState()
  const closing = closesThread(s, workspaceId, ids)
  const all = s.chats[workspaceId] ?? []
  const shown = all.find((c) => c.id === active)
  // The tabs a neighbour is picked from: the active tab's own chat in the Lead's workspace, else every tab.
  const before = shown?.threadId ? all.filter((c) => c.threadId === shown.threadId) : all
  const t = s.ui.tabs[workspaceId]
  const tabsNow = order ?? [...before.filter((c) => !c.closed).map((c) => c.id), ...(t?.files ?? []).map((p) => `file:${p}`), ...(t?.diffs ?? []).map((p) => `diff:${p}`), ...(t?.shared ?? []).map(sharedTab)]
  const next = nextTab(tabsNow, t?.recent, ids, active)
  for (const id of ids) {
    await call('chats.close', { chatId: id })
    dropDrafts([id])
    dropPlace(id)
  }
  await loadWorkspace(workspaceId)
  if (closing) {
    const to = archiveDestination(getState().ui.route, getState(), (id) => id === workspaceId)
    if (to) go(to)
    return
  }
  if (!active || !ids.includes(active)) return
  const left = getState().chats[workspaceId] ?? []
  const pick = next ?? left.find((c) => !shown?.threadId || c.threadId === shown.threadId)?.id ?? left[0]?.id
  if (pick) select(pick)
}

/** Asks before closing chats that are still running, since closing stops the agent mid-turn. `ChatTabs` closes idle chats without asking. */
export function ConfirmCloseChats({ workspaceId, chatIds }: { workspaceId: string; chatIds: string[] }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const agent = useStore((s) => (ws ? s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name : undefined)) ?? 'The agent'
  const chats = useStore((s) => s.chats[workspaceId])?.filter((c) => chatIds.includes(c.id)) ?? []
  const working = useStore((s) => chatIds.filter((id) => s.running[id]))
  const queued = useStore((s) => chatIds.reduce((n, id) => n + (s.queue[id]?.length ?? 0), 0))
  // Every open tab of a Lead chat: the whole chat closes, which has its own words (GroupedCloseLastTab.png). Read live, since the Lead's chats may load
  // after the dialog opens, then frozen at the first chat it finds: pressing Close chat closes the tabs, and a live read would then turn this into the
  // generic dialog while the button is still busy.
  const live = useStore((s) => wholeChat(s, workspaceId, chatIds))
  const seen = useRef<WholeChat | undefined>(undefined)
  seen.current = frozenWhole(seen.current, live)
  const whole = seen.current
  const [closing, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  if (!ws) return null

  const close = () => run('close', async () => {
    setError(null)
    // A Lead chat's last tabs archive the chat, which asks in its own words when that stops something (KERNEL-405).
    const thread = whole && isLeadChatWorkspace(ws) ? getState().threads[whole.id] : undefined
    if (thread) { actions.ui.closeModal(); return archiveChatFromSidebar(thread) }
    try {
      await closeChats(workspaceId, chatIds, tabOf(getState(), workspaceId), (tab) => actions.ui.openTab(workspaceId, tab))
      actions.ui.closeModal()
    } catch (e) { setError(cleanError(e)) }
  })

  const one = chatIds.length === 1
  const where = one ? 'this chat' : working.length === 1 ? chats.find((c) => c.id === working[0])?.title ?? 'one of them' : `${working.length} of them`
  const drops = queued ? ` and drops ${plural(queued, 'queued message')}` : ''
  const body = `${agent} is still working in ${where}. Closing stops ${working.length > 1 ? 'those turns' : 'the turn'}${drops}. Changes already in the worktree stay.`

  if (whole) {
    const { title, started } = whole
    const handed = started ? ` The ${started === 1 ? 'workspace' : `${started} workspaces`} it started ${started === 1 ? 'stays' : 'stay'} in the sidebar.` : ''
    return (
      <ConfirmDialog
        title="Close this chat?" body={`${agent} is still working in this chat. Closing its last tab stops that turn and closes the chat.${handed}`}
        busy={!!closing} busyPattern="scatter" busyLabel="Closing" confirmLabel="Close chat" onConfirm={() => void close()} onCancel={actions.ui.closeModal}
      >
        <div className="wsc-facts mono"><span>{title}</span><span>{plural(chatIds.length, 'tab')} · {agent} is working</span></div>
        {error && <p role="alert" className="wsc-error">{error}</p>}
      </ConfirmDialog>
    )
  }

  return (
    <ConfirmDialog
      title={one ? `Close ${chats[0]?.title ?? 'this chat'}?` : `Close ${plural(chatIds.length, 'tab')}?`} body={body}
      danger busy={!!closing} busyPattern="scatter" busyLabel="Closing" confirmLabel="Stop and close" onConfirm={() => void close()} onCancel={actions.ui.closeModal}
    >
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
