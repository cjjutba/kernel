import type { AgentDef, Project, ProjectSetupStep } from '@shared/types'
import { KERNEL_REVIEWER, NO_REVIEWER, reviewerChoice } from '@shared/team'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { projectAgents } from '../../nav'
import { Button, CopyButton, Icon, Spinner, useBusy } from '../../ui'
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

const NO_AGENTS: AgentDef[] = []

/** Who leads and who reviews, for a repo that brought its own agents (KERNEL-397), as one line (KERNEL-951). */
function teamLine(team: AgentDef[], reviewer: string): string {
  const lead = team.find((a) => a.lead)?.name ?? 'Kernel'
  const by = reviewer === NO_REVIEWER ? 'no one reviews pull requests' : reviewer === KERNEL_REVIEWER ? 'Kernel reviews pull requests' : `${team.find((a) => a.id === reviewer)?.name ?? 'Kernel'} reviews pull requests`
  return `${lead} leads, ${by}`
}

const ICON: Partial<Record<ProjectSetupStep['id'], 'download' | 'branch' | 'folder' | 'term' | 'team' | 'lock'>> = {
  clone: 'download', github: 'branch', worktrees: 'folder', copy: 'folder', hooks: 'term', push: 'lock', agents: 'team'
}

/**
 * The rows of project setup steps, each with its one action: Try again, Check hooks, Copy fix, or a link to the files to copy.
 * `problems` keeps only the steps that warn or fail, for the first chat's setup block.
 */
export function StepRows({ project, steps, problems }: { project: Project; steps: ProjectSetupStep[]; problems?: boolean }) {
  const [busy, run] = useBusy<'retry'>()
  const running = steps.some((s) => s.state === 'run')
  const retry = () => run('retry', async () => {
    try { await call('projects.retrySetup', { projectId: project.id }) } catch (e) { actions.ui.toast({ title: 'Could not try again', sub: cleanError(e) }) }
  })
  const shown = steps.filter((s) => s.id !== 'host' && s.state !== 'wait' && (!problems || s.state === 'warn' || s.state === 'fail'))
  return (
    <>
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
          {s.state === 'warn' && s.fix?.command && <CopyButton text={s.fix.command} label="Copy fix" failSub={s.fix.command} />}
          {s.state === 'fail' && s.id === 'hooks' && <Button size="sm" variant="ghost" onClick={() => actions.ui.openModal({ name: 'checkHooks' })}>Check hooks</Button>}
          {s.state === 'fail' && !running && <Button size="sm" variant="ghost" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void retry()}>Try again</Button>}
        </div>
      ))}
    </>
  )
}

/**
 * Project setup, written into New chat as plain rows (KERNEL-948). Kernel's own code
 * runs every step; nothing here uses a model. A step that warns or fails says so on its row, with its one action.
 */
export function SetupRows({ project, steps }: { project: Project; steps: ProjectSetupStep[] }) {
  const settings = useProjectSettings(project.id)
  const agents = useStore((s) => s.agents[project.id] ?? NO_AGENTS)
  const running = steps.some((s) => s.state === 'run')
  const done = steps.every((s) => s.state === 'ok' || s.state === 'warn' || s.state === 'fail')
  const lead = project.kind === 'repo' ? 'a new project cloned from GitHub' : project.kind === 'scratch' ? 'a new project' : `a new project in ${tilde(project.path)}`
  const team = agents.filter((a) => !a.retired)
  return (
    <section className="su-rows" aria-label="Project setup" aria-busy={running}>
      <p className="su-banner">You're in <code>{project.name}</code>, {lead}</p>
      <StepRows project={project} steps={steps} />
      {/* A repo that brought its own agents: who leads and who reviews, to check, with the Agents page one click away (KERNEL-951). */}
      {done && settings && team.length > 0 && !!steps.find((s) => s.id === 'agents' && s.state === 'ok')?.brought && (
        <button type="button" className="su-row su-link" onClick={() => go(projectAgents(project.id))}>
          <span className="su-ico"><Icon name="team" size={16} /></span>
          <span className="su-text"><span className="su-link-text">{teamLine(team, reviewerChoice(team, settings.team))}</span></span>
          <Icon name="ext" size={12} />
        </button>
      )}
    </section>
  )
}
