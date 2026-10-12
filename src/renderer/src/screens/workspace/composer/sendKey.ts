import type { AppSettings } from '@shared/types'
import { useStore } from '../../../store'

type SendWith = AppSettings['general']['sendWith']
type Press = { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }

/**
 * Whether a key press sends, by Settings, General, Send messages with (KERNEL-536). Enter sends on Enter, and Shift+Enter
 * breaks the line. ⌘ Enter sends on Cmd+Enter only, and Enter breaks the line.
 */
export function sendsOn(e: Press, sendWith: SendWith = 'enter'): boolean {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey) return false
  return sendWith === 'cmdEnter' ? e.metaKey || e.ctrlKey : true
}

/** The saved Send messages with, Enter until the settings load. */
export const useSendWith = (): SendWith => useStore((s) => s.settings?.general.sendWith ?? 'enter')

/** The hint under a comment box, by the same setting. */
export const sendHint = (sendWith: SendWith) => (sendWith === 'cmdEnter' ? '⌘ Enter to send' : 'Enter to send')
