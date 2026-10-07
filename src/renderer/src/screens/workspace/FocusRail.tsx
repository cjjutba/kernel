import { actions, go, useStore } from '../../store'
import { Icon } from '../../ui'
import { roomLetter } from '../rooms/roomInfo'

/** The slim rail that replaces the sidebar in focus mode (WorkspaceFocus.png). */
export function FocusRail({ roomId }: { roomId?: string }) {
  const rooms = useStore((s) => s.rooms.filter((r) => !r.hidden && !r.archived))
  return (
    <nav aria-label="Sidebar" className="focus-rail">
      <div className="drag" style={{ height: 42, flexShrink: 0 }} />
      <button className="rail-btn" aria-label="Search" onClick={() => actions.ui.openModal({ name: 'search' })}><Icon name="search" /></button>
      <button className="rail-btn" aria-label="Home" onClick={() => go({ name: 'home' })}><Icon name="home" /></button>
      <button className="rail-btn" aria-label="Inbox" onClick={() => go({ name: 'inbox' })}><Icon name="inbox" /></button>
      {rooms.map((r) => (
        <button key={r.id} className="rail-btn rail-room" aria-label={r.name} aria-current={r.id === roomId ? 'page' : undefined} onClick={() => go({ name: 'floor', roomId: r.id })}>{roomLetter(r.name)}</button>
      ))}
    </nav>
  )
}
