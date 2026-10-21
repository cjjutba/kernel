import { useState, type KeyboardEvent } from 'react'
import { isRunName, PORT_BLOCK, RUN_SCRIPT_NAME, type ProjectSettings } from '@shared/types'
import { Button, Modal, SegmentedControl, useBusy } from '../../../ui'
import { Row, projectValue, Section } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { RowMenu } from './RowMenu'
import './envScripts.css'

type Script = ProjectSettings['runScripts'][number]

/** What is wrong with a name, or undefined. `others` are the names the project already has. */
export function nameProblem(name: string, others: string[]): string | undefined {
  if (!name) return 'Give the script a name.'
  if (isRunName(name)) return 'run is the default script. Edit it in the list.'
  if (!RUN_SCRIPT_NAME.test(name)) return 'Use letters, digits, - and _, up to 32 characters, starting with a letter or digit.'
  if (others.includes(name)) return `A script named ${name} is already in this project.`
  return undefined
}

/**
 * Run scripts on Settings > a project > Scripts (KERNEL-914): a row each with its first line and a menu. Saved in the personal file, so a script stays on this Mac.
 * `empty` is the row a project with no scripts at all shows in the card with its setup script: what run scripts are, and Add.
 */
export function RunScripts({ projectId, rs, empty }: { projectId: string; rs: ProjectSettings | null; empty?: boolean }) {
  const [editing, setEditing] = useState<Script | 'new' | null>(null)
  const scripts = rs?.runScripts ?? []
  const path = (name: string) => `runScripts.${name}`
  const drop = (name: string) => void patchProjectSettings(projectId, { runScripts: { [name]: null } })
  const form = editing && <RunScriptForm projectId={projectId} rs={rs} script={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />
  if (empty) {
    return (
      <>
        <Row id="run-scripts" label="Run scripts" desc="Start your app from a chat’s bottom panel."><Button onClick={() => setEditing('new')}>Add</Button></Row>
        {form}
      </>
    )
  }
  return (
    <>
      <Section id="run-scripts" title="Run scripts" plain action={<Button icon="plus" onClick={() => setEditing('new')}>Add run script</Button>}>
        <p className="rm-lead">Shortcuts for quick actions, like running your dev server or test suite.</p>
        {scripts.length === 0 && <p className="set-empty rm-run-empty">No run scripts yet. Add one to start your app from a workspace.</p>}
        {scripts.length > 0 && (
          <div className="set-card">
            {scripts.map((s) => {
              // Only the personal file is written. A script settings.toml defines can be edited here, and Reset drops the personal edit. Remove is for a script only this Mac has.
              const source = rs?.sources?.[path(s.name)]
              const first = s.command.split('\n').find((l) => l.trim()) ?? ''
              return (
                <Row key={s.name} className="rm-run" label={<span className="rm-run-name">{s.name}</span>} desc={<span className="rm-run-first">{first}</span>}>
                  <RowMenu box="sm" label={`More for ${s.name}`} items={[
                    { id: 'edit', label: 'Edit', icon: 'pen', onSelect: () => setEditing(s) },
                    ...(source === 'override' ? [{ id: 'reset', label: 'Reset', icon: 'refresh' as const, onSelect: () => drop(s.name) }] : []),
                    ...(source === 'local' ? [{ id: 'remove', label: 'Remove', icon: 'trash' as const, danger: true, onSelect: () => drop(s.name) }] : [])
                  ]} />
                </Row>
              )
            })}
          </div>
        )}
      </Section>
      {form}
    </>
  )
}

/** Run mode and Ports, the card under the run scripts table. The ports are explained here once; the forms only say how to use them. */
export function RunMode({ projectId, rs }: { projectId: string; rs: ProjectSettings | null }) {
  return (
    <Section title="Running">
      <Row id="run-mode" label="Run mode" {...projectValue(rs, 'scripts.runMode', () => void patchProjectSettings(projectId, { scripts: { runMode: null } }))}>
        <SegmentedControl label="Run mode" value={rs?.scripts.runMode ?? 'concurrent'} onChange={(v) => void patchProjectSettings(projectId, { scripts: { runMode: v as NonNullable<ProjectSettings['scripts']['runMode']> } })} options={[{ value: 'concurrent', label: 'Concurrent' }, { value: 'single', label: 'One at a time' }]} />
      </Row>
      <Row id="ports" label="Ports" desc={`Each workspace gets ${PORT_BLOCK}.`}>
        <span className="set-value">{`$KERNEL_PORT to $((KERNEL_PORT + ${PORT_BLOCK - 1}))`}</span>
      </Row>
    </Section>
  )
}

/** Add or edit one run script. `run` keeps its name. So does a script settings.toml defines, since the personal file can't move it. */
function RunScriptForm({ projectId, rs, script, onClose }: { projectId: string; rs: ProjectSettings | null; script?: Script; onClose: () => void }) {
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
  const save = () => {
    setShown(true)
    if (problem || noCommand) return
    const next = fixed ? script!.name : name.trim()
    void run('save', async () => {
      // Renaming writes the new name and drops the old one from the personal file.
      await patchProjectSettings(projectId, { runScripts: { ...(script && script.name !== next ? { [script.name]: null } : {}), [next]: command.trim() } })
      onClose()
    })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
  }
  return (
    <Modal
      title={script ? `Edit ${script.name}` : 'Add a run script'}
      onClose={onClose}
      width={480}
      top={160}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" size="lg" data-dismiss>Cancel</Button>
        <Button variant="primary" size="lg" type="submit" form="run-script-form" busy={busy === 'save'} busyLabel="Saving" aria-keyshortcuts="Meta+Enter">{script ? 'Save' : 'Add script'}</Button>
      </>}
    >
      <form id="run-script-form" className="modal-body set-form" onSubmit={(e) => { e.preventDefault(); save() }} onKeyDown={onKeyDown} noValidate>
        <p className="set-help">Run scripts start from the Run button in a chat’s bottom panel.</p>
        <div className="set-field">
          <label htmlFor="run-script-name">Name</label>
          <input id="run-script-name" className="input set-text-input" autoComplete="off" spellCheck={false} placeholder="frontend" value={fixed ? script!.name : name} disabled={fixed} aria-invalid={shown && !!problem} aria-describedby="run-script-name-note" onChange={(e) => setName(e.target.value)} />
          {shown && problem
            ? <span id="run-script-name-note" role="alert" className="set-error">{problem}</span>
            : (isRun || shared) && <span id="run-script-name-note" className="set-help">{isRun ? 'run is the default script, so it keeps its name.' : 'This script is in settings.toml, so it keeps its name.'}</span>}
        </div>
        <div className="set-field">
          <label htmlFor="run-script-command">Command</label>
          <textarea
            id="run-script-command" className="input rm-command" rows={Math.min(Math.max(command.split('\n').length, 1), 8)} wrap="off" autoComplete="off" spellCheck={false}
            placeholder="pnpm dev --port $KERNEL_PORT" value={command} aria-invalid={shown && noCommand} aria-describedby="run-script-command-note" onChange={(e) => setCommand(e.target.value)}
          />
          {shown && noCommand
            ? <span id="run-script-command-note" role="alert" className="set-error">Enter the command to run.</span>
            : <span id="run-script-command-note" className="set-help">Runs in the chat’s worktree. $KERNEL_PORT is the first of the workspace’s {PORT_BLOCK} ports. Use $((KERNEL_PORT + 1)) for the next.</span>}
        </div>
      </form>
    </Modal>
  )
}
