import { useId } from 'react'
import { rememberBypassConfirmed } from '../bypassConfirm'
import { saveAppMode, saveChatMode, saveRoomMode } from '../permissionModes'
import { actions, useStore } from '../store'
import { ConfirmDialog, useBusy } from '../ui'
import './confirmBypass.css'

const STOPS = [
  'Commands on your Never allow list',
  'Pushes to protected branches',
  'Network access, when it is off in Settings, Permissions',
  'Questions and plan approval'
]

/**
 * The first switch into Bypass permissions (ConfirmBypass.png, KERNEL-455). It saves Bypass as the app's mode, as `roomId`'s override,
 * or as the own mode of `chatId`, the chat whose composer picked it (KERNEL-456), and never shows again once the user has said yes.
 * Cancelling saves nothing and asks again next time.
 */
export function ConfirmBypass({ roomId, chatId }: { roomId?: string; chatId?: string }) {
  const id = useId()
  const onlyInWorktrees = useStore((s) => s.settings?.permissions.bypassOnlyInWorktrees ?? true)
  const [busy, run] = useBusy()
  const use = () => run('use', async () => {
    const saved = chatId ? await saveChatMode(chatId, 'bypassPermissions') : roomId ? await saveRoomMode(roomId, 'bypassPermissions') : await saveAppMode('bypassPermissions')
    if (!saved) return
    rememberBypassConfirmed()
    actions.ui.closeModal()
  })
  return (
    <ConfirmDialog
      title="Turn on Bypass permissions?" danger busy={busy !== null} busyPattern="pulse" busyLabel="Saving" confirmLabel="Use Bypass permissions"
      body="Agents will edit files and run commands without asking, including the commands on your Always ask list. Kernel asks this once."
      onConfirm={() => void use()} onCancel={actions.ui.closeModal}
    >
      <div className="cb-stops">
        <span id={`${id}s`} className="cb-stops-title">It still stops for</span>
        <ul aria-labelledby={`${id}s`}>{STOPS.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
      <p className="cb-note">{onlyInWorktrees ? 'Only in worktrees is on, so this never applies to your current branch.' : 'Only in worktrees is off, so this also applies to your current branch.'}</p>
    </ConfirmDialog>
  )
}
