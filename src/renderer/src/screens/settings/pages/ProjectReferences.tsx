import type { ProjectSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, getState } from '../../../store'
import { Button, IconButton, useBusy } from '../../../ui'
import { Row, SaveNote, useSaveNote } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { SourcePill } from './projectSource'

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/**
 * The project's reference folders (KERNEL-750): folders outside the repo that its agents may read and @ searches, never change. It is a row in the
 * Project card, with each folder beside Add folder. Saved in the personal file, since the paths differ per Mac. A folder that is no longer there
 * says Missing and is skipped.
 */
export function ProjectReferences({ projectId, rs }: { projectId: string; rs: ProjectSettings }) {
  const [busy, run] = useBusy()
  const note = useSaveNote()
  const folders = rs.references ?? []
  const missing = rs.missingReferences ?? []
  const latest = () => getState().projectSettings[projectId]?.references ?? folders
  const choose = () => run('add', async () => {
    let picked: string | null
    try { picked = await call('system.pickFolder', undefined) } catch (e) { return void actions.ui.toast({ title: 'Could not open the folder picker', sub: cleanError(e) }) }
    if (!picked) return
    const path = picked.replace(/\/+$/, '') || '/'
    const list = latest()
    if (list.includes(path)) return void actions.ui.toast({ title: 'Already a reference folder', sub: home(path) })
    await note.track(patchProjectSettings(projectId, { references: [...list, path] }))
  })
  const remove = (path: string) => run(`remove:${path}`, async () => {
    const list = latest().filter((p) => p !== path)
    await note.track(patchProjectSettings(projectId, { references: list.length ? list : null }))
  })
  return (
    <Row
      id="references"
      setting="references"
      label={<>Reference folders<SourcePill>Your file</SourcePill></>}
      desc={folders.length ? 'Agents can read these folders and @ finds their files. They can’t change them.' : 'Folders agents can read but not change, like a design system or docs.'}
    >
      {folders.length > 0 && (
        <ul className="rm-folders" aria-label="Reference folders">
          {folders.map((path) => (
            <li key={path} className="rm-folder">
              <span className="rm-folder-path" title={path}>{home(path)}</span>
              {missing.includes(path) && <span className="rm-folder-missing">Missing</span>}
              <IconButton icon="close" size={12} box="xs" label={`Remove ${home(path)}`} busy={busy === `remove:${path}`} busyLabel="Removing" disabled={busy !== null} onClick={() => void remove(path)} />
            </li>
          ))}
        </ul>
      )}
      <SaveNote state={note.state} />
      <Button icon="plus" busy={busy === 'add'} busyLabel="Adding" disabled={busy !== null} onClick={() => void choose()}>Add folder</Button>
    </Row>
  )
}
