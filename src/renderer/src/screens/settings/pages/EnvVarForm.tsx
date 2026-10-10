import { useId, useState, type FormEvent } from 'react'
import { ENV_NAME, isClaudeVar, isKernelVar } from '@shared/kernelVars'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Modal, useBusy } from '../../../ui'
import { envChanged, useEnv } from '../env'

/**
 * What is wrong with a name, or undefined. This is the engine's rule (`ENV_NAME` and Kernel's own names, both from src/shared).
 * The engine also refuses `__proto__`, `constructor` and `prototype`, and its message shows under the form when it does.
 */
export function nameProblem(name: string, taken: string[], editing: boolean): string | undefined {
  if (!name) return 'Enter a name.'
  if (!ENV_NAME.test(name)) return 'Use letters, digits and _, and don\'t start with a digit.'
  if (isKernelVar(name)) return `${name} is one of Kernel's own variables. Pick another name.`
  if (!editing && taken.includes(name)) return `${name} is already set here. Use Edit to change it.`
  return undefined
}

/**
 * Add a variable, or edit one with its name fixed (SettingsEnvironmentAdd.png). The value is typed here and goes nowhere but `env.set`.
 * Edit opens with the value empty. Show asks main for the saved one only when pressed, and it stays in this component's state.
 */
export function EnvVarForm({ roomId, editName }: { roomId?: string; editName?: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const { env } = useEnv(roomId)
  const id = useId()
  const [name, setName] = useState(editName ?? '')
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, run] = useBusy<'save' | 'show'>()
  const editing = editName !== undefined
  const problem = nameProblem(name, env?.names ?? [], editing)
  const valueProblem = editing && !value ? 'Type the new value, or Cancel to keep the saved one.' : undefined
  // Show asks for the saved value, and a second press hides it again. A value that can't be read (no Keychain) says why under the field.
  const reveal = () => run('show', async () => {
    setError(null)
    try { setSaved(await call('env.reveal', { roomId, name })) } catch (e) { setError((e as Error).message) }
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setShown(true)
    setError(null)
    if (problem || valueProblem) return
    void run('save', async () => {
      try {
        await call('env.set', { roomId, name, value })
        void envChanged()
        actions.ui.closeModal()
      } catch (err) {
        setError((err as Error).message)
      }
    })
  }
  const intro = room
    ? `For ${room.name}. It wins over the same name in Settings, Environment.`
    : 'For every room. A room\'s variable with the same name wins.'
  return (
    <Modal
      title={editing ? `Edit ${editName}` : 'Add variable'}
      onClose={actions.ui.closeModal}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" size="lg" onClick={actions.ui.closeModal}>Cancel</Button>
        <Button variant="primary" size="lg" type="submit" form={`${id}-form`} disabled={busy === 'show'} busy={busy === 'save'} busyLabel="Saving">{editing ? 'Save' : 'Add'}</Button>
      </>}
    >
      <form id={`${id}-form`} className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">{intro}</p>
        <div className="set-field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="input" autoComplete="off" spellCheck={false} placeholder="VARIABLE_NAME" readOnly={editing} value={name} aria-invalid={shown && !!problem} aria-describedby={`${id}-name-note`} onChange={(e) => setName(e.target.value.trim())} />
          {shown && problem
            ? <span id={`${id}-name-note`} role="alert" className="set-error">{problem}</span>
            : isClaudeVar(name) && <span id={`${id}-name-note`} className="set-help">Chats and terminals ignore this name. Scripts get it.</span>}
        </div>
        <div className="set-field">
          <label htmlFor={`${id}-value`}>Value</label>
          <input id={`${id}-value`} className="input" autoComplete="off" spellCheck={false} placeholder={editing ? 'Type a new value' : 'Value'} value={value} aria-invalid={shown && !!valueProblem} aria-describedby={`${id}-value-note`} onChange={(e) => setValue(e.target.value)} />
          {error
            ? <span id={`${id}-value-note`} role="alert" className="set-error">{error}</span>
            : shown && valueProblem
              ? <span id={`${id}-value-note`} role="alert" className="set-error">{valueProblem}</span>
              : <span id={`${id}-value-note`} className="set-help">Stored encrypted on your Mac, never in the repo. The list shows it as dots.</span>}
        </div>
        {editing && (
          <div className="set-reveal">
            <Button
              variant="ghost" aria-label={busy === 'show' ? 'Showing the saved value' : saved === null ? 'Show the saved value' : 'Hide the saved value'}
              busy={busy === 'show'} busyLabel="Showing" disabled={busy === 'save'} onClick={() => (saved === null ? void reveal() : setSaved(null))}
            >{saved === null ? 'Show saved value' : 'Hide saved value'}</Button>
            {saved !== null && <span className="set-env-value" aria-live="polite">{saved}</span>}
          </div>
        )}
      </form>
    </Modal>
  )
}
