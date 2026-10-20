import { useEffect, useState } from 'react'
import type { ChatArchivePreview } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { archiveChatNow, stopsSomething } from './archiveChat'
import './confirm.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Closes this dialog and nothing else: the move to the front door that archiving a chat on screen makes has closed it already. */
function closeArchiveChatDialog(threadId: string) {
  const modal = getState().ui.modal
  if (modal?.name === 'confirm' && modal.kind === 'archiveChat' && modal.threadId === threadId) actions.ui.closeModal()
}

/** What archiving stops on one workspace, in one line: whether it runs, an open PR, uncommitted files and unpushed commits. */
function stops(w: ChatArchivePreview['workspaces'][number]): string {
  const parts = [
    w.running ? 'still running' : '',
    w.pr ? `PR #${w.pr} stays open on GitHub, but Kernel stops checking it` : '',
    w.dirty ? `${plural(w.dirty, 'file')} with uncommitted changes` : '',
    w.unpushed ? `${plural(w.unpushed, 'commit')} not on GitHub yet` : '',
    w.unknown ? "Kernel couldn't read its branch" : ''
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'nothing to lose'
}

/**
 * Archive a Lead chat that would stop something (KERNEL-405), laid out like ConfirmArchive.png: a line per workspace that goes
 * with it, its own last, saying what each stops. The worktrees go. Branches with commits stay, and the chat and its workspaces wait in
 * History.
 */
export function ConfirmArchiveChat({ threadId }: { threadId: string }) {
  const thread = useStore((s) => s.threads[threadId])
  const [preview, setPreview] = useState<ChatArchivePreview | null>(null)
  const [unread, setUnread] = useState(false)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void call('threads.archivePreview', { threadId }).then(setPreview).catch(() => setUnread(true)) }, [threadId])
  const title = preview?.title || thread?.title || 'this chat'
  const others = preview?.workspaces.filter((w) => !w.own).length ?? 0

  const archive = () => run('archive', async () => {
    setError(null)
    try {
      await archiveChatNow(threadId, preview?.workspaces.map((w) => w.id) ?? [])
      closeArchiveChatDialog(threadId)
    } catch (e) { setError(cleanError(e)) }
  })

  const body = [
    others ? `${plural(others, 'workspace')} this chat started ${others === 1 ? 'goes' : 'go'} with it.` : '',
    unread ? "Kernel couldn't read what this chat would stop." : '',
    'Archiving removes the worktrees. Branches with commits stay, and you can restore the chat from History.',
    preview?.workspaces.some((w) => w.dirty) ? 'Uncommitted changes go with the worktrees.' : ''
  ].filter(Boolean).join(' ')

  return (
    <ConfirmDialog
      title={`Archive ${title}?`} body={body} busy={busy !== null} busyPattern="ripple" busyLabel="Archiving" disabled={busy !== null || (!preview && !unread)}
      confirmLabel="Archive" onConfirm={() => void archive()} onCancel={actions.ui.closeModal}
    >
      {preview && (
        <div className="wsc-facts">
          {preview.workspaces.filter(stopsSomething).map((w) => <span key={w.id}>{w.own ? 'This chat' : <span className="mono">{w.name}</span>}: {stops(w)}</span>)}
        </div>
      )}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
