import { useEffect, useId, useState } from 'react'
import type { AgentDef, TeamPatch } from '@shared/types'
import { KERNEL_REVIEWER, NO_REVIEWER, reviewerChoice } from '@shared/team'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { openProject } from '../../lead'
import { Banner, Button, CodeBlock, Icon, Spinner, useBusy } from '../../ui'
import { warningText } from '../agent/model'
import { getDraft } from './draft'
import { ReviewerPicker } from './ReviewerPicker'
import '../onboarding/onboarding.css'
import './projects.css'

const NO_AGENTS: AgentDef[] = []
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)
/** An agent the Reviewer picker offers: the one that reviews now, or any whose role says review. */
const reviews = (a: AgentDef) => !!a.reviewer || /\breview/i.test(a.role)

/** "`.env` and `.env.production`": the files by name, in mono, joined the way a sentence lists them. */
function fileList(paths: string[]) {
  return paths.map((p, i) => <span key={p}>{i === 0 ? '' : i === paths.length - 1 ? ' and ' : ', '}<code>{p}</code></span>)
}

/** The copy step's warning (ProjectSetupWarnings.png): the copied files that look like production, by name only (KERNEL-449). */
function ProductionNote({ paths }: { paths: string[] }) {
  return <span className="ob-detail rs-note">{paths.length} {paths.length === 1 ? 'looks' : 'look'} like production: {fileList(paths)}. Agents run commands in each worktree, so a migration there could reach a live database.</span>
}

/**
 * ProjectSetup.png: clone, folders, install, files, hooks, push access, agents. Progress comes from `project.setup` push events.
 * ProjectSetupWarnings.png: a step that finished with something to fix warns, and the project still opens (KERNEL-460).
 * ProjectSetupGitHub.png and ProjectSetupLocal.png: the code host read from the checkout, after the first step (KERNEL-477).
 * ProjectSetupTeam.png: a repo that brought its own agents shows its team once setup is done, to check who leads and who
 * reviews before the project opens (KERNEL-397).
 */
