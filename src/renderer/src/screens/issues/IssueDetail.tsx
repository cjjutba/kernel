import { useEffect, useMemo, useState } from 'react'
import type { LinearIssue, LinearIssueDetail, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon, Skeleton, useBusy } from '../../ui'
import { IssuePriority, IssueState, PRIORITIES } from '../../icons'
import { openLeadChat } from '../../lead'
import { roomLetter } from '../rooms/roomInfo'
import { useProjectRoom } from '../settings/useSettings'
import { Markdown } from '../workspace/markdown'
import { initials, issueAge, linkedWorkspaces, stateShape, workspaceState } from './model'

function Linked({ ws }: { ws: Workspace }) {
  const agent = useStore((s) => s.agents[ws.roomId]?.find((a) => a.id === ws.agentId))
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  return (
    <li className="is-ws">
      <span className="is-av is-av-lg" aria-hidden="true">{(agent?.name ?? ws.name)[0].toUpperCase()}</span>
      <span className="col grow">
        <span className="ellipsis"><span className="is-ws-name">{ws.name}</span>{agent && <span className="muted is-ws-agent">{agent.name}</span>}</span>
        <span className="mono muted ellipsis is-ws-branch">{ws.branch}</span>
      </span>
      <span className="is-ws-state">{workspaceState(ws, running, true)}</span>
      <Button aria-label={`Open ${ws.name}`} onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>Open</Button>
    </li>
  )
}

