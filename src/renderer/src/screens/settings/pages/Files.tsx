import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileToCopy, Room } from '@shared/types'
import { call } from '../../../api'
import { Button, Toggle, useBusy } from '../../../ui'
import { isOverride, LinesField, NoRoom, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/**
 * What a new worktree of the room gets, from `files.preview` (the same resolver the copy uses). It loads when the page opens,
 * and `reload` runs it again: Refresh calls it, and so does saving the list. `files` is null until the first answer.
 */
function usePreview(roomId: string) {
  const [files, setFiles] = useState<FileToCopy[] | null>(null)
  const [failed, setFailed] = useState(false)
  const latest = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++latest.current
    try {
      const next = await call('files.preview', { roomId })
      if (mine === latest.current) { setFiles(next); setFailed(false) }
    } catch {
      if (mine === latest.current) setFailed(true)
    }
  }, [roomId])
  useEffect(() => { setFiles(null); void reload() }, [reload])
  return { files, failed, reload }
}

function Preview({ room, copy, files, failed, reload }: { room: Room; copy: string[]; files: FileToCopy[] | null; failed: boolean; reload: () => Promise<void> }) {
  const [busy, run] = useBusy()
  const from = <span className="set-value">{home(room.path)}</span>
  const none = files?.length === 0
  const label = files === null ? (failed ? 'Could not read the files in' : 'Looking in') : none ? 'No files will be copied from' : `${files.length} ${files.length === 1 ? 'file' : 'files'} will be copied from`
  const desc = failed ? 'Check that the folder is still there, then refresh.' : none ? (copy.length ? 'Nothing in the checkout matches the list. Patterns only match files git ignores.' : 'The list is empty.') : undefined
  return (
    <Row label={<>{label} {from}</>} desc={desc} full={files?.length ? <ul className="set-preview" tabIndex={0} aria-label="Files that will be copied">{files.map((f) => <li key={f.path}>{f.path}</li>)}</ul> : undefined}>
      <Button busy={busy === 'refresh'} busyLabel="Refreshing" onClick={() => void run('refresh', reload)}>Refresh</Button>
    </Row>
  )
}

/** Settings > a room > Files to copy (SettingsFiles.png). What a new worktree of this room gets from the checkout. */
export function Files({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  if (!room || !roomId) return <NoRoom />
  return <FilesPage roomId={roomId} room={room} rs={rs} />
}

function FilesPage({ roomId, room, rs }: { roomId: string; room: Room; rs: ReturnType<typeof useRoomPage>['rs'] }) {
  const { files, failed, reload } = usePreview(roomId)
  const copy = rs?.files.copy ?? []
  /** Saves go to the personal file. The preview reads the saved list, so it reloads once the save has landed. */
  const save = async (patch: { copy: string[] | null }) => { await patchRoomSettings(roomId, { files: patch }); void reload() }
  const reset = (key: 'copy' | 'symlinkNodeModules') => (isOverride(rs, `files.${key}`) ? () => void (key === 'copy' ? save({ copy: null }) : patchRoomSettings(roomId, { files: { [key]: null } })) : undefined)
  return (
    <RoomPage room={room} rs={rs} title="Files to copy" intro={`Gitignored files that ${room.name} copies into every new worktree.`}>
      <Section title="Gitignored files">
        <Row label="Copy into every new worktree" source={sourceLine(rs, 'files.copy')} onReset={reset('copy')} full={
          <>
            <LinesField label="Files to copy" value={copy} onSave={(lines) => void save({ copy: lines })} />
            <p className="set-hint"><code>*</code> and <code>**</code> don’t match dot files. A pattern only reaches inside an ignored folder when it names that folder, like <code>certs/*.pem</code>.</p>
          </>
        } />
        {rs && <Preview room={room} copy={copy} files={files} failed={failed} reload={reload} />}
        <Row label="Symlink node_modules" source={sourceLine(rs, 'files.symlinkNodeModules')} desc="Faster setup, but workspaces share dependencies" onReset={reset('symlinkNodeModules')}>
          <Toggle label="Symlink node_modules" checked={!!rs?.files.symlinkNodeModules} onChange={(v) => void patchRoomSettings(roomId, { files: { symlinkNodeModules: v } })} />
        </Row>
      </Section>
    </RoomPage>
  )
}
