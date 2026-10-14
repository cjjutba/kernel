import type { RoomSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, getState } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { appliesTo, DataTable, SaveNote, Section, useSaveNote, type TableRow } from '../kit'
import { patchRoomSettings } from '../useSettings'

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/**
 * The room's reference folders (KERNEL-750): folders outside the repo that its agents may read and @ searches, never change.
 * Saved in the personal file, since the paths differ per Mac. A folder that is no longer there is listed as Missing and skipped.
 */
export function RoomReferences({ roomId, rs }: { roomId: string; rs: RoomSettings }) {
  const [busy, run] = useBusy()
  const note = useSaveNote()
  const folders = rs.references ?? []
  const missing = rs.missingReferences ?? []
  const latest = () => getState().roomSettings[roomId]?.references ?? folders
  const choose = () => run('add', async () => {
    let picked: string | null
    try { picked = await call('system.pickFolder', undefined) } catch (e) { return void actions.ui.toast({ title: 'Could not open the folder picker', sub: cleanError(e) }) }
    if (!picked) return
    const path = picked.replace(/\/+$/, '') || '/'
    const list = latest()
    if (list.includes(path)) return void actions.ui.toast({ title: 'Already a reference folder', sub: home(path) })
    await note.track(patchRoomSettings(roomId, { references: [...list, path] }))
  })
  const remove = (path: string) => run(`remove:${path}`, async () => {
    const list = latest().filter((p) => p !== path)
    await note.track(patchRoomSettings(roomId, { references: list.length ? list : null }))
  })
  const rows: TableRow[] = folders.map((path) => ({
    key: path,
    cells: [<span className="mono" title={path}>{home(path)}</span>, missing.includes(path) ? 'Missing' : ''],
    actions: <Button variant="ghost" aria-label={`Remove ${home(path)}`} busy={busy === `remove:${path}`} busyLabel="Removing" disabled={busy !== null} onClick={() => void remove(path)}>Remove</Button>
  }))
  return (
    <Section
      title="Reference folders" count={folders.length || undefined} plain
      action={<>
        <SaveNote state={note.state} />
        <Button icon="plus" busy={busy === 'add'} busyLabel="Adding" disabled={busy !== null} onClick={() => void choose()}>Add folder</Button>
      </>}
      note="Agents can read these folders and @ finds their files. They can’t change them."
      footnote={['Saved in settings.local.toml, so it stays on your Mac. A folder that is not there is skipped until it is', appliesTo('references', roomId)].filter(Boolean).join('. ')}
    >
      <DataTable label="Reference folders" columns={['Folder', 'Status']} grid="minmax(0, 1fr) 120px" rows={rows} empty="No reference folders. Add a folder next to this project, like a backend, and agents can read it." />
    </Section>
  )
}
