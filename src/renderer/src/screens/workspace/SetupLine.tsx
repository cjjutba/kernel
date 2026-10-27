import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Project, ProjectSetupStep } from '@shared/types'
import { actions } from '../../store'
import { Icon, Popover, Spinner } from '../../ui'

/** The toasts already raised for a step's state, so leaving New chat and coming back doesn't raise them twice. */
const toasted = new Set<string>()

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** The line that names a step that is running, written as what Kernel is doing. */
const doing = (s: ProjectSetupStep) => s.title.replace(/^Create the worktree folder$/i, 'Creating the worktree folder')

/** What a finished step says in the Details list. */
function doneTitle(s: ProjectSetupStep): string {
  switch (s.id) {
    case 'clone': return s.title.replace(/^Clone/, 'Cloned').replace(/^Create/, 'Created')
    case 'github': return s.title.replace(/^Create /, 'Created ')
    case 'worktrees': return 'Created the worktree folder'
    case 'copy': return s.state === 'warn' ? 'Copied local files, with some left out' : 'Copied local files'
    case 'hooks': return 'Installed hooks'
    case 'push': return s.state === 'warn' ? 'Push access needs a look' : 'Checked push access'
    case 'agents': return 'Seated agents'
    default: return s.title
  }
}

/** The toast for a step that could not finish, or finished with a warning. Setup never blocks, so this is where the error lives. */
function stepToast(project: Project, s: ProjectSetupStep) {
  const key = `${project.id}:${s.id}:${s.state}`
  if (toasted.has(key)) return
  toasted.add(key)
  const retry = { label: 'Try again', retrySetup: project.id, primary: true }
  if (s.state === 'fail') {
    actions.ui.toast({ title: `Couldn't ${lower(s.title)}`, sub: s.error ?? s.detail, glyph: 'error', action: retry })
  } else if (s.id === 'copy' && s.production?.length) {
    actions.ui.toast({ title: `Skipped ${s.production.length} local ${s.production.length === 1 ? 'file' : 'files'}`, sub: `${s.production.join(' and ')} look${s.production.length === 1 ? 's' : ''} like production, so Kernel left ${s.production.length === 1 ? 'it' : 'them'} out of the worktrees.`, glyph: 'error', action: { label: 'Review files', route: { name: 'settings', page: 'project', projectId: project.id, section: 'environment' }, primary: true } })
  } else {
    actions.ui.toast({ title: s.title, sub: s.detail, glyph: 'error', ...(s.fix?.command ? { other: { label: 'Copy fix', copy: s.fix.command } } : {}), action: { label: 'Check again', ...(s.id === 'push' ? { recheckPush: project.id } : { retrySetup: project.id }), primary: true } })
  }
}

/**
 * Project setup as one line under the composer (KERNEL-1089): the project, the step in progress, how far along, and Details. It
 * never blocks the box. A step that fails or is skipped turns the line into "<project> is ready" and raises a toast with the error.
 */
export function SetupLine({ project, steps }: { project: Project; steps: ProjectSetupStep[] }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const counted = steps.filter((s) => s.id !== 'host')
  const running = steps.some((s) => s.state === 'run')
  const ended = !running && (steps.some((s) => s.state === 'fail') || steps.every((s) => s.id === 'host' || s.state !== 'wait'))
  const settled = counted.filter((s) => s.state === 'ok' || s.state === 'warn' || s.state === 'fail').length
  const current = counted.find((s) => s.state === 'run') ?? counted.find((s) => s.state === 'wait')
  const problems = counted.filter((s) => s.state === 'warn' || s.state === 'fail')
  const skipped = problems[0]
  useEffect(() => {
    // A step that runs again can raise its toast again, so a retry that fails once more still shows its error and Try again.
    for (const s of counted) if (s.state === 'run' || s.state === 'wait') for (const st of ['fail', 'warn']) toasted.delete(`${project.id}:${s.id}:${st}`)
    if (ended) for (const s of problems) stepToast(project, s)
  }, [ended, steps])
  if (ended && !problems.length) return null
  return (
    <div className="su-line" aria-label="Project setup" aria-busy={!ended}>
      {(!ended || problems.length > 0) && (
        <div className="su-main">
          <span className="su-lead">
            {!ended && <Spinner label={null} pattern="snake" />}
            <span className="su-name">{ended ? `${project.name} is ready` : `Getting ${project.name} ready`}</span>
          </span>
          <span className="su-sep" aria-hidden>·</span>
          <span className="su-step" role="status">{ended ? `${skipped?.title ?? 'A step'} was skipped` : current ? doing(current) : 'Finishing up'}</span>
          {!ended && <><span className="su-sep" aria-hidden>·</span><span className="su-n">{Math.min(settled + 1, counted.length)} of {counted.length}</span></>}
          <span ref={anchor} className="su-more">
            <span className="su-sep" aria-hidden>·</span>
            <button type="button" className="su-details" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>Details</button>
            <Popover open={open} onClose={() => setOpen(false)} label="Setup details" side="top" align="left" className="su-pop" anchorRef={anchor as RefObject<HTMLElement | null>}>
              <div className="su-pop-head"><span className="su-pop-title">Setup</span><span className="muted">{settled} of {counted.length}</span></div>
              <ul className="su-pop-rows">
                {counted.map((s) => (
                  <li key={s.id} className="su-pop-row" data-state={s.state}>
                    <span className="su-pop-ico">{s.state === 'run' ? <Spinner label={null} pattern="snake" /> : s.state === 'ok' ? <Icon name="check" size={14} /> : s.state === 'wait' ? null : <Icon name="close" size={14} />}</span>
                    <span className="su-pop-text">{s.state === 'run' ? doing(s) : s.state === 'wait' ? s.title : doneTitle(s)}</span>
                    {s.state === 'ok' && s.meta && <span className="su-pop-meta">{s.meta}</span>}
                  </li>
                ))}
              </ul>
              <div className="su-pop-foot">
                <button type="button" className="su-pop-log" onClick={() => { setOpen(false); actions.ui.openModal({ name: 'setupLog', projectId: project.id }) }}><Icon name="scrollText" size={14} />Open the setup log</button>
              </div>
            </Popover>
          </span>
        </div>
      )}
      {!ended && <div className="su-track" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={counted.length} aria-valuenow={settled}><span className="su-fill" style={{ width: `${counted.length ? (settled / counted.length) * 100 : 0}%` }} /></div>}
    </div>
  )
}
