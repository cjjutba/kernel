import { useRef } from 'react'
import type { Room } from '@shared/types'
import { call } from '../../../api'
import { RoomIcon } from '../../../components/RoomIcon'
import { actions, useStore } from '../../../store'
import { Icon, Menu, useBusy, type MenuEntry } from '../../../ui'
import { roomLetter } from '../../rooms/roomInfo'
import { Row } from '../kit'

type Kind = 'letter' | 'github' | 'image'

const LABEL: Record<Kind, string> = { letter: 'Letter', github: 'GitHub avatar', image: 'Image' }
const BUSY: Record<Kind, string> = { letter: 'Saving', github: 'Getting avatar', image: 'Saving' }
const reason = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Settings > a room > General > Icon (SettingsRoom.png, SettingsRoomIcon.png): the room's letter, its GitHub avatar or a picked image. */
export function RoomIconRow({ room }: { room: Room }) {
  const open = useStore((s) => s.ui.menu === 'roomIcon')
  const anchor = useRef<HTMLDivElement>(null)
  const [busy, run] = useBusy<Kind>()
  const kind: Kind = room.icon?.kind ?? 'letter'
  // The avatar comes from the room's GitHub owner, so a room with no GitHub repo can't ask for one. One that already has it keeps the entry.
  const github = !!room.repo || kind === 'github'

  const choose = (next: Kind) => void run(next, async () => {
    try {
      // The picker answers null when it is cancelled, which changes nothing.
      const path = next === 'image' ? await call('system.pickImage', undefined) : null
      if (next === 'image' && !path) return
      const saved = await call('rooms.setIcon', { roomId: room.id, icon: next === 'image' ? { kind: 'image', path: path! } : { kind: next } })
      actions.rooms.upsert(saved)
    } catch (e) {
      // The engine leaves the room as it was, so the letter or the old image stays.
      actions.ui.toast({ title: 'Could not change the icon', sub: reason(e) })
    }
  })

  const tile = (child: React.ReactNode) => <span className="set-icon-mini" aria-hidden="true">{child}</span>
  const entries: MenuEntry[] = [
    { id: 'letter', label: 'Letter', leading: tile(roomLetter(room.name)), checked: kind === 'letter', onSelect: () => choose('letter') },
    ...(github ? [{ id: 'github', label: 'GitHub avatar', leading: kind === 'github' ? <RoomIcon room={room} className="set-icon-mini" /> : tile(<Icon name="user" size={11} />), checked: kind === 'github', onSelect: () => choose('github') }] : []),
    { id: 'image', label: 'Choose image', leading: kind === 'image' ? <RoomIcon room={room} className="set-icon-mini" /> : tile(<Icon name="image" size={12} />), checked: kind === 'image', onSelect: () => choose('image') }
  ]

  return (
    <Row label="Icon" desc="Shown next to the room in the sidebar and on its chats">
      <div className="set-icon" ref={anchor}>
        <RoomIcon room={room} className="set-icon-tile" />
        <button type="button" className="set-icon-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`Room icon: ${LABEL[kind]}`} aria-busy={busy ? true : undefined} disabled={busy !== null} onClick={() => actions.ui.toggleMenu('roomIcon')}>
          {busy ? <><span className="spin" aria-hidden="true" />{BUSY[busy]}</> : <>{LABEL[kind]}<Icon name="chevron" size={10} stroke={1.9} /></>}
        </button>
        {open && <Menu label="Room icon" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 36, width: 224 }} items={entries} />}
      </div>
    </Row>
  )
}
