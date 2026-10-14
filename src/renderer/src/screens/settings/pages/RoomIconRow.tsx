import type { KernelApi } from '@shared/ipc'
import type { Room } from '@shared/types'
import { call, cleanError } from '../../../api'
import { RoomIcon } from '../../../components/RoomIcon'
import { actions } from '../../../store'
import { Select, useBusy } from '../../../ui'
import { Row } from '../kit'
import { useMenuOpen } from './roomMenu'

type Kind = 'letter' | 'github' | 'image'

const LABEL: Record<Kind, string> = { letter: 'Letter', github: 'GitHub avatar', image: 'Image' }

/** Settings > a room > General > Icon (MorePage roomGeneral, KERNEL-680): the room's letter, its GitHub avatar or a picked image. Choose image opens the file dialog. */
export function RoomIconRow({ room }: { room: Room }) {
  const menu = useMenuOpen('roomIcon')
  const [busy, run] = useBusy<Kind>()
  const kind: Kind = room.icon?.kind ?? 'letter'
  // The avatar comes from the room's GitHub owner, so a room with no GitHub repo can't ask for one. One that already has it keeps the entry.
  const github = !!room.repo || kind === 'github'

  const fail = (e: unknown) => actions.ui.toast({ title: 'Could not change the icon', sub: cleanError(e) })
  const save = (next: Kind, icon: KernelApi['rooms.setIcon']['req']['icon']) => void run(next, async () => {
    try {
      actions.rooms.upsert(await call('rooms.setIcon', { roomId: room.id, icon }))
    } catch (e) {
      // The engine leaves the room as it was, so the letter or the old image stays.
      fail(e)
    }
  })
  const pick = (next: Kind) => { if (next !== kind) save(next, { kind: next } as KernelApi['rooms.setIcon']['req']['icon']) }
  const chooseImage = async () => {
    // The file dialog opens before the busy state starts, so the control doesn't look busy while it is up. Cancelling returns null.
    let path: string | null
    try { path = await call('system.pickImage', undefined) } catch (e) { return fail(e) }
    if (path) save('image', { kind: 'image', path })
  }
  const options = [
    { value: 'letter', label: LABEL.letter },
    ...(github ? [{ value: 'github', label: LABEL.github }] : []),
    ...(kind === 'image' ? [{ value: 'image', label: LABEL.image }] : [])
  ]
  return (
    <Row id="icon" label="Icon" desc="Shown in the sidebar and on the room’s chats." lead={<RoomIcon room={room} className="set-icon-tile" />}>
      <Select label="Room icon" value={kind} options={options} disabled={busy !== null} align="right" onChange={(v) => pick(v as Kind)} actions={[{ label: 'Choose image…', icon: 'image', onSelect: () => void chooseImage() }]} {...menu} />
    </Row>
  )
}