/** The selected issue: what Linear says about it, the workspaces already working on it, and the buttons that start work. */
export function IssueDetail({ id, summary, tick, onPlanned }: { id: string; summary?: LinearIssue; tick: number; onPlanned: () => void }) {
  const [loaded, setLoaded] = useState<LinearIssueDetail | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, run] = useBusy<'plan' | 'link'>()
  const [picked, setPicked] = useState<{ issue: string; room: string } | null>(null)
  const [settled, setSettled] = useState(false)
  const rooms = useStore((s) => s.rooms)
  const roomSettings = useStore((s) => s.roomSettings)
  const agents = useStore((s) => s.agents)
  const workspaces = useStore((s) => s.workspaces)
  const projectRoom = useProjectRoom()

  // The description and comments come from `linear.issue`. The list already has the rest, so the header shows at once.
  useEffect(() => {
    let live = true
    setFailed(null)
    call('linear.issue', { id }).then((d) => live && setLoaded(d)).catch((e: Error) => live && setFailed(e.message))
    return () => { live = false }
  }, [id, tick])
  const issue: LinearIssue | undefined = loaded?.id === id ? loaded : summary
  const detail = loaded?.id === id ? loaded : null

  const choices = useMemo(() => rooms.filter((r) => !r.archived && !r.hidden), [rooms])
  const ids = choices.map((r) => r.id).join(',')
  // Each room's Linear team is in its settings file, so read them all before saying a team has no room.
  useEffect(() => {
    let live = true
    setSettled(false)
    void Promise.allSettled(choices.map((r) => call('settings.room', { roomId: r.id }).then((rs) => actions.settings.setRoom(r.id, rs)))).then(() => live && setSettled(true))
    return () => { live = false }
  }, [ids])

  const team = issue?.team.key
  const linkedRoom = team ? choices.find((r) => roomSettings[r.id]?.linear?.team?.toUpperCase() === team.toUpperCase()) : undefined
  const room = choices.find((r) => r.id === (picked?.issue === id ? picked.room : undefined)) ?? linkedRoom ?? choices.find((r) => r.id === projectRoom?.id) ?? choices[0]
  const lead = (room && agents[room.id]?.find((a) => a.lead)?.name) || 'Rowan'
  const linked = linkedWorkspaces(id, workspaces)
  const unlinked = !!issue && settled && !linkedRoom && !!room

  const plan = () => room && run('plan', async () => {
    try {
      const { chatId } = await call('linear.plan', { id, roomId: room.id })
      onPlanned()
      await openLeadChat(room.id, chatId)
    } catch (e) { actions.ui.toast({ title: `Could not plan with ${lead}`, sub: (e as Error).message }) }
  })
  const link = () => room && team && run('link', async () => {
    try { actions.settings.setRoom(room.id, await call('settings.setRoom', { roomId: room.id, patch: { linear: { team } } })) }
    catch (e) { actions.ui.toast({ title: `Could not link ${team} to ${room.name}`, sub: (e as Error).message }) }
  })
  const newChat = () => issue && actions.ui.openModal({ name: 'newWorkspace', roomId: room?.id, source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url } })

  if (!issue) {
    return (
      <article className="is-detail" aria-label={id} aria-busy={!failed || undefined}>
        <div className="is-scroll"><div className="is-inner">
          <span className="mono muted is-key">{id}</span>
          {failed ? <p className="muted">Could not load this issue. {failed}</p> : <Skeleton width="60%" height={26} />}
        </div></div>
      </article>
    )
  }

  const cycle = issue.cycle ? issue.cycle.name || `Cycle ${issue.cycle.number}` : 'No cycle'
  return (
    <article className="is-detail" aria-label={issue.title}>
      <div className="is-scroll">
        <div className="is-inner">
          <div className="col" style={{ gap: 6 }}>
            <span className="mono muted is-key">{issue.id}</span>
            <h2>{issue.title}</h2>
          </div>

          <dl className="is-facts">
            <dt>Status</dt>
            <dd><IssueState shape={stateShape(issue.state.type)} />{issue.state.name}</dd>
            <dt>Project</dt>
            <dd>{issue.project?.name ?? <span className="muted">No project</span>}</dd>
            <dt>Priority</dt>
            <dd><IssuePriority priority={issue.priority} label />{PRIORITIES[issue.priority] ?? PRIORITIES[0]}</dd>
            <dt>Cycle</dt>
            <dd>{issue.cycle ? cycle : <span className="muted">{cycle}</span>}</dd>
            <dt>Assignee</dt>
            <dd>{issue.assignee ? <><span className="is-av" aria-hidden="true">{initials(issue.assignee.name)}</span>{issue.assignee.name}</> : <span className="muted">Unassigned</span>}</dd>
            <dt>Labels</dt>
            <dd>{issue.labels.length ? issue.labels.map((l) => <span key={l} className="is-label">{l}</span>) : <span className="muted">None</span>}</dd>
          </dl>

          {linked.length > 0 && (
            <section aria-label="Linked workspaces" className="is-sec">
              <h3>Linked workspaces</h3>
              <ul className="is-linked">{linked.map((w) => <Linked key={w.id} ws={w} />)}</ul>
            </section>
          )}

          {detail ? (
            <>
              {detail.description.trim() && <Markdown className="is-desc" text={detail.description} />}
              <section aria-label="Comments" className="is-sec">
                <h3>Comments{detail.comments.length > 0 && <span className="is-count">{detail.comments.length}</span>}</h3>
                {detail.comments.length === 0 && <p className="muted" style={{ margin: 0 }}>No comments yet.</p>}
                {detail.comments.map((c) => (
                  <div key={c.id} className="is-comment">
                    <span className="is-av is-av-md" aria-hidden="true">{initials(c.author ?? '?')}</span>
                    <span className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span><span className="is-who">{c.author ?? 'Linear'}</span><span className="muted is-when">{issueAge(c.createdAt)} ago</span></span>
                      <Markdown className="is-body" text={c.body} />
                    </span>
                  </div>
                ))}
              </section>
            </>
          ) : failed ? (
            <p className="muted" style={{ margin: 0 }}>Could not load the description. {failed}</p>
          ) : (
            <div className="col" style={{ gap: 8 }} aria-busy="true"><Skeleton width="85%" /><Skeleton width="70%" /><Skeleton width="40%" /></div>
          )}
        </div>
      </div>

      <div className="is-foot">
        <div className="is-inner">
          {unlinked && room && (
            <div role="status" className="banner is-link">
              <Icon name="link" />
              <div className="grow"><div className="banner-title">{team} isn't linked to a room</div><div className="muted">Link it to {room.name} so its issues open there by default.</div></div>
              <Button variant="primary" busy={busy === 'link'} busyLabel="Linking" disabled={busy !== null} onClick={() => void link()}>Link {team} to {room.name}</Button>
            </div>
          )}
          <div className="is-actions">
            {room && (
              <span className="is-room">
                <span className="muted">Room</span>
                <span className="is-letter" aria-hidden="true">{roomLetter(room.name)}</span>
                <span>{room.name}</span>
                <Icon name="chevron" size={10} stroke={1.9} />
                <select aria-label={`Room: ${room.name}`} value={room.id} onChange={(e) => setPicked({ issue: id, room: e.target.value })}>
                  {choices.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </span>
            )}
            <span className="grow" />
            <a className="btn lg" href={issue.url} target="_blank" rel="noreferrer">Open in Linear<Icon name="ext" size={11} stroke={1.8} /></a>
            <Button size="lg" disabled={!room} onClick={newChat}>New chat</Button>
            <Button size="lg" variant="primary" busy={busy === 'plan'} busyLabel="Sending" disabled={!room || busy !== null} onClick={() => void plan()}>Plan with {lead}</Button>
          </div>
        </div>
      </div>
    </article>
  )
}
