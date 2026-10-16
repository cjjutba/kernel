import type { Project, ProjectSetupStep } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go } from '../../store'
import { Button, Icon, Spinner, useBusy } from '../../ui'
import { useProjectSettings } from '../settings/useSettings'

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

/** What a finished step says, in the past tense, or nothing for a step the rows leave out (KERNEL-948). */
function doneText(step: ProjectSetupStep, project: Project): string | null {
  switch (step.id) {
    case 'clone': return project.kind === 'repo' ? `Cloned ${project.repo ?? project.name} into ${tilde(project.path)}` : project.kind === 'scratch' ? `Created ${tilde(project.path)} with a README` : `Using ${tilde(project.path)}`
    case 'github': return step.title.replace(/^Create /, 'Created ')
    case 'worktrees': return 'Created the worktree folder'
    case 'copy': return step.detail === 'No local files to copy' ? 'No local files to copy' : `Copied ${step.detail}`
    case 'hooks': return 'Installed hooks'
    case 'push': return step.detail || null
    case 'agents': return step.detail ? `Seated ${step.detail}` : null
    default: return null
  }
}

const ICON: Partial<Record<ProjectSetupStep['id'], 'download' | 'branch' | 'folder' | 'term' | 'team' | 'lock'>> = {
  clone: 'download', github: 'branch', worktrees: 'folder', copy: 'folder', hooks: 'term', push: 'lock', agents: 'team'
}

/**
 * Project setup, written into New chat as plain rows, the way Conductor shows a new workspace (KERNEL-948). Kernel's own code
 * runs every step; nothing here uses a model. A step that warns or fails says so on its row, with its one action.
 */
export function SetupRows({ project, steps }: { project: Project; steps: ProjectSetupStep[] }) {
  const settings = useProjectSettings(project.id)
  const [busy, run] = useBusy<'retry'>()
  const running = steps.some((s) => s.state === 'run')
  const done = steps.every((s) => s.state === 'ok' || s.state === 'warn' || s.state === 'fail')
  const retry = () => run('retry', async () => {
    try { await call('projects.retrySetup', { projectId: project.id }) } catch (e) { actions.ui.toast({ title: 'Could not try again', sub: cleanError(e) }) }
  })
  const lead = project.kind === 'repo' ? 'a new project cloned from GitHub' : project.kind === 'scratch' ? 'a new project' : `a new project in ${tilde(project.path)}`
  const shown = steps.filter((s) => s.id !== 'host' && s.state !== 'wait')
  return (
    <section className="su-rows" aria-label="Project setup" aria-busy={running}>
      <p className="su-banner">You're in <code>{project.name}</code>, {lead}</p>
      {shown.map((s) => (
        <div key={s.id} className="su-row" data-state={s.state}>
          <span className="su-ico">
            {s.state === 'run' ? <Spinner label={null} pattern="rotate" /> : s.state === 'fail' ? <Icon name="close" size={16} /> : <Icon name={ICON[s.id] ?? 'check'} size={16} />}
          </span>
          <span className="su-text">
            <span>{s.state === 'run' ? s.title : s.state === 'fail' ? `${s.title} failed` : s.state === 'warn' && s.id === 'copy' && s.production?.length ? `Copied local files, skipped ${s.production.join(', ')} because ${s.production.length === 1 ? 'it looks' : 'they look'} like production` : doneText(s, project) ?? s.title}</span>
            {s.state === 'fail' && s.error && <span className="su-error">{s.error}</span>}
          </span>
          {s.state === 'warn' && s.id === 'copy' && <button type="button" className="su-out" aria-label="Review files to copy" onClick={() => go({ name: 'settings', page: 'project', projectId: project.id, section: 'environment' })}><Icon name="ext" size={12} /></button>}
          {s.state === 'warn' && s.fix?.command && <Button size="sm" variant="ghost" icon="copy" onClick={() => void navigator.clipboard.writeText(s.fix!.command!).then(() => actions.ui.toast({ title: 'Copied', sub: 'Run it in Terminal.' }), () => actions.ui.toast({ title: 'Could not copy', sub: s.fix!.command! }))}>Copy fix</Button>}
          {s.state === 'fail' && s.id === 'hooks' && <Button size="sm" variant="ghost" onClick={() => actions.ui.openModal({ name: 'checkHooks' })}>Check hooks</Button>}
          {s.state === 'fail' && !running && <Button size="sm" variant="ghost" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void retry()}>Try again</Button>}
        </div>
      ))}
      {done && settings && !settings.scripts.setup && (
        <button type="button" className="su-row su-link" onClick={() => go({ name: 'settings', page: 'project', projectId: project.id, section: 'setup' })}>
          <span className="su-ico"><Icon name="term" size={16} /></span>
          <span className="su-text"><span className="su-link-text">No setup script yet</span></span>
          <Icon name="ext" size={12} />
        </button>
      )}
    </section>
  )
}