export function ProjectSetup({ projectId }: { projectId?: string }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
  const steps = useStore((s) => (projectId ? s.projectSetup[projectId] : undefined))
  const agents = useStore((s) => (projectId ? s.agents[projectId] ?? NO_AGENTS : NO_AGENTS))
  const teamConfig = useStore((s) => (projectId ? s.projectSettings[projectId]?.team : undefined))
  const finished = !!steps && steps.every((s) => s.state === 'ok' || s.state === 'warn' || s.state === 'fail')
  const failed = steps?.filter((s) => s.state === 'fail').length ?? 0
  const stopped = failed > 0 && !steps?.some((s) => s.state === 'run')
  // A warning never stops the project opening, but it stops Brief Kernel right away, so the user sees it (KERNEL-437).
  const warned = steps?.filter((s) => s.state === 'warn').length ?? 0
  const seated = steps?.find((s) => s.id === 'agents')
  const team = agents.filter((a) => !a.retired)
  const review = finished && seated?.state === 'ok' && !!seated.brought && team.length > 0
  const warnings = team.flatMap((a) => (a.warnings ?? []).map((w) => `${a.name}: ${lower(warningText(w))}`))
  const reviewerNow = reviewerChoice(team, teamConfig)
  const [reviewer, setReviewer] = useState<string>()
  // `[team] reviewer = "none"` is in the repo's file, not in the agent list, so the team waits for the read before it shows a Reviewer.
  const [configRead, setConfigRead] = useState(false)
  const showTeam = review && configRead
  const [busy, run] = useBusy()
  const reviewerLabel = useId()
  const files = team.filter((a) => !a.builtIn)
  const reviewers = files.filter((a) => !a.lead && reviews(a))
  const reviewerPick = reviewer ?? reviewerNow
  // The team the repo brought is saved as checked, and only what changed goes to settings.toml (KERNEL-397).
  const open = () => run('open', async () => {
    if (!projectId) return
    if (review) {
      const patch: TeamPatch = {}
      if (reviewerPick !== reviewerNow) patch.reviewer = reviewerPick
      try { await call('agents.setTeam', { projectId, team: patch, from: 'setup' }) } catch (e) { actions.ui.toast({ title: 'Could not change the team', sub: cleanError(e) }); return }
    }
    await openProject(projectId)
  })
  // "Brief Kernel right away" in New project: when setup finishes cleanly, land in the Lead's chat (D-104). A team the repo brought
  // with something to look at waits for Open the project.
  const teamPending = finished && seated?.state === 'ok' && !!seated.brought && !team.length
  useEffect(() => { if (finished && !failed && !warned && !teamPending && getDraft().autostart && projectId && !(review && warnings.length)) void openProject(projectId) }, [finished, failed, warned, teamPending, projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!review || !projectId) return
    let live = true
    call('settings.project', { projectId }).then((rs) => actions.settings.setProject(projectId, rs)).catch(() => undefined).finally(() => { if (live) setConfigRead(true) })
    return () => { live = false }
  }, [review, projectId])
  const recheck = () => run('recheck', async () => {
    if (!projectId) return
    try { await call('projects.pushCheck', { projectId, recheck: true }) } catch (e) { actions.ui.toast({ title: 'Could not check push access', sub: cleanError(e) }) }
  })
  const retry = () => run('retry', async () => {
    if (!projectId) return
    try { await call('projects.retrySetup', { projectId }) } catch (e) { actions.ui.toast({ title: 'Could not try again', sub: cleanError(e) }) }
  })
  const status = stopped ? `${failed} ${failed === 1 ? 'step' : 'steps'} did not finish.${finished ? ' You can still open the project.' : ''}`
    : finished && warned ? `${warned} ${warned === 1 ? 'thing needs' : 'things need'} your attention. Tell Kernel what to build.`
      : finished ? 'Done. Tell Kernel what to build.'
        : 'You can leave this screen. Kernel keeps going.'
  const noReviewerAgent = !reviewers.length
  const reviewerNote = reviewerPick === NO_REVIEWER ? 'No reviewer. No code review runs by itself.'
    : reviewerPick === KERNEL_REVIEWER ? `${noReviewerAgent ? 'No reviewer. ' : ''}Pull requests get Kernel’s code review.`
      : 'Reviews each pull request before it merges'

  return (
    <div className="panel" style={{ background: 'transparent', border: 0 }}>
      <div className={showTeam ? 'ob-page rs-review' : 'ob-page'}>
        <div className="ob-col">
          <h1 className="ob-h1">{stopped ? `${project?.name ?? 'Your project'} did not finish setting up` : `Setting up ${project?.name ?? 'your project'}`}</h1>
          <p className="ob-sub">{stopped ? 'A step stopped. Its error is below.' : 'This takes a minute. Your team is ready when it finishes.'}</p>
          <div className="ob-list" aria-busy={!finished}>
            {(steps ?? []).map((s) => (
              <div key={s.id} className="ob-check" data-state={s.state} data-ok={s.state !== 'fail'}>
                <span className="ob-ico rs-ico" data-state={s.state}>
                  {s.state === 'ok' && <Icon name="check" size={16} />}
                  {s.state === 'warn' && <Icon name="warning" size={16} />}
                  {s.state === 'fail' && <Icon name="close" size={16} />}
                  {s.state === 'run' && <Spinner label={`${s.title} is running`} pattern="snake" />}
                  {s.state === 'wait' && <span aria-label="Waiting" className="rs-dash">–</span>}
                </span>
                <div className="ob-body">
                  <span className="ob-name" style={s.state === 'wait' ? { color: 'var(--muted)', fontWeight: 400 } : undefined}>{s.title}</span>
                  <span className="ob-detail">{s.detail}</span>
                  {s.error && <div className="rs-fail"><Banner kind="setup" title={`${s.title} did not finish`} actions={s.state === 'fail' ? <Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" disabled={busy !== null} onClick={() => void retry()}>Try again</Button> : undefined}>{s.error}</Banner></div>}
                  {s.output && <pre className="code boxed rs-out">{s.output}</pre>}
                  {s.fix?.command && <div className="ob-fix"><CodeBlock inline>{s.fix.command}</CodeBlock></div>}
                  {s.fix?.action === 'recheck' && (
                    <div className="ob-acts rs-acts">
                      <Button variant="secondary" busy={busy === 'recheck'} busyPattern="rotate" busyLabel="Checking" disabled={busy !== null} onClick={() => void recheck()}>Check again</Button>
                    </div>
                  )}
                  {s.state === 'warn' && !!s.production?.length && (
                    <>
                      <ProductionNote paths={s.production} />
                      <div className="ob-acts rs-acts"><Button onClick={() => projectId && actions.ui.go({ name: 'settings', page: 'project', projectId, section: 'setup' })}>Review files</Button></div>
                    </>
                  )}
                </div>
                {s.meta && s.state !== 'warn' && <span className="ob-meta">{s.meta}</span>}
              </div>
            ))}
            {!steps && <div className="ob-check"><Spinner label="Starting" pattern="arrow-down" /><span className="muted">Starting</span></div>}
          </div>
          {showTeam && (
            <section className="rs-team" aria-labelledby="rs-team">
              <div className="rs-team-head">
                <h2 id="rs-team">Your team</h2>
                <p>This repo brought its own agents. Check who reviews. The project's Agents page in Settings changes it later.</p>
              </div>
              <div className="rs-team-row">
                <span className="rs-team-text"><span id={reviewerLabel} className="rs-team-label">Reviewer</span><span data-gap={reviewerPick === KERNEL_REVIEWER && noReviewerAgent ? '' : undefined}>{reviewerNote}</span></span>
                <ReviewerPicker value={reviewerPick} agents={reviewers} disabled={busy !== null} labelledBy={reviewerLabel} onChange={setReviewer} />
              </div>
              {warnings.map((w) => <div key={w} className="rs-team-warn"><Icon name="warning" size={14} /><span>{w}</span></div>)}
            </section>
          )}
          <div className="ob-bar">
            <span role="status">{status}</span>
            <Button variant="primary" size="lg" disabled={!finished || busy !== null} busy={busy === 'open'} busyLabel="Opening" onClick={() => void open()}>Open the project</Button>
          </div>
          {finished && failed > 0 && <button type="button" className="ob-link" style={{ alignSelf: 'flex-start', marginTop: 12 }} onClick={() => { actions.ui.go({ name: 'projects' }) }}>All projects</button>}
        </div>
      </div>
    </div>
  )
}
