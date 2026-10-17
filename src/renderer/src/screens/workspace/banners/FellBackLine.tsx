import type { Chat } from '@shared/types'
import { chatProvider } from '@shared/providers'
import { useStore } from '../../../store'
import './banners.css'

const NAME = { claude: 'Claude', codex: 'Codex' } as const

/**
 * The one line above the composer in a workspace whose new work started on its fallback provider because every account of the preferred one was at a limit
 * (`providerFellBack`, KERNEL-1056). It shows on chats that run on that provider, and is a plain line, not a banner: nothing is wrong and nothing to do.
 */
export function FellBackLine({ chat }: { chat: Chat }) {
  const fell = useStore((s) => s.fellBack[chat.workspaceId])
  if (!fell || chatProvider(chat) !== fell.to) return null
  return <p className="wsb-fell" role="status">Running on {NAME[fell.to]} because every {NAME[fell.from]} account is at its limit.</p>
}
