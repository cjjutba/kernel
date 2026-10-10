import { useEffect, useState, type FormEvent } from 'react'
import { ENV_NAME, isKernelVar } from '@shared/kernelVars'
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

/** Add a variable, or edit one with its name fixed (SettingsEnvironmentAdd.png). The value is typed or revealed here, and goes nowhere but `env.set`. */
export function EnvVarForm({ roomId, editName }: { roomId?: string; editName?: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const { env } = useEnv(roomId)
  const [name, setName] = useState(editName ?? '')
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!editName)
  const [busy, run] = useBusy<'save'>()
  const editing = editName !== undefined
  const problem = nameProblem(name, env?.names ?? [], editing)
  // Edit starts from what is saved. If it can't be read (no Keychain), the field stays empty and says why.
  useEffect(() => {
    if (editName === undefined) return
    let live = true
    call('env.reveal', { roomId, name: editName })
      .then((v) => { if (live) setValue(v) })
      .catch((e) => { if (live) setError((e as Error).message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [roomId, editName])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setShown(true)
    setError(null)
    if (problem) return
    void run('save', async () => {
      try {
        await call('env.set', { roomId, name, value })
        envChanged()
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
        <Button variant="primary" size="lg" type="submit" form="env-var-form" disabled={loading} busy={busy === 'save'} busyLabel="Saving">{editing ? 'Save' : 'Add'}</Button>
      </>}
    >
      <form id="env-var-form" className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">{intro}</p>
        <div className="set-field">
          <label htmlFor="env-var-name">Name</label>
          <input id="env-var-name" className="input" autoComplete="off" spellCheck={false} placeholder="VARIABLE_NAME" readOnly={editing} value={name} aria-invalid={shown && !!problem} aria-describedby={shown && problem ? 'env-var-name-note' : undefined} onChange={(e) => setName(e.target.value.trim())} />
          {shown && problem && <span id="env-var-name-note" role="alert" className="set-error">{problem}</span>}
        </div>
        <div className="set-field">
          <label htmlFor="env-var-value">Value</label>
          <input id="env-var-value" className="input" autoComplete="off" spellCheck={false} placeholder={loading ? 'Reading the saved value' : 'Value'} value={value} aria-describedby="env-var-value-note" onChange={(e) => setValue(e.target.value)} />
          {error
            ? <span id="env-var-value-note" role="alert" className="set-error">{error}</span>
            : <span id="env-var-value-note" className="set-help">Stored encrypted on your Mac, never in the repo. The list shows it as dots.</span>}
        </div>
      </form>
    </Modal>
  )
}
