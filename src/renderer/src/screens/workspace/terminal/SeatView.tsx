import type { ChangedFile, Chat } from '@shared/types'
import { oneOf, useRemembered } from '../../../remember'
import { SegmentedControl } from '../../../ui'
import { Transcript } from '../Transcript'
import { seatViewKey } from './seat'
import { TerminalView } from './Terminal'

const VIEWS = ['terminal', 'transcript'] as const
const OPTIONS = [{ value: 'terminal', label: 'Terminal' }, { value: 'transcript', label: 'Transcript' }]
const noop = () => undefined

/**
 * A terminal tab: the real terminal, or the session read back as a transcript. The switch is kept per tab. The transcript is
 * read-only, with no composer, since what it shows is read from the terminal session and nothing typed here would reach it.
 */
export function SeatView({ chat, workspaceId, changes, onOpenDiff, onForked }: { chat: Chat; workspaceId: string; changes: ChangedFile[]; onOpenDiff: (path: string) => void; onForked: (chatId: string) => void }) {
  const [view, setView] = useRemembered(seatViewKey(chat.id), oneOf(VIEWS, 'terminal'))
  return (
    <>
      <div className="seat-bar">
        <SegmentedControl label="Terminal view" options={OPTIONS} value={view} onChange={(v) => setView(v as (typeof VIEWS)[number])} />
        {chat.terminal?.handoff && <p className="seat-note">Teammate running in a terminal.</p>}
        {view === 'transcript' && <p className="seat-note">Read from the terminal session.</p>}
      </div>
      {view === 'transcript'
        ? <Transcript chat={chat} workspaceId={workspaceId} changes={changes} onEdit={noop} onOpenDiff={onOpenDiff} onForked={onForked} />
        : <TerminalView id={chat.id} label="Big terminal" />}
    </>
  )
}
