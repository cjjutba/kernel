import './agents.css'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { KERNEL_VARS, SCRIPT_VARS, SETUP_VARS } from '@shared/kernelVars'
import type { Room, RoomSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { actions, getState } from '../../../store'
import { Button, ConfirmDialog, Modal, useBusy } from '../../../ui'
import { appliesTo, DataTable, isOverride, NoRoom, Page, RoomPage, Section, useRoomPage, type TableRow } from '../kit'
import { RowMenu } from './RowMenu'
import { envChanged, useEnv, type EnvList } from '../env'
import { patchRoomSettings } from '../useSettings'

/** Settings > Environment, and a room's Environment page (AgentsPage.dc.html, KERNEL-680). One page serves both. */
export function Environment({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const { env, error } = useEnv(roomId)
  if (roomId && !room) return <NoRoom />
  const add = (primary: boolean) => <Button variant={primary ? 'primary' : 'secondary'} icon="plus" onClick={() => actions.ui.openModal({ name: 'envVar', roomId })}>Add variable</Button>
  const sections = (
    <>
      <Variables roomId={roomId} room={room} env={env} error={error} action={room ? add(false) : undefined} />
      {room && roomId && <EnvFiles roomId={roomId} rs={rs} env={env} />}
      {!room && <KernelVars />}
    </>
  )
  return room
    ? <RoomPage room={room} rs={rs} title="Environment">{sections}</RoomPage>
    : <Page title="Environment" action={add(true)}>{sections}</Page>
}

/**
 * Your variables as a table: the name, the value as a fixed run of dots, Show on hover and a menu with Edit and Remove. Show asks main for
 * the value, which lives only in this component's state while it is on screen. It hides again on a second press, or when focus leaves the row.
 */
function Variables({ roomId, room, env, error, action }: { roomId?: string; room?: Room; env: EnvList | null; error: string | null; action?: ReactNode }) {
  const [removing, setRemoving] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [busy, run] = useBusy<string>()
  // A hide that lands while a reveal is in flight cancels it, so a late answer never shows a value the user moved away from.
  const request = useRef<Record<string, number>>({})
  if (error) return <Section title="Variables" action={action}><div className="set-empty" role="alert">Could not read the variables. {error}</div></Section>
  if (!env) return null
  const hide = (name: string) => { request.current[name] = (request.current[name] ?? 0) + 1; setRevealed(({ [name]: _gone, ...rest }) => rest) }
  const show = (name: string) => run(`show:${name}`, async () => {
    const mine = (request.current[name] = (request.current[name] ?? 0) + 1)
    try {
      const v = await call('env.reveal', { roomId, name })
      if (mine === request.current[name]) setRevealed((r) => ({ ...r, [name]: v }))
    } catch (e) {
      if (mine === request.current[name]) actions.ui.toast({ title: `Could not show ${name}`, sub: cleanError(e) })
    }
  })
  const remove = (name: string) => run('remove', async () => {
    try {
      await call('env.set', { roomId, name, value: null })
      await envChanged()
    } catch (e) {
      actions.ui.toast({ title: `Could not remove ${name}`, sub: cleanError(e) })
    }
    setRemoving(null)
  })
  const rows: TableRow[] = env.names.map((name) => {
    const value = revealed[name]
    const shown = value !== undefined
    return {
      key: name,
      cells: [
        <span className="mono">{name}</span>,
        shown ? <span className="ag-value">{value}</span> : <span className="ag-mask" role="img" aria-label="Value hidden">{'•'.repeat(12)}</span>
      ],
      actions: <>
        <Button variant="ghost" aria-label={busy === `show:${name}` ? `Showing ${name}` : `${shown ? 'Hide' : 'Show'} ${name}`} busy={busy === `show:${name}`} busyLabel="Showing" onClick={() => (shown ? hide(name) : void show(name))}>{shown ? 'Hide' : 'Show'}</Button>
        <RowMenu label={`More for ${name}`} items={[
          { id: 'edit', label: 'Edit', icon: 'pen', onSelect: () => actions.ui.openModal({ name: 'envVar', roomId, editName: name }) },
          { id: 'remove', label: 'Remove', icon: 'trash', danger: true, onSelect: () => setRemoving(name) }
        ]} />
      </>
    }
  })
  return (
    <Section title="Variables" count={env.names.length} action={action} plain>
      <DataTable label="Variables" columns={['Name', 'Value']} grid="minmax(0, 220px) minmax(0, 1fr)" rows={rows} empty="No variables yet. Add one and chats and scripts started afterwards get it." />
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing}?`}
          body={`${room ? `Chats and scripts in ${room.name}` : 'Chats and scripts in every room'} stop getting ${removing} once they start afterwards. The ones already running keep it.`}
          confirmLabel="Remove" danger busy={busy === 'remove'} busyPattern="scatter" busyLabel="Removing"
          onConfirm={() => void remove(removing)} onCancel={() => setRemoving(null)}
        />
      )}
    </Section>
  )
}

/**
 * The room's env files. The list is saved whole in the personal file, so Remove works on files settings.toml set too. Each save is
 * built from the saved list as it is now, and the page waits for the list to reload before another can start, so two quick Removes
 * can't bring a file back.
 */
function EnvFiles({ roomId, rs, env }: { roomId: string; rs: RoomSettings | null; env: EnvList | null }) {
  const [adding, setAdding] = useState(false)
  const [busy, run] = useBusy()
  const files = env?.files ?? []
  const path = 'env.files'
  const latest = () => getState().roomSettings[roomId]?.env?.files ?? files.map((f) => f.path)
  const save = (key: string, next: () => string[] | null) => run(key, async () => {
    await patchRoomSettings(roomId, { env: { files: next() } })
    await envChanged()
  })
  // The list is one value, so its source shows once, under the table. Reset only shows for a list that overrides settings.toml:
  // a list that lives only in the personal file can be emptied with Remove, so Reset adds nothing there.
  const rows: TableRow[] = files.map((f) => ({
    key: f.path,
    cells: [<span className="mono"><FileLabel path={f.path} /></span>, f.missing ? 'Missing' : ''],
    actions: <Button variant="ghost" aria-label={`Remove ${f.path}`} busy={busy === `remove:${f.path}`} busyPattern="scatter" busyLabel="Removing" disabled={busy !== null} onClick={() => void save(`remove:${f.path}`, () => latest().filter((p) => p !== f.path))}>Remove</Button>
  }))
  const source = isOverride(rs, path) ? 'Changed for this room' : undefined
  return (
    <>
      <Section
        title="Env files" count={files.length} plain
        action={<>
          {rs?.sources?.[path] === 'override' && <Button variant="ghost" aria-label="Reset env files" busy={busy === 'reset'} busyLabel="Resetting" disabled={busy !== null} onClick={() => void save('reset', () => null)}>Reset</Button>}
          <Button icon="plus" disabled={!env || busy !== null} onClick={() => setAdding(true)}>Add env file</Button>
        </>}
        note="Read in this order. A later file wins, and a missing file is skipped."
        footnote={[source, appliesTo('env.files')].filter(Boolean).join('. ')}
      >
        <DataTable label="Env files" columns={['File', 'Status']} grid="minmax(0, 1fr) 120px" rows={rows} empty="No env files. Add one, like .env, and its variables reach every chat and script." />
      </Section>
      {adding && <EnvFileForm paths={files.map((f) => f.path)} onSave={(added) => save('add', () => [...latest(), added])} onClose={() => setAdding(false)} />}
    </>
  )
}

/** What is wrong with an env file path, or undefined. The engine only reads a file inside the workspace folder (KERNEL-247). */
export function pathProblem(path: string, taken: string[]): string | undefined {
  if (!path) return 'Enter the path of the file.'
  if (path.startsWith('/') || path.split('/').includes('..')) return 'Use a path inside the workspace folder, like .env or src/backend/.env.'
  if (taken.includes(path)) return `${path} is already in the list.`
  return undefined
}

function EnvFileForm({ paths, onSave, onClose }: { paths: string[]; onSave: (added: string) => Promise<void>; onClose: () => void }) {
  const id = useId()
  const [path, setPath] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, run] = useBusy<'save'>()
  const problem = pathProblem(path, paths)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setShown(true)
    if (problem) return
    void run('save', async () => { await onSave(path); onClose() })
  }
  return (
    <Modal
      title="Add env file"
      onClose={onClose}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" size="lg" data-dismiss>Cancel</Button>
        <Button variant="primary" size="lg" type="submit" form={`${id}-form`} busy={busy === 'save'} busyLabel="Adding">Add</Button>
      </>}
    >
      <form id={`${id}-form`} className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">Saved in settings.local.toml, so it stays on your Mac. A file that is not there yet is skipped until it is.</p>
        <div className="set-field">
          <label htmlFor={`${id}-path`}>Path</label>
          <input id={`${id}-path`} className="input" autoComplete="off" spellCheck={false} placeholder=".env" value={path} aria-invalid={shown && !!problem} aria-describedby={`${id}-note`} onChange={(e) => setPath(e.target.value.trim())} />
          {shown && problem
            ? <span id={`${id}-note`} role="alert" className="set-error">{problem}</span>
            : <span id={`${id}-note`} className="set-help">Relative to each workspace folder, so a worktree reads its own copy.</span>}
        </div>
      </form>
    </Modal>
  )
}

/** "Kernel's variables": every chat, script and big terminal tab gets them, and a variable can't take one of their names. Folded by default. */
function KernelVars() {
  const rows = [...Object.entries(KERNEL_VARS), ...Object.entries(SCRIPT_VARS).map(([n, d]) => [n, `${d} Scripts only.`] as const), ...Object.entries(SETUP_VARS).map(([n, d]) => [n, `${d} Setup only.`] as const)]
  return (
    <Section title="Kernel's variables" count={rows.length} note="Set in every chat, script and terminal. Read only." collapsible>
      {rows.map(([name, desc]) => <div key={name} className="ag-kernel"><code>{name}</code><span>{desc}</span></div>)}
    </Section>
  )
}
