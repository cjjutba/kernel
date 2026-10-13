import { useRef } from 'react'
import type { RoomSettings, TrackerKind } from '@shared/types'
import { actions, useStore } from '../../../store'
import { Button, Icon, Menu, type MenuEntry } from '../../../ui'
import { isOverride, Row, sourceLine } from '../kit'
import { patchRoomSettings } from '../useSettings'

type Kind = TrackerKind | 'none'

/** The trackers a room can pick, in menu order. Jira joins this list when Kernel can read it (KERNEL-474). */
const CHOICES: Kind[] = ['linear', 'github', 'none']
const LABEL: Record<Kind, string> = { linear: 'Linear', github: 'GitHub Issues', jira: 'Jira', none: 'None' }
/** What the row says when the room has no `[tracker] kind` and detection decided (SettingsRoom.png, SettingsRoomTracker.png, SettingsRoomTrackerNone.png). */
const DETECTED: Partial<Record<Kind, string>> = {
  linear: 'Detected from your Linear connection',
  github: 'Detected from the github.com remote',
  none: 'None detected. Choose one to list issues for this room.'
}

/**
 * Settings > a room > General > Issue tracker (SettingsRoomTracker.png): the room's tracker and a menu to change it. `detected` is
 * what Kernel finds without a `[tracker] kind`, and the menu marks it. A pick writes the key to the room's personal file, and Reset
 * drops it again.
 */
export function RoomTrackerRow({ roomId, rs, detected }: { roomId: string; rs: RoomSettings; detected: Kind }) {
  const open = useStore((s) => s.ui.menu === 'roomTracker')
  const anchor = useRef<HTMLDivElement>(null)
  const chosen = rs.tracker?.kind
  const current = chosen ?? detected

  // Escape or a pick closes the menu from inside it, so focus goes back to the trigger instead of to the page.
  const close = () => {
    actions.ui.closeMenu()
    anchor.current?.querySelector('button')?.focus()
  }
  const entries: MenuEntry[] = CHOICES.map((kind) => ({
    id: kind,
    label: LABEL[kind],
    checked: kind === current,
    note: kind === detected ? 'Detected' : undefined,
    onSelect: () => { if (kind !== current) void patchRoomSettings(roomId, { tracker: { kind } }) }
  }))

  return (
    <Row
      label="Issue tracker"
      source={sourceLine(rs, 'tracker.kind')}
      desc={chosen ? undefined : DETECTED[detected]}
      onReset={isOverride(rs, 'tracker.kind') ? () => void patchRoomSettings(roomId, { tracker: { kind: null } }) : undefined}
    >
      <div className="set-menu" ref={anchor}>
        <Button className="set-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`Issue tracker: ${LABEL[current]}`} onClick={() => actions.ui.toggleMenu('roomTracker')}>
          {LABEL[current]}<Icon name="chevron" size={12} />
        </Button>
        {open && <Menu label="Issue tracker" anchorRef={anchor} onClose={close} style={{ right: -19, top: 36, width: 259 }} items={entries} />}
      </div>
    </Row>
  )
}
