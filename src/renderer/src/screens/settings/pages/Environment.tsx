import './agents.css'
import './envScripts.css'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { KERNEL_VARS, SCRIPT_VARS, SETUP_VARS } from '@shared/kernelVars'
import type { Project, ProjectSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { actions, getState } from '../../../store'
import { failToast, useRetryKey } from '../../../retry'
import { Button, ConfirmDialog, Icon, LoadingRow, Modal, useBusy } from '../../../ui'
import { appliesTo, isOverride, NoProject, Page, ProjectPage, Row, Section, useProjectPage } from '../kit'
import { RowMenu } from './RowMenu'
import { envChanged, useEnv, type EnvList } from '../env'
import { patchProjectSettings } from '../useSettings'
import { FilesToCopy } from './FilesToCopy'

/** Settings > Environment, and a project's Environment page (Redesign 15). One page serves both. */
export function Environment({ projectId }: { projectId?: string }) {
  const { project, rs } = useProjectPage(projectId)
  const { env, error, reload } = useEnv(projectId)
  if (projectId && !project) return <NoProject />
  const sections = (
    <>
      <Variables projectId={projectId} project={project} env={env} error={error} reload={reload} />
      {project && projectId && <EnvFiles projectId={projectId} rs={rs} env={env} />}
      {project && projectId && <FilesToCopy projectId={projectId} project={project} rs={rs} />}
      {!project && <KernelVars />}
    </>
  )
  return project
    ? <ProjectPage project={project} rs={rs} title="Environment" desc="The env files and gitignored files each worktree gets from the main checkout.">{sections}</ProjectPage>
    : <Page title="Environment" desc="Variables every chat, script and terminal gets. Kernel shows names only, and a value only when you ask.">{sections}</Page>
}

/**
 * Your variables, a row each: the name in mono, Reveal and a menu with Edit and Remove. Reveal asks main for the value, which lives only in this
 * component's state while it is on screen. It hides again on a second press, or when focus leaves the row.
 */
function Variables({ projectId, project, env, error, reload }: { projectId?: string; project?: Project; env: EnvList | null; error: string | null; reload: () => Promise<void> }) {
  const [removing, setRemoving] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [busy, run] = useBusy<string>()
  // A hide that lands while a reveal is in flight cancels it, so a late answer never shows a value the user moved away from.
  const request = useRef<Record<string, number>>({})
  const retry = `env:${projectId ?? 'app'}`
  useRetryKey(retry, reload)
  useEffect(() => { if (error) failToast('Could not read the variables', error, retry) }, [error, retry])
  const add = <Button icon="plus" disabled={!env} onClick={() => actions.ui.openModal({ name: 'envVar', projectId })}>Add variable</Button>
  const head = <span className="rm-aside-act"><span className="rm-aside">{project ? 'Only this project’s chats and scripts' : 'For every project'}</span>{add}</span>
  if (error && !env) {
    return (
      <Section title={project ? 'Variables' : 'Your variables'} action={head}>
        <Row label="Could not read the variables" desc="Try again in a moment."><Button busy={busy === 'retry'} busyLabel="Trying again" onClick={() => void run('retry', reload)}>Try again</Button></Row>
      </Section>
    )
  }
  if (!env) return <Section title={project ? 'Variables' : 'Your variables'} action={head}><LoadingRow what="variables" inline /></Section>
  const hide = (name: string) => { request.current[name] = (request.current[name] ?? 0) + 1; setRevealed(({ [name]: _gone, ...rest }) => rest) }
  const show = (name: string) => run(`show:${name}`, async () => {
    const mine = (request.current[name] = (request.current[name] ?? 0) + 1)
    try {
      const v = await call('env.reveal', { projectId, name })
      if (mine === request.current[name]) setRevealed((r) => ({ ...r, [name]: v }))
    } catch (e) {
      if (mine === request.current[name]) actions.ui.toast({ title: `Could not show ${name}`, sub: cleanError(e) })
    }
  })
  const remove = (name: string) => run('remove', async () => {
    try {
      await call('env.set', { projectId, name, value: null })
      await envChanged()
    } catch (e) {
      actions.ui.toast({ title: `Could not remove ${name}`, sub: cleanError(e) })
    }
    setRemoving(null)
  })
  return (
    <>
    <Section title={project ? 'Variables' : 'Your variables'} action={head}>
      {env.names.length === 0 && <p className="set-empty">No variables yet. Add one and chats and scripts started afterwards get it.</p>}
      {env.names.map((name) => {
        const value = revealed[name]
        const shown = value !== undefined
        return (
          <Row key={name} className="rm-var" label={name} desc={shown ? <span className="ag-value">{value}</span> : undefined}>
            <span className="rm-var-acts">
              <Button variant="ghost" size="xs" icon={shown ? 'eyeoff' : 'eye'} aria-label={busy === `show:${name}` ? `Showing ${name}` : `${shown ? 'Hide' : 'Reveal'} ${name}`} busy={busy === `show:${name}`} busyLabel="Showing" onClick={() => (shown ? hide(name) : void show(name))}>{shown ? 'Hide' : 'Reveal'}</Button>
              <RowMenu box="sm" label={`More for ${name}`} items={[
                { id: 'edit', label: 'Edit', icon: 'pen', onSelect: () => actions.ui.openModal({ name: 'envVar', projectId, editName: name }) },
                { id: 'remove', label: 'Remove', icon: 'trash', danger: true, onSelect: () => setRemoving(name) }
              ]} />
            </span>
          </Row>
        )
      })}
    </Section>
      {removing && (
      <ConfirmDialog
        title={`Remove ${removing}?`}
        body={`${project ? `Chats and scripts in ${project.name}` : 'Chats and scripts in every project'} stop getting ${removing} once they start afterwards. The ones already running keep it.`}
        confirmLabel="Remove" danger busy={busy === 'remove'} busyPattern="ripple" busyLabel="Removing"
        onConfirm={() => void remove(removing)} onCancel={() => setRemoving(null)}
      />
    )}
    </>
  )
}

/**
 * The project's env files. The list is saved whole in the personal file, so Remove works on files settings.toml set too. Each save is
 * built from the saved list as it is now, and the page waits for the list to reload before another can start, so two quick Removes
 * can't bring a file back.
 */
function EnvFiles({ projectId, rs, env }: { projectId: string; rs: ProjectSettings | null; env: EnvList | null }) {
  const [adding, setAdding] = useState(false)
  const [busy, run] = useBusy()
  const files = env?.files ?? []
  const path = 'env.files'
  const latest = () => getState().projectSettings[projectId]?.env?.files ?? files.map((f) => f.path)
  const save = (key: string, next: () => string[] | null) => run(key, async () => {
    await patchProjectSettings(projectId, { env: { files: next() } })
    await envChanged()
  })
  // The list is one value, so its source shows once, under the card. Reset only shows for a list that overrides settings.toml:
  // a list that lives only in the personal file can be emptied with Remove, so Reset adds nothing there.
  const source = isOverride(rs, path) ? 'Changed for this project' : undefined
  return (
    <>
      <Section
        title="Env files"
        action={<span className="rm-aside-act">
          <span className="rm-aside">Read in this order. A later file wins.</span>
          {rs?.sources?.[path] === 'override' && <Button variant="ghost" aria-label="Reset env files" busy={busy === 'reset'} busyLabel="Resetting" disabled={busy !== null} onClick={() => void save('reset', () => null)}>Reset</Button>}
          <Button icon="plus" disabled={!env || busy !== null} onClick={() => setAdding(true)}>Add env file</Button>
        </span>}
        footnote={[source, appliesTo('env.files')].filter(Boolean).join('. ')}
      >
        {files.length === 0 && <p className="set-empty">No env files. Add one, like .env, and its variables reach every chat and script.</p>}
        {files.map((f) => (
          <Row
            key={f.path} className="rm-envfile" label={<FileLabel path={f.path} />}
            hover={<Button variant="ghost" size="xs" aria-label={`Remove ${f.path}`} busy={busy === `remove:${f.path}`} busyPattern="ripple" busyLabel="Removing" disabled={busy !== null} onClick={() => void save(`remove:${f.path}`, () => latest().filter((p) => p !== f.path))}>Remove</Button>}
          >
            <span className="rm-state" data-tone={f.missing ? 'absent' : undefined}><Icon name={f.missing ? 'minus' : 'check'} size={12} />{f.missing ? 'Not in the checkout' : 'In the checkout'}</span>
          </Row>
        ))}
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
      title="Add an env file"
      onClose={onClose}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" size="lg" data-dismiss>Cancel</Button>
        <Button variant="primary" size="lg" type="submit" form={`${id}-form`} busy={busy === 'save'} busyLabel="Adding">Add file</Button>
      </>}
    >
      <form id={`${id}-form`} className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">Kernel reads it in each new worktree, so agents start with the same keys you have. It never shows the values. Saved in settings.local.toml, so it stays on your Mac.</p>
        <div className="set-field">
          <label htmlFor={`${id}-path`}>File</label>
          <input id={`${id}-path`} className="input" autoComplete="off" spellCheck={false} placeholder=".env.local" value={path} aria-invalid={shown && !!problem} aria-describedby={`${id}-note`} onChange={(e) => setPath(e.target.value.trim())} />
          {shown && problem
            ? <span id={`${id}-note`} role="alert" className="set-error">{problem}</span>
            : <span id={`${id}-note`} className="set-help">Relative to each workspace folder, so a worktree reads its own copy. A file that is not there yet is skipped until it is.</span>}
        </div>
      </form>
    </Modal>
  )
}

/** "Kernel's variables": every chat, script and big terminal tab gets them, and a variable can't take one of their names. Read only. */
function KernelVars() {
  const rows = [...Object.entries(KERNEL_VARS), ...Object.entries(SCRIPT_VARS).map(([n, d]) => [n, `${d} Scripts only.`] as const), ...Object.entries(SETUP_VARS).map(([n, d]) => [n, `${d} Setup only.`] as const)]
  return (
    <Section title="Kernel's variables" action={<span className="rm-aside">Set in every chat, script and terminal. Read only.</span>}>
      {rows.map(([name, desc]) => <div key={name} className="set-row"><span className="rm-kvar">{name}</span><span className="rm-kdesc">{desc}</span></div>)}
    </Section>
  )
}
