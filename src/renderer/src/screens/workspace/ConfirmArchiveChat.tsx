import { useEffect, useState } from 'react'
import type { ChatArchivePreview } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState } from '../../store'
import { ConfirmDialog, Icon, useBusy } from '../../ui'
import type { IconName } from '../../icons'
import { archiveChatNow, stopsSomething } from './archiveChat'
import './confirm.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Closes this dialog and nothing else: the move to the front door that archiving a chat on screen makes has closed it already. */
function closeArchiveChatDialog(threadId: string) {
  const modal = getState().ui.modal
  if (modal?.name === 'confirm' && modal.kind === 'archiveChat' && modal.threadId === threadId) actions.ui.closeModal()
}

type Cost = { id: string; icon: IconName; text: string }

/** What archiving stops or loses on one workspace, a row for each: a running turn, an open PR, uncommitted files, commits not on GitHub and a branch Kernel can't read. */
function costs(w: ChatArchivePreview['workspaces'][number]): Cost[] {
  const out: Cost[] = []
  if (w.running) out.push({ id: 'running', icon: 'stop', text: w.own ? "This chat's running turn stops" : 'its running turn stops' })
  if (w.pr) out.push({ id: 'pr', icon: 'pr', text: `PR #${w.pr} stays open on GitHub` })
  if (w.dirty > 0) out.push({ id: 'dirty', icon: 'doc', text: `${plural(w.dirty, 'uncommitted file')} ${w.dirty === 1 ? 'is' : 'are'} dropped` })
  if (w.unpushed > 0) out.push({ id: 'unpushed', icon: 'branch', text: `${plural(w.unpushed, 'commit')} not on GitHub ${w.unpushed === 1 ? 'stays' : 'stay'} on the branch` })
  if (w.unknown) out.push({ id: 'unknown', icon: 'warning', text: "Kernel couldn't read the branch" })
  return out
}

/**
 * Archive a Lead chat that would stop something (KERNEL-405), laid out like Pen 12.3: a row for each thing archiving stops or loses,
 * with the glyph of what it is, and the workspace's name in front when it isn't the chat's own. The worktrees go. Branches with commits stay, and the chat and its workspaces wait in
 * History.
 */
export function ConfirmArchiveChat({ threadId }: { threadId: string }) {
  const [preview, setPreview] = useState<ChatArchivePreview | null>(null)
  const [unread, setUnread] = useState(false)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void call('threads.archivePreview', { threadId }).then(setPreview).catch(() => setUnread(true)) }, [threadId])
  const others = preview?.workspaces.filter((w) => !w.own).length ?? 0
  const rows = (preview?.workspaces.filter(stopsSomething) ?? []).flatMap((w) => costs(w).map((c): [ChatArchivePreview['workspaces'][number], Cost] => [w, c]))

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
    'Archiving removes the worktrees. Branches with commits stay, and you can restore the chat from History.'
  ].filter(Boolean).join(' ')

  return (
    <ConfirmDialog
      title="Archive this chat?" body={body} busy={busy !== null} busyPattern="ripple" busyLabel="Archiving" disabled={busy !== null || (!preview && !unread)}
      confirmLabel="Archive" onConfirm={() => void archive()} onCancel={actions.ui.closeModal}
    >
      {rows.length > 0 && (
        <ul className="wsc-facts wsc-costs" aria-label="What archiving stops">
          {rows.map(([w, c]) => (
            <li key={`${w.id}-${c.id}`} className="wsc-cost"><Icon name={c.icon} size={13} /><span>{!w.own && <><span className="mono wsc-cost-for">{w.name}</span>: </>}{c.text}</span></li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
