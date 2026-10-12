import { useEffect, useState } from 'react'
import type { AgentDef, TeamPatch } from '@shared/types'
import { KERNEL_LEAD, KERNEL_REVIEWER, NO_REVIEWER, reviewerChoice } from '@shared/team'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { openRoom } from '../../lead'
import { Button, CodeBlock, Icon, Select, Spinner, useBusy } from '../../ui'
import { warningText } from '../team/model'
import { getDraft } from './draft'
import '../onboarding/onboarding.css'
import './rooms.css'

const NO_AGENTS: AgentDef[] = []
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)

/** "`.env` and `.env.production`": the files by name, in mono, joined the way a sentence lists them. */
function fileList(paths: string[]) {
  return paths.map((p, i) => <span key={p}>{i === 0 ? '' : i === paths.length - 1 ? ' and ' : ', '}<code>{p}</code></span>)
}

/** The copy step's warning (RoomSetupWarnings.png): the copied files that look like production, by name only (KERNEL-449). */
function ProductionNote({ paths }: { paths: string[] }) {
  return <span className="ob-detail rs-note">{paths.length} {paths.length === 1 ? 'looks' : 'look'} like production: {fileList(paths)}. Agents run commands in each worktree, so a migration there could reach a live database.</span>
}

/**
 * RoomSetup.png: clone, folders, install, files, hooks, push access, agents. Progress comes from `room.setup` push events.
 * RoomSetupWarnings.png: a step that finished with something to fix warns, and the room still opens (KERNEL-460).
 * RoomSetupGitHub.png and RoomSetupLocal.png: the code host read from the checkout, after the first step (KERNEL-477).
 * RoomSetupTeam.png: a repo that brought its own agents shows its team once setup is done, to check who leads and who
 * reviews before the room opens (KERNEL-397).
 */
