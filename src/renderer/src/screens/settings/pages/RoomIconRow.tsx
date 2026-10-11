import { useRef } from 'react'
import type { KernelApi } from '@shared/ipc'
import type { Room } from '@shared/types'
import { call } from '../../../api'
import { RoomIcon } from '../../../components/RoomIcon'
import { actions, useStore } from '../../../store'
import { Button, Icon, Menu, useBusy, type MenuEntry } from '../../../ui'
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

  const fail = (e: unknown) => actions.ui.toast({ title: 'Could not change the icon', sub: reason(e) })
  const save = (next: Kind, icon: KernelApi['rooms.setIcon']['req']['icon']) => void run(next, async () => {
    try {
      actions.rooms.upsert(await call('rooms.setIcon', { roomId: room.id, icon }))
    } catch (e) {
      // The engine leaves the room as it was, so the letter or the old image stays.
      fail(e)
    }
  })
  const choose = async (next: Kind) => {
    if (next === 'letter' && kind === 'letter') return
    if (next !== 'image') return save(next, { kind: next })
    // The file dialog opens before the busy state starts, so the button doesn't say "Saving" while it is up. Cancelling returns null.
    let path: string | null
    try { path = await call('system.pickImage', undefined) } catch (e) { return fail(e) }
    if (path) save('image', { kind: 'image', path })
  }

  const tile = (child: React.ReactNode) => <span className="set-icon-mini" aria-hidden="true">{child}</span>
  const entries: MenuEntry[] = [
    { id: 'letter', label: 'Letter', leading: tile(roomLetter(room.name)), checked: kind === 'letter', onSelect: () => void choose('letter') },
    ...(github ? [{ id: 'github', label: 'GitHub avatar', leading: kind === 'github' ? <RoomIcon room={room} className="set-icon-mini" /> : tile(<Icon name="user" size={11} />), checked: kind === 'github', onSelect: () => void choose('github') }] : []),
    { id: 'image', label: 'Choose image', leading: kind === 'image' ? <RoomIcon room={room} className="set-icon-mini" /> : tile(<Icon name="image" size={12} />), checked: kind === 'image', onSelect: () => void choose('image') }
  ]

  return (
    <Row label="Icon" desc="Shown next to the room in the sidebar and on its chats">
      <div className="set-icon" ref={anchor}>
        <RoomIcon room={room} className="set-icon-tile" />
        <Button className="set-icon-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={busy ? BUSY[busy] : `Room icon: ${LABEL[kind]}`} busy={busy !== null} busyLabel={busy ? BUSY[busy] : undefined} onClick={() => actions.ui.toggleMenu('roomIcon')}>
          {LABEL[kind]}<Icon name="chevron" size={10} stroke={1.9} />
        </Button>
        {open && <Menu label="Room icon" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 36, width: 224 }} items={entries} />}
      </div>
    </Row>
  )
}
