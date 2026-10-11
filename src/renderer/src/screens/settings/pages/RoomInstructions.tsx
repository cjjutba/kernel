import { useState } from 'react'
import type { AppSettings, PrInstructions } from '@shared/types'
import { Icon } from '../../../ui'
import { isOverride, NoRoom, Row, RoomPage, Section, sourceLine, TextField, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

const ROWS: { key: keyof PrInstructions; label: string; desc: string }[] = [
  { key: 'createInstructions', label: 'Create PR', desc: 'Sent when you press Create PR' },
  { key: 'resolveInstructions', label: 'Resolve conflicts', desc: 'Sent when you press Resolve conflicts' },
  { key: 'fixChecksInstructions', label: 'Fix checks', desc: 'Sent when you press Fix checks' },
  { key: 'addressReviewInstructions', label: 'Address review', desc: 'Sent when you press Address review' }
]

/** Settings > a room > Instructions (SettingsRoomInstructions.png). Each row shows the app's text until the room overrides it. */
export function RoomInstructions({ roomId, s }: { roomId?: string; s: AppSettings }) {
  const { room, rs } = useRoomPage(roomId)
  // A row opens by itself while the room overrides it, until you open or close it.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  if (!room || !roomId) return <NoRoom />
  const save = (key: keyof PrInstructions, text: string) => void patchRoomSettings(roomId, { pr: { [key]: text.trim() ? text : null } })
  return (
    <RoomPage room={room} rs={rs} title="Instructions" intro={`What agents are told in ${room.name}. A row you leave alone uses the text from Settings, Pull requests.`}>
      <Section title="Instructions">
        {ROWS.map(({ key, label, desc }) => {
          const path = `pr.${key}`
          const set = isOverride(rs, path)
          const open = toggled[key] ?? set
          const source = sourceLine(rs, path)
          return (
            <Row key={key} label={label} source={source} desc={source ? undefined : desc}
              onReset={set ? () => { setToggled((t) => ({ ...t, [key]: open })); void patchRoomSettings(roomId, { pr: { [key]: null } }) } : undefined}
              full={open && <TextField label={`${label} instructions`} value={rs?.pr?.[key] ?? s.pr[key]} onSave={(text) => save(key, text)} />}>
              <button type="button" className="set-disclose" aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} aria-expanded={open} onClick={() => setToggled((t) => ({ ...t, [key]: !open }))}><Icon name="chevron" size={10} stroke={1.9} /></button>
            </Row>
          )
        })}
      </Section>
    </RoomPage>
  )
}
