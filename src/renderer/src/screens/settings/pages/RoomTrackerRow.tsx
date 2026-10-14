import type { RoomSettings, TrackerKind } from '@shared/types'
import { Select } from '../../../ui'
import { Row, roomValue } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { useMenuOpen } from './roomMenu'

type Kind = TrackerKind | 'none'

/** The trackers a room can pick, in list order (Jira since KERNEL-474). */
const CHOICES: Kind[] = ['linear', 'github', 'jira', 'none']
const LABEL: Record<Kind, string> = { linear: 'Linear', github: 'GitHub Issues', jira: 'Jira', none: 'None' }
/** What the row says when the room has no `[tracker] kind` and detection decided. */
const DETECTED: Partial<Record<Kind, string>> = {
  linear: 'Detected from your Linear connection.',
  github: 'Detected from the github.com remote.',
  none: 'None detected. Choose one to list issues for this room.'
}

/**
 * Settings > a room > General > Issue tracker (MorePage roomGeneral, KERNEL-680): the room's tracker. `detected` is what Kernel finds
 * without a `[tracker] kind`, and the list marks it. A pick writes the key to the room's personal file, and Reset drops it again.
 */
export function RoomTrackerRow({ roomId, rs, detected }: { roomId: string; rs: RoomSettings; detected: Kind }) {
  const menu = useMenuOpen('roomTracker')
  const chosen = rs.tracker?.kind
  const current = chosen ?? detected
  return (
    <Row
      id="tracker"
      label="Issue tracker"
      desc={chosen ? undefined : DETECTED[detected]}
      {...roomValue(rs, 'tracker.kind', () => void patchRoomSettings(roomId, { tracker: { kind: null } }))}
    >
      <Select
        label="Issue tracker" value={current} align="right" {...menu}
        options={CHOICES.map((kind) => ({ value: kind, label: LABEL[kind], description: kind === detected ? 'Detected' : undefined }))}
        onChange={(v) => { if (v !== current) void patchRoomSettings(roomId, { tracker: { kind: v as Kind } }) }}
      />
    </Row>
  )
}
