import { useRef, useState, type ReactNode } from 'react'
import type { Room } from '@shared/types'
import { go } from '../../store'
import { Button, Icon, Menu } from '../../ui'
import { RoomIcon } from '../../components/RoomIcon'
import { SidebarToggle } from '../../components/PanelToggles'

type Option = { value: string; label: string }

/** A filter as a chip: its name, its value and a chevron, with a real select laid over it so the keyboard and screen readers work. */
export function FilterChip({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const shown = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? ''
  return (
    <span className="is-chip">
      <span className="muted">{label}</span>
      <span>{shown}</span>
      <Icon name="chevron" size={10} stroke={1.9} />
      <select aria-label={`${label}: ${shown}`} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  )
}

export const typing = (t: HTMLElement | null) => !!t?.closest('input, textarea, select, [contenteditable="true"]')

/** The room the page lists and the rooms it can switch to. A page with no room at all has none. */
export interface RoomHead { rooms: Room[]; room?: Room; onRoom: (id: string) => void }

/**
 * The page's header: Issues, the room whose tracker it lists and, on the right, where the issues come from (IssuesGitHub.png).
 * The room menu is the way to another room's tracker, so every tracker's page has it (KERNEL-438).
 */
export function IssuesHeader({ head, where }: { head: RoomHead; where?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const { rooms, room, onRoom } = head
  return (
    <header className="header is-head">
      <SidebarToggle />
      <Icon name="issues" />
      <h1>Issues</h1>
      {room && (
        <>
          <span className="is-slash" aria-hidden="true">/</span>
          <span ref={anchor} className="is-roommenu">
            <Button variant="ghost" className="is-roompick" aria-label={`Room: ${room.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
              <RoomIcon room={room} className="is-letter" fallback="?" />{room.name}<Icon name="chevron" size={10} stroke={1.9} />
            </Button>
            {open && (
              <Menu label="Room" anchorRef={anchor} onClose={() => setOpen(false)} style={{ left: 0, top: 'calc(100% + 4px)' }}
                items={rooms.map((r) => ({ id: r.id, label: r.name, checked: r.id === room.id, onSelect: () => onRoom(r.id) }))} />
            )}
          </span>
        </>
      )}
      <span className="grow" />
      {where && <span className="is-where muted">{where}</span>}
    </header>
  )
}

/** Settings, the room, General: where the room's tracker is chosen. */
export const chooseTracker = (roomId: string) => go({ name: 'settings', page: 'room', roomId, section: 'general' })

/** A room with no tracker says so and points at where to choose one (IssuesNoTracker.png). */
export function NoTracker({ room }: { room: Room }) {
  return (
    <div className="is-center is-state">
      <h2>{room.name} has no issue tracker</h2>
      <p>Choose Linear or GitHub Issues in this room's settings and its issues show here. Chats work without one.</p>
      <Button variant="primary" size="lg" onClick={() => chooseTracker(room.id)}>Choose a tracker</Button>
    </div>
  )
}
