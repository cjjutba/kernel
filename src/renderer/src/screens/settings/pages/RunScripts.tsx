import { useState, type FormEvent } from 'react'
import { isRunName, PORT_BLOCK, RUN_SCRIPT_NAME, type RoomSettings } from '@shared/types'
import { Button, Modal, SegmentedControl, useBusy } from '../../../ui'
import { isOverride, Row, Section, sourceLine } from '../kit'
import { patchRoomSettings } from '../useSettings'

type Script = RoomSettings['runScripts'][number]

/** What is wrong with a name, or undefined. `others` are the names the room already has. */
export function nameProblem(name: string, others: string[]): string | undefined {
  if (!name) return 'Give the script a name.'
  if (isRunName(name)) return 'run is the default script. Edit it in the list.'
  if (!RUN_SCRIPT_NAME.test(name)) return 'Use letters, digits, - and _, up to 32 characters, starting with a letter or digit.'
  if (others.includes(name)) return `A script named ${name} is already in this room.`
  return undefined
}

/** The Run scripts section of Settings > a room > Scripts (SettingsRoomScripts.png). Saved in the personal file, so a script stays on this Mac. */
export function RunScripts({ roomId, rs }: { roomId: string; rs: RoomSettings | null }) {
  const [editing, setEditing] = useState<Script | 'new' | null>(null)
  const scripts = rs?.runScripts ?? []
  const path = (name: string) => `runScripts.${name}`
  const drop = (name: string) => void patchRoomSettings(roomId, { runScripts: { [name]: null } })
  return (
    <>
      <Section
        title="Run scripts"
        action={<Button onClick={() => setEditing('new')}>Add run script</Button>}
        note={`Each workspace gets ${PORT_BLOCK} ports, $KERNEL_PORT to $((KERNEL_PORT + ${PORT_BLOCK - 1})).`}
      >
        {scripts.length === 0 && <div className="set-empty">No run scripts. Add one to start the app from a workspace.</div>}
        {scripts.map((s) => {
          // Only the personal file is written. A script settings.toml defines can be edited here, and Reset drops the personal edit. Remove is for a script only this Mac has.
          const source = rs?.sources?.[path(s.name)]
          return (
            <Row key={s.name} label={s.name} source={sourceLine(rs, path(s.name))} desc={<span className="set-cmd">{s.command}</span>}>
              <div className="set-entry-actions">
                {source === 'override' && <Button variant="ghost" aria-label={`Reset ${s.name}`} onClick={() => drop(s.name)}>Reset</Button>}
                <Button variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>Edit</Button>
                {source === 'local' && <Button variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => drop(s.name)}>Remove</Button>}
              </div>
            </Row>
          )
        })}
        <Row label="Run mode" source={sourceLine(rs, 'scripts.runMode')} onReset={isOverride(rs, 'scripts.runMode') ? () => void patchRoomSettings(roomId, { scripts: { runMode: null } }) : undefined}>
          <SegmentedControl label="Run mode" value={rs?.scripts.runMode ?? 'concurrent'} onChange={(v) => void patchRoomSettings(roomId, { scripts: { runMode: v as NonNullable<RoomSettings['scripts']['runMode']> } })} options={[{ value: 'concurrent', label: 'Concurrent' }, { value: 'single', label: 'One at a time' }]} />
        </Row>
      </Section>
      {editing && <RunScriptForm roomId={roomId} rs={rs} script={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** Add or edit one run script. `run` keeps its name. So does a script settings.toml defines, since the personal file can't move it. */
function RunScriptForm({ roomId, rs, script, onClose }: { roomId: string; rs: RoomSettings | null; script?: Script; onClose: () => void }) {
  const [name, setName] = useState(script?.name ?? '')
  const [command, setCommand] = useState(script?.command ?? '')
  const [shown, setShown] = useState(false)
  const [busy, run] = useBusy<'save'>()
  const isRun = script?.name === 'run'
  const shared = !!script && !isRun && rs?.sources?.[`runScripts.${script.name}`] !== 'local'
  const fixed = isRun || shared
  const others = (rs?.runScripts ?? []).map((s) => s.name).filter((n) => n !== script?.name)
  const problem = fixed ? undefined : nameProblem(name.trim(), others)
  const noCommand = !command.trim()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setShown(true)
    if (problem || noCommand) return
    const next = fixed ? script!.name : name.trim()
    void run('save', async () => {
      // Renaming writes the new name and drops the old one from the personal file.
      await patchRoomSettings(roomId, { runScripts: { ...(script && script.name !== next ? { [script.name]: null } : {}), [next]: command.trim() } })
      onClose()
    })
  }
  return (
    <Modal
      title={script ? `Edit ${script.name}` : 'Add run script'}
      onClose={onClose}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="run-script-form" busy={busy === 'save'} busyLabel="Saving">Save</Button>
      </>}
    >
      <form id="run-script-form" className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">Saved in settings.local.toml, so it stays on your Mac. A workspace starts it from the Run tab.</p>
        <div className="set-field">
          <label htmlFor="run-script-name">Name</label>
          <input id="run-script-name" className="input" autoComplete="off" spellCheck={false} placeholder="frontend" value={fixed ? script!.name : name} disabled={fixed} aria-invalid={shown && !!problem} aria-describedby="run-script-name-note" onChange={(e) => setName(e.target.value)} />
          {shown && problem
            ? <span id="run-script-name-note" role="alert" className="set-error">{problem}</span>
            : <span id="run-script-name-note" className="set-help">{isRun ? 'run is the default script, so it keeps its name.' : shared ? 'This script is in settings.toml, so it keeps its name.' : 'Shown in the Run tab. Letters, digits, - and _.'}</span>}
        </div>
        <div className="set-field">
          <label htmlFor="run-script-command">Command</label>
          <textarea id="run-script-command" className="input" spellCheck={false} placeholder="pnpm dev --port $KERNEL_PORT" value={command} aria-invalid={shown && noCommand} aria-describedby="run-script-command-note" onChange={(e) => setCommand(e.target.value)} />
          {shown && noCommand
            ? <span id="run-script-command-note" role="alert" className="set-error">Enter the command to run.</span>
            : <span id="run-script-command-note" className="set-help">$KERNEL_PORT is the first of the workspace's {PORT_BLOCK} ports. Use $((KERNEL_PORT + 1)) for the next.</span>}
        </div>
      </form>
    </Modal>
  )
}
