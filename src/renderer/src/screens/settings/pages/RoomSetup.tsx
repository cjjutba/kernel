import './rooms.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileToCopy, ProductionHint, Room, RoomSettings, ScriptSuggestion } from '@shared/types'
import { call, cleanError } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { actions, useStore } from '../../../store'
import { Button, Icon, Modal, Select, Toggle, useBusy } from '../../../ui'
import { isOverride, NoRoom, Row, RoomPage, Section, sourceLine, TagList, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { PreviewUrls } from './PreviewUrls'
import { RunMode, RunScripts } from './RunScripts'

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')
const USE_DEFAULT = ''

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
function ProductionBanner({ hints, onSkip, onKeep }: { hints: ProductionHint[]; onSkip: () => Promise<unknown>; onKeep: () => Promise<unknown> }) {
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

/** What the Gitignored files row says about the checkout: how many files match now, or why none do. */
function previewDesc(room: Room, copy: string[], files: FileToCopy[] | null, failed: boolean) {
  if (failed) return 'Could not read the files. Check that the folder is still there, then refresh.'
  if (files === null) return `Looking in ${home(room.path)}`
  if (!files.length) return copy.length ? 'Nothing in the checkout matches the list. Patterns only match files git ignores.' : 'The list is empty.'
  return `${files.length} ${files.length === 1 ? 'file matches' : 'files match'} in ${home(room.path)} right now.`
}

type ScriptKey = 'setup' | 'archive'
const SCRIPT_HELP: Record<ScriptKey, { title: string; placeholder: string; desc: string }> = {
  setup: { title: 'Setup script', placeholder: 'pnpm install', desc: 'Runs when a workspace is created.' },
  archive: { title: 'Archive script', placeholder: 'docker compose down', desc: 'Runs before a workspace is archived.' }
}

/** A workspace script in the one modal shell. Saved in the personal file; an empty script takes the key away. */
function ScriptSheet({ roomId, kind, value, onClose }: { roomId: string; kind: ScriptKey; value: string; onClose: () => void }) {
  const [text, setText] = useState(value)
  const [busy, run] = useBusy<'save'>()
  const { title, placeholder } = SCRIPT_HELP[kind]
  const save = () => run('save', async () => { await patchRoomSettings(roomId, { scripts: { [kind]: text.trim() || null } }); onClose() })
  return (
    <Modal
      title={title} width={560} onClose={onClose}
      footer={<><span className="grow" /><Button variant="ghost" data-dismiss>Cancel</Button><Button variant="primary" busy={busy === 'save'} busyLabel="Saving" disabled={text === value} onClick={() => void save()}>Save</Button></>}
    >
      <div className="modal-body set-form">
        <textarea className="set-lines set-sheet-text rm-script" aria-label={title} placeholder={placeholder} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        {kind === 'setup' && <p className="set-help">Setup can write NAME=value lines to <code>$KERNEL_ENV</code>. Agents, run scripts and terminals in the workspace get them.</p>}
      </div>
    </Modal>
  )
}

/** What Kernel found for the room (`scripts.suggest`, KERNEL-682). Empty until the first answer, and on a failed read. */
function useSuggestions(roomId: string) {
  const [found, setFound] = useState<ScriptSuggestion[]>([])
  useEffect(() => {
    let live = true
    setFound([])
    call('scripts.suggest', { roomId }).then((next) => { if (live) setFound(next) }, () => {})
    return () => { live = false }
  }, [roomId])
  return found
}

const fromLine = (s: ScriptSuggestion) => (s.source === 'detected' ? `Detected from ${s.file}` : `From ${s.file}`)

/** One offered script under an empty field: where it came from, the script in full, and Use, which saves only that script. */
function SuggestionLine({ roomId, kind, suggestion, script }: { roomId: string; kind: ScriptKey; suggestion: ScriptSuggestion; script: string }) {
  const [busy, run] = useBusy<'use'>()
  return (
    <div className="rm-suggest">
      <div className="rm-suggest-head">
        <span className="set-desc">{fromLine(suggestion)}</span>
        <Button aria-label={`Use the suggested ${kind} script`} busy={busy === 'use'} busyLabel="Saving" onClick={() => void run('use', () => patchRoomSettings(roomId, { scripts: { [kind]: script } }))}>Use</Button>
      </div>
      <pre className="rm-suggest-script">{script}</pre>
      {suggestion.notes.map((n) => <span key={n} className="set-desc">{n}</span>)}
    </div>
  )
}

/** Setup and Archive: the first line of each script, and a sheet to edit the whole of it. An empty one offers what `scripts.suggest` found. */
function WorkspaceScripts({ roomId, rs }: { roomId: string; rs: RoomSettings | null }) {
  const [editing, setEditing] = useState<ScriptKey | null>(null)
  const found = useSuggestions(roomId)
  const row = (kind: ScriptKey, label: string) => {
    const value = rs?.scripts[kind] ?? ''
    const first = value.split('\n').find((l) => l.trim())
    const offer = first || !rs ? undefined : found.find((s) => s.patch.scripts?.[kind]?.trim())
    const source = rs?.sources?.[`scripts.${kind}`] === 'local' ? 'From settings.local.toml' : sourceLine(rs, `scripts.${kind}`)
    return (
      <Row setting={kind === 'setup' ? 'scripts.setup' : undefined} label={label} source={source} desc={SCRIPT_HELP[kind].desc} onReset={isOverride(rs, `scripts.${kind}`) ? () => void patchRoomSettings(roomId, { scripts: { [kind]: null } }) : undefined}
        full={offer && <SuggestionLine roomId={roomId} kind={kind} suggestion={offer} script={offer.patch.scripts![kind]!.trim()} />}>
        <span className={['set-value', 'rm-script-line', !first && 'rm-unset'].filter(Boolean).join(' ')}>{first ?? 'Not set'}</span>
        <Button aria-label={`${first ? 'Edit' : 'Add'} the ${label.toLowerCase()} script`} onClick={() => setEditing(kind)}>{first ? 'Edit' : 'Add'}</Button>
      </Row>
    )
  }
  const wait = rs?.workspace.leadWaitForSetup
  const appWait = useStore((x) => x.settings?.workspace.leadWaitForSetup)
  return (
    <>
      <Section title="Workspace scripts" scope="mac">
        {row('setup', 'Setup')}
        {row('archive', 'Archive')}
        <Row setting="workspace.leadWaitForSetup" label="Wait for setup before the first message" onReset={isOverride(rs, 'workspace.leadWaitForSetup') ? () => void patchRoomSettings(roomId, { workspace: { leadWaitForSetup: null } }) : undefined}>
          <Select label="Wait for setup before the first message" align="right" value={wait === undefined ? USE_DEFAULT : wait ? 'on' : 'off'} onChange={(v) => void patchRoomSettings(roomId, { workspace: { leadWaitForSetup: v ? v === 'on' : null } })}
            options={[{ value: USE_DEFAULT, label: `Default (${appWait ? 'On' : 'Off'})` }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
        </Row>
      </Section>
      {editing && <ScriptSheet roomId={roomId} kind={editing} value={rs?.scripts[editing] ?? ''} onClose={() => setEditing(null)} />}
    </>
  )
}

/** Settings > a room > Setup and scripts (MorePage roomSetup, KERNEL-680): everything that gets a new worktree ready. Files to copy, workspace scripts, run scripts, preview URLs. */
export function RoomSetup({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  if (!room || !roomId) return <NoRoom />
  return <SetupPage roomId={roomId} room={room} rs={rs} />
}

function SetupPage({ roomId, room, rs }: { roomId: string; room: Room; rs: RoomSettings | null }) {
  const preview = usePreview(roomId)
  const { files, failed } = preview
  const production = useProduction(roomId)
  const reload = useCallback(async () => { await Promise.all([preview.reload(), production.reload()]) }, [preview.reload, production.reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const copy = rs?.files.copy ?? []
  const exclude = rs?.files.exclude ?? []
  /** Saves go to the personal file. The preview reads the saved list, so it reloads once the save has landed. */
  const save = async (patch: { copy?: string[] | null; exclude?: string[] }) => { const saved = await patchRoomSettings(roomId, { files: patch }); void reload(); return saved }
  const reset = (key: 'copy' | 'symlinkNodeModules') => (isOverride(rs, `files.${key}`) ? () => void (key === 'copy' ? save({ copy: null }) : patchRoomSettings(roomId, { files: { [key]: null } })) : undefined)
  const skip = () => save({ exclude: [...new Set([...exclude, ...production.hints.map((h) => h.path)])] })
  const keep = async () => {
    try { await call('files.keepCopying', { roomId, hints: production.hints }) } catch (e) { actions.ui.toast({ title: 'Could not save the choice', sub: cleanError(e) }) }
    await production.reload()
  }
  return (
    <RoomPage room={room} rs={rs} title="Setup and scripts">
      {production.hints.length > 0 && <ProductionBanner hints={production.hints} onSkip={skip} onKeep={keep} />}
      <Section title="Files to copy" scope="mac" footnote={<><code>*</code> and <code>**</code> don’t match dot files. A pattern only reaches inside an ignored folder when it names that folder, like <code>certs/*.pem</code>.</>}>
        <Row setting="files.copy" label="Gitignored files" source={sourceLine(rs, 'files.copy')} desc={previewDesc(room, copy, files, failed)} onReset={reset('copy')}
          full={
            <>
              <TagList label="Files to copy" value={copy} addLabel="Add pattern" placeholder="certs/*.pem" onChange={(next) => save({ copy: next })} />
              {!!files?.length && <ul className="set-preview rm-files" tabIndex={0} aria-label="Files that will be copied">{files.map((f) => <li key={f.path}><FileLabel path={f.path} /></li>)}</ul>}
            </>
          } />
        {exclude.length > 0 && (
          <Row setting="files.exclude" label="Never copied" desc="Skipped even when a pattern above matches." full={<TagList label="Files never copied" value={exclude} addLabel="Add file" onChange={(next) => save({ exclude: next })} />} />
        )}
        <Row setting="files.symlinkNodeModules" label="Symlink node_modules" source={sourceLine(rs, 'files.symlinkNodeModules')} desc="Faster setup. Workspaces share dependencies." onReset={reset('symlinkNodeModules')}>
          <Toggle label="Symlink node_modules" checked={!!rs?.files.symlinkNodeModules} onChange={(v) => void patchRoomSettings(roomId, { files: { symlinkNodeModules: v } })} />
        </Row>
      </Section>
      <WorkspaceScripts roomId={roomId} rs={rs} />
      <RunScripts roomId={roomId} rs={rs} />
      <RunMode roomId={roomId} rs={rs} />
      <PreviewUrls roomId={roomId} rs={rs} />
    </RoomPage>
  )
}
