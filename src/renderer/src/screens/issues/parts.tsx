import { useRef, useState, type ReactNode } from 'react'
import type { BannerKind, GitHubErrorKind, Room } from '@shared/types'
import { go } from '../../store'
import { Banner, Button, Icon, Menu, Select, useBusy } from '../../ui'
import { RoomIcon } from '../../components/RoomIcon'
import { SidebarToggleSlot } from '../../components/PanelToggles'

type Option = { value: string; label: string }

/** A filter as a chip: its name, its value and a chevron. It is a Select, so the keyboard and screen readers work (KERNEL-680). */
export function FilterChip({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  return <Select variant="chip" prefix={label} label={label} value={value || (options[0]?.value ?? '')} options={options} onChange={onChange} />
}

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
      <SidebarToggleSlot />
      <Icon name="issues" />
      <h1>Issues</h1>
      {room && (
        <>
          <span className="is-slash" aria-hidden="true">/</span>
          <span ref={anchor} className="is-roommenu">
            <Button variant="ghost" className="is-roompick" aria-label={`Room: ${room.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
              <RoomIcon room={room} className="is-letter" fallback="?" />{room.name}<Icon name="chevron" size={12} />
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

/** A failed refresh over rows that already loaded: the rows stay and this sits above them. */
export function RefreshNotice({ kind, title, action, children }: { kind: BannerKind; title: string; action: ReactNode; children: ReactNode }) {
  return <div className="is-notice"><Banner kind={kind} title={title} actions={action}>{children}</Banner></div>
}

/** The list stops at the most recent issues the tracker returns. Say so at its foot. */
export function CapNote({ children }: { children: ReactNode }) {
  return <p className="is-cap muted">{children}</p>
}

/** What a failed GitHub read says and where it points, by the kind the engine gave it (KERNEL-861). */
export function githubProblem(kind: GitHubErrorKind, message: string, where: string): { title: string; sub: string; banner: BannerKind } {
  if (kind === 'signed-out') return { title: "GitHub isn't signed in", sub: 'Run gh auth login in a terminal, then try again.', banner: 'auth' }
  if (kind === 'not-found') return { title: `Can't find ${where}`, sub: 'The repo may have been renamed, deleted or made private. Choose another tracker for this room.', banner: 'setup' }
  if (kind === 'rate-limited') return { title: 'GitHub rate limit reached', sub: 'Wait a few minutes, then try again.', banner: 'limit' }
  if (kind === 'offline') return { title: "Can't reach GitHub", sub: 'Check your connection, then try again.', banner: 'offline' }
  return { title: "Can't load issues", sub: message, banner: 'offline' }
}

/** The description and comments of an issue that did not load, with the way to ask again. The header and buttons stay. */
export function DescriptionFailed({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  const [busy, run] = useBusy<'retry'>()
  return (
    <Banner kind="offline" title="Could not load the description" actions={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void run('retry', async () => onRetry())}>Try again</Button>}>{children}</Banner>
  )
}
