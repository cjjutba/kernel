import { useId, useRef, useState, type FormEvent } from 'react'
import { KERNEL_VARS, SCRIPT_VARS } from '@shared/kernelVars'
import type { Room, RoomSettings } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { Button, ConfirmDialog, Icon, Modal, useBusy } from '../../../ui'
import { NoRoom, Page, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'
import { envChanged, useEnv, type EnvList } from '../env'
import { patchRoomSettings } from '../useSettings'

const NOTE = 'Changes apply to chats and scripts started afterwards.'

/** Settings > Environment (SettingsEnvironment.png), and a room's Environment page (SettingsRoomEnvironment.png). One page serves both. */
export function Environment({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const { env, error } = useEnv(roomId)
  if (roomId && !room) return <NoRoom />
  const sections = (
    <>
      <Section title="Variables" action={<Button onClick={() => actions.ui.openModal({ name: 'envVar', roomId })}>Add variable</Button>}>
        <Variables roomId={roomId} room={room} env={env} error={error} />
      </Section>
      {room && roomId && <EnvFiles roomId={roomId} rs={rs} env={env} />}
      <KernelVars startOpen={!!room} />
    </>
  )
  return room
    ? <RoomPage room={room} rs={rs} title="Environment" intro={`Variables for ${room.name}. ${NOTE}`}>{sections}</RoomPage>
    : <Page title="Environment" intro={`Variables every chat, script and big terminal tab gets, in every room. ${NOTE}`}>{sections}</Page>
}

function Variables({ roomId, room, env, error }: { roomId?: string; room?: Room; env: EnvList | null; error: string | null }) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, run] = useBusy<'delete'>()
  if (error) return <div className="set-empty" role="alert">Could not read the variables. {error}</div>
  if (!env) return null
  const remove = (name: string) => run('delete', async () => {
    try {
      await call('env.set', { roomId, name, value: null })
      envChanged()
    } catch (e) {
      actions.ui.toast({ title: `Could not delete ${name}`, sub: (e as Error).message })
    }
    setDeleting(null)
  })
  return (
    <>
      {env.names.length === 0 && <div className="set-empty">No variables yet. Add one and chats and scripts started afterwards get it.</div>}
      {env.names.map((name) => <VariableRow key={name} roomId={roomId} name={name} onDelete={() => setDeleting(name)} />)}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting}?`}
          body={`${room ? `Chats and scripts in ${room.name}` : 'Chats and scripts in every room'} stop getting ${deleting} once they start afterwards. The ones already running keep it.`}
          confirmLabel="Delete" danger busy={busy === 'delete'} busyLabel="Deleting"
          onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}

/**
 * One variable: its name, the value as a fixed run of dots, and Show, Edit and Delete. Show asks main for the value, which
 * lives only in this component's state while it is on screen. It hides again on a second press, or when focus leaves the row.
 */
function VariableRow({ roomId, name, onDelete }: { roomId?: string; name: string; onDelete: () => void }) {
  const [value, setValue] = useState<string | null>(null)
  const [busy, run] = useBusy<'show'>()
  const row = useRef<HTMLDivElement>(null)
  // A hide that lands while a reveal is in flight cancels it, so a late answer never shows a value the user moved away from.
  const request = useRef(0)
  const hide = () => { request.current++; setValue(null) }
  const show = () => run('show', async () => {
    const mine = ++request.current
    try {
      const v = await call('env.reveal', { roomId, name })
      if (mine !== request.current) return
      setValue(v)
    } catch (e) {
      if (mine === request.current) actions.ui.toast({ title: `Could not show ${name}`, sub: (e as Error).message })
    }
  }).then(() => row.current?.querySelector('button')?.focus())
  const shown = value !== null
  return (
    <div ref={row} tabIndex={-1} className="set-env-row" onBlur={(e) => { if (!row.current?.contains(e.relatedTarget as Node | null)) hide() }}>
      <Row
        label={<span className="set-mono">{name}</span>}
        desc={shown ? <span className="set-env-value">{value}</span> : <span className="set-mask" role="img" aria-label="Value hidden">{'•'.repeat(8)}</span>}
      >
        <div className="set-entry-actions">
          <Button variant="ghost" aria-label={`${shown ? 'Hide' : 'Show'} ${name}`} busy={busy === 'show'} busyLabel="Showing" onClick={() => (shown ? hide() : void show())}>{shown ? 'Hide' : 'Show'}</Button>
          <Button variant="ghost" aria-label={`Edit ${name}`} disabled={busy !== null} onClick={() => actions.ui.openModal({ name: 'envVar', roomId, editName: name })}>Edit</Button>
          <Button variant="ghost" aria-label={`Delete ${name}`} disabled={busy !== null} onClick={onDelete}>Delete</Button>
        </div>
      </Row>
    </div>
  )
}

/** The room's env files. The list is saved whole in the personal file, so Remove works on files settings.toml set too. */
function EnvFiles({ roomId, rs, env }: { roomId: string; rs: RoomSettings | null; env: EnvList | null }) {
  const [adding, setAdding] = useState(false)
  const files = env?.files ?? []
  const path = 'env.files'
  const save = async (next: string[] | null) => {
    await patchRoomSettings(roomId, { env: { files: next } })
    envChanged()
  }
  return (
    <>
      <Section
        title="Env files"
        action={<Button disabled={!env} onClick={() => setAdding(true)}>Add env file</Button>}
        note="Read in this order each time a chat or script starts. A later file wins, and a missing file is skipped."
      >
        {env && files.length === 0 && <div className="set-empty">No env files. Add one, like .env, and its variables reach every chat and script.</div>}
        {files.map((f, i) => (
          // The list is one value, so its source shows on the first row.
          <Row key={f.path} label={<span className="set-mono">{f.path}</span>} source={i === 0 ? sourceLine(rs, path) : undefined}>
            {f.missing && <span className="set-tag">Missing</span>}
            <div className="set-entry-actions">
              {i === 0 && rs?.sources?.[path] === 'override' && <Button variant="ghost" aria-label="Reset env files" onClick={() => void save(null)}>Reset</Button>}
              <Button variant="ghost" aria-label={`Remove ${f.path}`} onClick={() => void save(files.filter((_, j) => j !== i).map((x) => x.path))}>Remove</Button>
            </div>
          </Row>
        ))}
      </Section>
      {adding && <EnvFileForm paths={files.map((f) => f.path)} onSave={save} onClose={() => setAdding(false)} />}
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

function EnvFileForm({ paths, onSave, onClose }: { paths: string[]; onSave: (next: string[]) => Promise<void>; onClose: () => void }) {
  const id = useId()
  const [path, setPath] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, run] = useBusy<'save'>()
  const problem = pathProblem(path, paths)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setShown(true)
    if (problem) return
    void run('save', async () => { await onSave([...paths, path]); onClose() })
  }
  return (
    <Modal
      title="Add env file"
      onClose={onClose}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" size="lg" onClick={onClose}>Cancel</Button>
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

/** "Kernel's variables": every chat, script and big terminal tab gets them, and a variable can't take one of their names. */
/** The room page draws the list open and the app page folded (SettingsRoomEnvironment.png, SettingsEnvironment.png). */
function KernelVars({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const id = useId()
  const label = `${open ? 'Hide' : 'Show'} Kernel's variables`
  const rows = [...Object.entries(KERNEL_VARS), ...Object.entries(SCRIPT_VARS).map(([n, d]) => [n, `${d} Scripts only.`] as const)]
  return (
    <section className="set-section">
      <h2>Kernel's variables</h2>
      <div className="set-card">
        <Row label={label} desc="Set by Kernel in every chat, script and big terminal tab. You can't override them.">
          <button type="button" className="set-disclose" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Icon name="chevron" size={10} stroke={1.9} /></button>
        </Row>
        {open && (
          <div id={id}>
            {rows.map(([name, desc]) => <div key={name} className="set-kernel"><code>{name}</code><span>{desc}</span></div>)}
          </div>
        )}
      </div>
    </section>
  )
}
