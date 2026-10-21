import { useEffect, useMemo } from 'react'
import type { Workspace } from '@shared/types'
import { isReviewer } from '@shared/team'
import { call, cleanError } from '../../../api'
import { actions, getState, useStore } from '../../../store'
import { useBusy } from '../../../ui'
import { stripRemote } from '../../settings/remote'
import { useProjectSettings, useRemote } from '../../settings/useSettings'
import { attempt } from '../MessageActions'
import { sendMessage } from '../composer/sendMessage'
import { blockerFacts, NO_RULES, actionKey, busyLabel, failTitle, type PrAction } from './model'
import type { PrButtonId, PrFacts } from './prStage'
import { useLocalMerge } from './useLocalMerge'

/** What each action calls on the main process. Shared with `MergeButton`. */
export const request: Record<PrAction, (workspaceId: string) => Promise<unknown>> = {
  create: (workspaceId) => call('pr.create', { workspaceId }),
  resolve: (workspaceId) => call('pr.resolve', { workspaceId }),
  merge: (workspaceId) => call('pr.merge', { workspaceId }),
  ready: (workspaceId) => call('pr.ready', { workspaceId }),
  reopen: (workspaceId) => call('pr.reopen', { workspaceId }),
  update: (workspaceId) => call('pr.update', { workspaceId })
}

/** Copies the branch's name and says so in a toast. Also what the workspace title's click does. */
export async function copyBranch(branch: string) {
  try {
    await navigator.clipboard.writeText(branch)
    actions.ui.toast({ title: 'Branch copied', sub: branch })
  } catch { actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' }) }
}

/**
 * What the pull request's stages read, from the store: the PR as GitHub last said it, the rules a merge follows, the names of the agents, a branch that merges on the Mac,
 * and the action main runs on it. The Session rail and the title bar both read this, so they can't disagree.
 */
export function usePrFacts(ws: Workspace): PrFacts {
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const pr = useStore((s) => s.prs[ws.id])
  const agents = useStore((s) => s.agents[ws.projectId])
  const local = useLocalMerge(ws)
  const pending = useStore((s) => s.prPending[ws.id])
  const remote = useRemote(ws.projectId)
  const app = useStore((s) => s.settings?.pr.mergeMethod)
  const method = useProjectSettings(ws.projectId)?.pr?.mergeMethod ?? app ?? 'squash'
  return useMemo(() => {
    const name = (agentId: string) => agents?.find((a) => a.id === agentId)?.name ?? agentId
    return {
      pr, rules, name, pending, method,
      agent: name(ws.agentId),
      ...(agents?.find(isReviewer) ? { reviewer: agents.find(isReviewer)?.name } : {}),
      ...(local ? { local: { stand: local.stand, base: local.base } } : {}),
      base: local?.base ?? stripRemote(ws.baseRef, remote)
    }
  }, [pr, rules, agents, pending, method, local, remote, ws.agentId, ws.baseRef])
}

/** The message "Address blockers" sends: each blocker with where it is, as the Review tab words them. */
function blockersMessage(items: { text: string; file?: string; line?: number }[]): string {
  const lines = items.map((i) => `- ${i.file ? `${i.file}${i.line ? `:${i.line}` : ''}: ` : ''}${i.text}`)
  return `${items.length === 1 ? 'The review found this blocker' : `The review found ${items.length} blockers`} to fix:\n${lines.join('\n')}`
}

/**
 * Every button of the pull request's stages, as a call. The rail and the title bar draw the buttons and press them through this. It keeps the one rule the header kept: while an
 * action runs, from whichever button or tool started it, nothing else on the pull request can be pressed (KERNEL-520). It also holds ⌘⇧ and the action's letter, which press the
 * main button while it shows, and ⌘⇧A, which archives a merged or closed pull request (KERNEL-341).
 */
export function usePrActions(ws: Workspace, o: { key?: PrButtonId; archivable?: boolean } = {}): { busy: string | null; press: (id: PrButtonId) => void; createDraft: () => void; copyLink: () => void; openOnGitHub: () => void; undo: () => void } {
  const [busy, run] = useBusy()
  const id = ws.id
  const pr = useStore((s) => s.prs[id])
  const chat = useStore((s) => s.chats[id]?.find((c) => c.kind === 'chat' && !c.closed))
  const url = pr?.url || ws.prUrl

  const act = (label: string, title: string, fn: () => Promise<unknown>) => run(label, async () => {
    try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
  })
  const start = (a: PrAction) => void act(busyLabel[a], failTitle[a], () => request[a](id))
  const createDraft = () => void act(busyLabel.create, failTitle.create, () => call('pr.create', { workspaceId: id, draft: true }))
  const openOnGitHub = () => { if (url) void attempt('Could not open GitHub', () => call('system.openExternal', { url })) }
  const copyLink = () => {
    if (!url) return
    void navigator.clipboard.writeText(url).then(() => actions.ui.toast({ title: 'Link copied', sub: url }), () => actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' }))
  }
  const undo = () => void act('Undoing', 'Could not undo the overrule', () => call('reviews.overrule', { workspaceId: id, clear: true }))
  const archive = () => actions.ui.openModal({ name: 'confirm', kind: 'archive', workspaceId: id })
  const tell = (text: string) => { if (chat) void sendMessage(chat.id, [{ type: 'text', text }]) }

  const press = (button: PrButtonId) => {
    switch (button) {
      case 'create': return start('create')
      case 'ready': return start('ready')
      case 'fix': case 'review': case 'resolve': return start('resolve')
      case 'merge': return start('merge')
      case 'update': return start('update')
      case 'reopen': return start('reopen')
      case 'anyway': return actions.ui.openModal({ name: 'confirm', kind: 'mergeAnyway', workspaceId: id })
      case 'open': return openOnGitHub()
      case 'archive': return archive()
      case 'continue': return void act('Continuing', 'Could not continue', () => call('pr.continue', { workspaceId: id }))
      case 'blockers': {
        const facts = blockerFacts(ws, pr)
        return tell(blockersMessage(facts?.items.length ? facts.items : [{ text: 'The review found blockers on the latest commit.' }]))
      }
      case 'commit': return tell("Commit the uncommitted changes in the project's main checkout so Kernel can merge this branch, then say when it is done.")
    }
  }

  // ⌘⇧ and the action's letter press the main button, and ⌘⇧A archives, only while that button shows (KERNEL-341). A busy button has no key, and an open modal turns them all off.
  const key = o.key ? actionKey[o.key === 'fix' || o.key === 'review' ? 'resolve' : (o.key as PrAction)] : undefined
  const listen = !busy && (!!key || !!o.archivable)
  useEffect(() => {
    if (!listen) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey || getState().ui.modal) return
      const k = e.key.toLowerCase()
      if (o.key && k === key) { e.preventDefault(); press(o.key) } else if (o.archivable && k === 'a') { e.preventDefault(); archive() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Checks, review comments and conflicts for the Pull request tab. Main pushes fresh ones on every refresh. A local merge has no number, and its read is what says ahead, behind and what is in the way.
  const local = useLocalMerge(ws)
  const reads = !!ws.prNumber || !!local
  useEffect(() => {
    if (!reads) return
    let live = true
    call('pr.get', { workspaceId: id }).then((info) => { if (live && info) actions.prs.set(info) }).catch(() => undefined)
    return () => { live = false }
  }, [id, reads, ws.prState])

  return { busy, press, createDraft, copyLink, openOnGitHub, undo }
}

