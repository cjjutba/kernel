import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileToCopy, ProductionHint, Room } from '@shared/types'
import { call, cleanError } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { actions } from '../../../store'
import { Button, Icon, Toggle, useBusy } from '../../../ui'
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

/** The files to copy that look like production, from `files.production`. Empty until the first answer, and on a failed read. */
function useProduction(roomId: string) {
  const [hints, setHints] = useState<ProductionHint[]>([])
  const latest = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++latest.current
    const next = await call('files.production', { roomId }).catch(() => [])
    if (mine === latest.current) setHints(next)
  }, [roomId])
  useEffect(() => { setHints([]); void reload() }, [reload])
  return { hints, reload }
}

const WHY: Record<ProductionHint['why'], string> = {
  'live-key': ' is a live key',
  'remote-database': ' points to a remote database',
  production: ' is set to production'
}

/**
 * SettingsFilesProduction.png: each file that looks like production and the variable that gave it away, never its value
 * (KERNEL-449). Don't copy these files adds them to the room's exclusions. Keep copying remembers them for the room.
 */
function ProductionBanner({ hints, onSkip, onKeep }: { hints: ProductionHint[]; onSkip: () => Promise<void>; onKeep: () => Promise<void> }) {
  const [busy, run] = useBusy<'skip' | 'keep'>()
  const title = `${hints.length} ${hints.length === 1 ? 'file looks' : 'files look'} like production`
  return (
    <div className="card set-banner" role="group" aria-label={title}>
      <Icon name="warning" size={16} />
      <div className="set-banner-body">
        <div className="set-banner-text">
          <span className="set-banner-title">{title}</span>
          <span className="set-banner-detail">Agents run commands in every worktree, so a migration or seed script there could reach a live database.</span>
        </div>
        <ul className="set-banner-files">
          {hints.map((h) => <li key={h.path}><span className="set-banner-file">{h.path}</span><span><code>{h.name}</code>{WHY[h.why]}</span></li>)}
        </ul>
        <div className="set-banner-acts">
          <Button busy={busy === 'skip'} busyLabel="Saving" disabled={busy !== null} onClick={() => void run('skip', onSkip)}>Don’t copy these files</Button>
          <Button variant="ghost" busy={busy === 'keep'} busyLabel="Saving" disabled={busy !== null} onClick={() => void run('keep', onKeep)}>Keep copying</Button>
        </div>
      </div>
    </div>
  )
}

function Preview({ room, copy, files, failed, reload }: { room: Room; copy: string[]; files: FileToCopy[] | null; failed: boolean; reload: () => Promise<void> }) {
  const [busy, run] = useBusy()
  const from = <span className="set-value">{home(room.path)}</span>
  const none = files?.length === 0
  const label = files === null ? (failed ? 'Could not read the files in' : 'Looking in') : none ? 'No files will be copied from' : `${files.length} ${files.length === 1 ? 'file' : 'files'} will be copied from`
  const desc = failed ? 'Check that the folder is still there, then refresh.' : none ? (copy.length ? 'Nothing in the checkout matches the list. Patterns only match files git ignores.' : 'The list is empty.') : undefined
  return (
    <Row label={<>{label} {from}</>} desc={desc} full={files?.length ? <ul className="set-preview" tabIndex={0} aria-label="Files that will be copied">{files.map((f) => <li key={f.path}><FileLabel path={f.path} /></li>)}</ul> : undefined}>
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
  const preview = usePreview(roomId)
  const { files, failed } = preview
  const production = useProduction(roomId)
  const reload = useCallback(async () => { await Promise.all([preview.reload(), production.reload()]) }, [preview.reload, production.reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const copy = rs?.files.copy ?? []
  /** Saves go to the personal file. The preview reads the saved list, so it reloads once the save has landed. */
  const save = async (patch: { copy?: string[] | null; exclude?: string[] }) => { await patchRoomSettings(roomId, { files: patch }); void reload() }
  const reset = (key: 'copy' | 'symlinkNodeModules') => (isOverride(rs, `files.${key}`) ? () => void (key === 'copy' ? save({ copy: null }) : patchRoomSettings(roomId, { files: { [key]: null } })) : undefined)
  const skip = () => save({ exclude: [...new Set([...(rs?.files.exclude ?? []), ...production.hints.map((h) => h.path)])] })
  const keep = async () => {
    try { await call('files.keepCopying', { roomId, hints: production.hints }) } catch (e) { actions.ui.toast({ title: 'Could not save the choice', sub: cleanError(e) }) }
    await production.reload()
  }
  return (
    <RoomPage room={room} rs={rs} title="Files to copy" intro={`Gitignored files that ${room.name} copies into every new worktree.`}>
      {production.hints.length > 0 && <ProductionBanner hints={production.hints} onSkip={skip} onKeep={keep} />}
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