export function RoomSetup({ roomId }: { roomId?: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const steps = useStore((s) => (roomId ? s.roomSetup[roomId] : undefined))
  const agents = useStore((s) => (roomId ? s.agents[roomId] ?? NO_AGENTS : NO_AGENTS))
  const rs = useStore((s) => (roomId ? s.roomSettings[roomId] : undefined))
  const finished = !!steps && steps.every((s) => s.state === 'ok' || s.state === 'warn' || s.state === 'fail')
  const failed = steps?.filter((s) => s.state === 'fail').length ?? 0
  // A warning never stops the room opening, but it stops Brief Rowan right away, so the user sees it (KERNEL-437).
  const warned = steps?.filter((s) => s.state === 'warn').length ?? 0
  const seated = steps?.find((s) => s.id === 'agents')
  const team = agents.filter((a) => !a.retired)
  const review = finished && seated?.state === 'ok' && !!seated.brought && team.length > 0
  const warnings = team.flatMap((a) => (a.warnings ?? []).map((w) => `${a.name}: ${lower(warningText(w))}`))
  const leadNow = team.find((a) => a.lead)?.id ?? KERNEL_LEAD
  const reviewerNow = reviewerChoice(team, rs?.team)
  const [lead, setLead] = useState<string>()
  const [reviewer, setReviewer] = useState<string>()
  const [busy, run] = useBusy()
  const files = team.filter((a) => !a.builtIn)
  // The team the repo brought is saved as checked, and only what changed goes to settings.toml (KERNEL-397).
  const open = () => run('open', async () => {
    if (!roomId) return
    if (review) {
      const patch: TeamPatch = {}
      if (lead && lead !== leadNow) patch.lead = lead
      if (reviewer && reviewer !== reviewerNow) patch.reviewer = reviewer
      try { await call('agents.setTeam', { roomId, team: patch, from: 'setup' }) } catch (e) { actions.ui.toast({ title: 'Could not change the team', sub: cleanError(e) }); return }
    }
    await openRoom(roomId)
  })
  // "Brief Rowan right away" in New room: when setup finishes cleanly, land in Rowan's chat (D-104). A team the repo brought
  // with something to look at waits for Open the room.
  const teamPending = finished && seated?.state === 'ok' && !!seated.brought && !team.length
  useEffect(() => { if (finished && !failed && !warned && !teamPending && getDraft().autostart && roomId && !(review && warnings.length)) void openRoom(roomId) }, [finished, failed, warned, teamPending, roomId]) // eslint-disable-line react-hooks/exhaustive-deps
  // The repo's [team], read once setup has its files, so a repo that turns review off shows No reviewer (KERNEL-553).
  useEffect(() => { if (review && roomId) void call('settings.room', { roomId }).then((r) => actions.settings.setRoom(roomId, r)).catch(() => undefined) }, [review, roomId])
  const recheck = () => run('recheck', async () => {
    if (!roomId) return
    try { await call('rooms.pushCheck', { roomId, recheck: true }) } catch (e) { actions.ui.toast({ title: 'Could not check push access', sub: cleanError(e) }) }
  })
  const leadName = team.find((a) => a.lead)?.name ?? 'Rowan'
  const status = finished && failed ? `${failed} ${failed === 1 ? 'step' : 'steps'} did not finish. You can still open the room.`
    : finished && warned ? `${warned} ${warned === 1 ? 'thing needs' : 'things need'} your attention. ${leadName} is waiting for a brief.`
      : 'You can leave this screen. Kernel keeps going.'

  return (
    <div className="panel" style={{ background: 'transparent', border: 0 }}>
      <div className={review ? 'ob-page rs-review' : 'ob-page'}>
        <div className="ob-col">
          <h1 className="ob-h1">Setting up {room?.name ?? 'your room'}</h1>
          <p className="ob-sub">This takes a minute. Your team is ready when it finishes.</p>
          <div className="ob-list" aria-busy={!finished}>
            {(steps ?? []).map((s) => (
              <div key={s.id} className="ob-check" data-state={s.state} data-ok={s.state !== 'fail'}>
                <span className="ob-ico rs-ico" data-state={s.state}>
                  {s.state === 'ok' && <Icon name="check" size={15} stroke={1.7} />}
                  {s.state === 'warn' && <Icon name="warning" size={15} />}
                  {s.state === 'fail' && <Icon name="x" size={15} />}
                  {s.state === 'run' && <Spinner label={`${s.title} is running`} />}
                  {s.state === 'wait' && <span aria-label="Waiting" className="rs-dash">–</span>}
                </span>
                <div className="ob-body">
                  <span className="ob-name" style={s.state === 'wait' ? { color: 'var(--muted)', fontWeight: 400 } : undefined}>{s.title}</span>
                  <span className="ob-detail">{s.detail}</span>
                  {s.error && <span className="ob-detail rs-error" role="alert">{s.error}</span>}
                  {s.output && <pre className="code boxed rs-out">{s.output}</pre>}
                  {s.fix?.command && <div className="ob-fix"><CodeBlock inline>{s.fix.command}</CodeBlock></div>}
                  {s.fix?.action === 'recheck' && (
                    <div className="ob-acts rs-acts">
                      <Button variant="secondary" busy={busy === 'recheck'} busyLabel="Checking" disabled={busy !== null} onClick={() => void recheck()}>Check again</Button>
                    </div>
                  )}
                  {s.state === 'warn' && !!s.production?.length && (
                    <>
                      <ProductionNote paths={s.production} />
                      <div className="ob-acts rs-acts"><Button onClick={() => roomId && actions.ui.go({ name: 'settings', page: 'room', roomId, section: 'files' })}>Review files</Button></div>
                    </>
                  )}
                </div>
                {s.meta && s.state !== 'warn' && <span className="ob-meta">{s.meta}</span>}
              </div>
            ))}
            {!steps && <div className="ob-check"><Spinner label="Starting" /><span className="muted">Starting</span></div>}
          </div>
          {review && (
            <section className="rs-team" aria-labelledby="rs-team">
              <div className="rs-team-head">
                <h2 id="rs-team">Your team</h2>
                <p>This repo brought its own agents. Check who leads and who reviews. Settings, Agents changes it later.</p>
              </div>
              <div className="rs-team-row">
                <span className="rs-team-text"><span className="rs-team-label">Lead</span><span>Plans with you and hands out tasks</span></span>
                <Select label="Lead" value={lead ?? leadNow} disabled={busy !== null} onChange={(e) => setLead(e.target.value)} options={[...files.map((a) => ({ value: a.id, label: a.name })), { value: KERNEL_LEAD, label: 'Rowan, from Kernel' }]} />
              </div>
              <div className="rs-team-row">
                <span className="rs-team-text"><span className="rs-team-label">Reviewer</span><span>Reviews each pull request before it merges</span></span>
                <Select label="Reviewer" value={reviewer ?? reviewerNow} disabled={busy !== null} onChange={(e) => setReviewer(e.target.value)} options={[...files.filter((a) => a.id !== (lead ?? leadNow)).map((a) => ({ value: a.id, label: a.name })), { value: KERNEL_REVIEWER, label: 'Kernel’s code review' }, { value: NO_REVIEWER, label: 'No reviewer' }]} />
              </div>
              {warnings.map((w) => <div key={w} className="rs-team-warn"><Icon name="warning" size={14} /><span>{w}</span></div>)}
            </section>
          )}
          <div className="ob-bar">
            <span role="status">{status}</span>
            <Button variant="primary" size="lg" disabled={!finished || busy !== null} busy={busy === 'open'} busyLabel="Opening" onClick={() => void open()}>Open the room</Button>
          </div>
          {finished && failed > 0 && <button type="button" className="ob-link" style={{ alignSelf: 'flex-start', marginTop: 12 }} onClick={() => { actions.ui.go({ name: 'rooms' }) }}>All rooms</button>}
        </div>
      </div>
    </div>
  )
}
