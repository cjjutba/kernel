import type { Chat } from '@shared/types'
import { skipWasDropped, useTerminalPresets } from '../../../terminalPresets'

/**
 * The line above a big terminal that ran without `--dangerously-skip-permissions` although its preset has it: Only in worktrees
 * is on and the workspace is the current branch (KERNEL-248). The tab keeps its title, so this says why it asks for permission.
 */
export function SkipNotice({ chat }: { chat: Chat }) {
  const presets = useTerminalPresets()
  if (!skipWasDropped(chat.terminal, presets)) return null
  return <p className="term-notice" role="status">Permissions are not skipped here. Only in worktrees is on and this is your current branch.</p>
}
