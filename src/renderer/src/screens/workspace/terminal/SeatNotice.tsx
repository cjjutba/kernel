import type { Chat } from '@shared/types'
import { call } from '../../../api'
import { Button, useBusy } from '../../../ui'
import { seatConnected } from './seat'

/**
 * The line above a big terminal whose seat is not connected to Kernel (Kernel restarted, or connect is off). Reconnect restarts the
 * tab with resume.
 */
export function SeatNotice({ chat }: { chat: Chat }) {
  const [busy, run] = useBusy<'reconnect'>()
  if (chat.kind !== 'terminal' || seatConnected(chat)) return null
  const reconnect = () => run('reconnect', async () => { await call('terminal.reconnect', { chatId: chat.id }) })
  return (
    <div className="term-notice term-seat" role="status">
      <span>This terminal is not connected to Kernel, so its tools and updates are off.</span>
      <Button size="sm" onClick={reconnect} busy={busy === 'reconnect'} busyLabel="Reconnecting">Reconnect</Button>
    </div>
  )
}
