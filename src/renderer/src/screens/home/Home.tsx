import { useMemo, useState } from 'react'
import type { Approval, Decision, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon } from '../../ui'
import { attempt } from '../workspace/MessageActions'
import { inboxItems, needsYou, type InboxItem } from '../inbox/model'
import { openNewRoom, resetDraft } from '../rooms/draft'
import { roomLetter, roomState, sourceOf, stateLabel } from '../rooms/roomInfo'
import './home.css'
import { SidebarToggle } from '../../components/PanelToggles'

const decide = (a: Approval, decision: Decision) => attempt('Could not send your answer', async () => actions.approvals.upsert(await call('approvals.decide', { id: a.id, decision })))
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const dayKey = (ts: number) => new Date(ts).toDateString()

function dayLabel(ts: number, now: number) {
  if (dayKey(ts) === dayKey(now)) return 'Today'
  if (dayKey(ts) === dayKey(now - 86_400_000)) return 'Yesterday'
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function NeedsRow({ item }: { item: InboxItem }) {
  const { n, approval: a } = item
  const agents = useStore((s) => (n.roomId ? s.agents[n.roomId] : undefined)) ?? []
  const room = useStore((s) => s.rooms.find((r) => r.id === n.roomId))
  const agent = agents.find((x) => x.id === n.agentId)
  const who = agent?.name ?? 'An agent'
  const letter = room ? roomLetter(room.name) : 'K'
  const input = (a?.input ?? {}) as Record<string, unknown>
  const plan = !!a && (a.kind === 'plan' || a.toolName === 'ExitPlanMode')
  const toFloor = () => go(n.roomId ? { name: 'floor', roomId: n.roomId } : { name: 'inbox' })
  let text: React.ReactNode, actionsEl: React.ReactNode
  if (a && a.kind === 'tool' && !plan) {
    text = a.toolName === 'Bash'
      ? <><span>{who} wants to run</span><code className="hm-cmd">{String(input.command ?? '').split('\n')[0]}</code></>
      : <span>{who} wants to {a.title.charAt(0).toLowerCase()}{a.title.slice(1)}</span>
    actionsEl = (
      <>
        <Button onClick={() => void decide(a, { behavior: 'deny', message: 'Denied in Kernel.' })} aria-label={`Deny: ${a.title}`}>Deny</Button>
        <Button variant="primary" onClick={() => void decide(a, { behavior: 'allow' })} aria-label={`Approve: ${a.title}`}>Approve</Button>
      </>
    )
  } else if (plan) {
    text = <><span>{/^Plan\b/i.test(a.title) ? `${a.title} is ready` : `Plan ready: ${a.title}`}</span><span className="hm-by">{who}{room ? ` · ${room.name}` : ''}</span></>
    actionsEl = <Button onClick={toFloor}>Review plan</Button>
  } else if (a) {
    text = <><span>{a.kind === 'question' ? a.title : n.title}</span><span className="hm-by">{who}{room ? ` · ${room.name}` : ''}</span></>
    actionsEl = <Button onClick={() => go({ name: 'inbox' })}>{a.kind === 'question' ? 'Answer' : 'Review'}</Button>
  } else {
    text = <><span>{n.title}</span><span className="hm-by">{who}{room ? ` · ${room.name}` : ''}</span></>
    actionsEl = <Button onClick={() => (n.workspaceId ? go({ name: 'workspace', workspaceId: n.workspaceId }) : toFloor())}>{n.kind === 'merge' ? 'Open PR' : 'Open'}</Button>
  }
  return (
    <div className="hm-need">
      <span className="hm-av" aria-hidden="true">{letter}</span>
      <span className="hm-need-text">{text}{a && a.kind === 'tool' && !plan && room && <span className="hm-by">{room.name}</span>}</span>
      <span className="hm-need-acts">{actionsEl}</span>
    </div>
  )
}

function Shipped({ list }: { list: Workspace[] }) {
  const agents = useStore((s) => s.agents)
  const rooms = useStore((s) => s.rooms)
  const now = Date.now()
  const groups: [string, Workspace[]][] = []
  for (const w of list) {
    const label = dayLabel(w.mergedAt ?? w.createdAt, now)
    const g = groups.find((x) => x[0] === label)
    if (g) g[1].push(w); else groups.push([label, [w]])
  }
  return (
    <>
      {groups.map(([label, rows]) => (
        <div key={label}>
          <div className="hm-day">{label}</div>
          {rows.map((w) => {
            const agent = agents[w.roomId]?.find((a) => a.id === w.agentId)
            return (
              <button key={w.id} type="button" className="hm-ship" onClick={() => go({ name: 'workspace', workspaceId: w.id })}>
                <span className="hm-av" aria-hidden="true">{(agent?.name ?? w.agentId)[0]?.toUpperCase()}</span>
                <span className="hm-ship-title ellipsis">{w.prTitle ?? w.title ?? w.name}</span>
                <span className="hm-ship-room ellipsis">{rooms.find((r) => r.id === w.roomId)?.name}</span>
                <span className="hm-stat mono">{w.stat && <><span className="add">+{w.stat.added}</span><span className="del">-{w.stat.removed}</span></>}</span>
                <span className="hm-time mono">{clock(w.mergedAt ?? w.createdAt)}</span>
              </button>
            )
          })}
        </div>
      ))}
    </>
  )
}

function Welcome() {
  const [text, setText] = useState('')
  const start = (patch: Parameters<typeof openNewRoom>[0]) => openNewRoom(patch)
  const send = () => start({ source: 'scratch', desc: text.trim() })
  return (
    <div className="panel">
      <header className="header"><SidebarToggle /><Icon name="home" /><h1>Home</h1></header>
      <div className="hm-welcome">
        <span className="hm-mark" aria-hidden="true"><Icon name="floor" size={120} stroke={0.6} /></span>
        <h2>Welcome to Kernel</h2>
        <p>A room links a project to a team of Claude Code agents. Start with one.</p>
        <div className="hm-ask">
          <textarea aria-label="Describe what you want to build" placeholder="Describe what you want to build, and Rowan sets up the room" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && text.trim()) { e.preventDefault(); send() } }} />
          <div className="row">
            <span className="hm-lead"><span className="hm-lead-av" aria-hidden="true">R</span>Rowan · Lead</span>
            <span className="grow" />
            <button type="button" className="hm-send" aria-label="Start the room" disabled={!text.trim()} onClick={send}><Icon name="up" size={14} /></button>
          </div>
        </div>
        <div className="hm-or">Or start from</div>
        <div className="hm-starts">
          <button type="button" onClick={() => { resetDraft({ source: 'repo' }); actions.ui.openModal({ name: 'connectRepo' }) }}><Icon name="branch" size={16} /><b>Connect a repo</b><span>Agents work on branches and open PRs for you</span></button>
          <button type="button" onClick={() => { resetDraft({ source: 'folder', baseBranch: '' }); actions.ui.openModal({ name: 'openFolder' }) }}><Icon name="folder" size={16} /><b>Open a folder</b><span>Point a team at a project already on your Mac</span></button>
          <button type="button" onClick={() => start({ source: 'scratch' })}><Icon name="burst" size={16} /><b>Start from scratch</b><span>New project from your starter kit</span></button>
        </div>
      </div>
    </div>
  )
}

/** Home.png and HomeEmpty.png: what needs you, what shipped, and every room's status. */
export function Home() {
  const rooms = useStore((s) => s.rooms.filter((r) => !r.archived))
  const notifications = useStore((s) => s.notifications)
  const approvals = useStore((s) => s.approvals)
  const allRooms = useStore((s) => s.rooms)
  const agents = useStore((s) => s.agents)
  const status = useStore((s) => s.status)
  const workspaces = useStore((s) => s.workspaces)
  const account = useStore((s) => s.account)
  const needs = useMemo(() => inboxItems(notifications, approvals, allRooms).filter(needsYou), [notifications, approvals, allRooms])
  const shipped = useMemo(() => workspaces.filter((w) => w.prState === 'merged').sort((a, b) => (b.mergedAt ?? b.createdAt) - (a.mergedAt ?? a.createdAt)).slice(0, 8), [workspaces])
  if (!rooms.length) return <Welcome />
  const working = rooms.reduce((n, r) => n + Object.values(status[r.id] ?? {}).filter((x) => x === 'working' || x === 'planning' || x === 'walking').length, 0)
  const hour = new Date().getHours()
  const first = account?.name?.split(' ')[0]
  return (
    <div className="panel">
      <header className="header"><SidebarToggle /><Icon name="home" /><h1>Home</h1></header>
      <div className="hm-scroll">
        <div className="hm-page">
          <div className="hm-top">
            <div className="col grow">
              <h2 className="hm-hello">Good {hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}{first ? `, ${first}` : ''}</h2>
              <p className="hm-count">{rooms.length} {rooms.length === 1 ? 'room' : 'rooms'}, {working} {working === 1 ? 'agent' : 'agents'} working. {needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you.` : 'Nothing needs you.'}</p>
            </div>
            <Button onClick={() => go({ name: 'rooms' })}>All rooms</Button>
            <Button variant="primary" icon="plus" onClick={() => openNewRoom()}>New room</Button>
          </div>
          <div className="hm-cols">
            <div className="col" style={{ gap: 28, minWidth: 0 }}>
              <section aria-label="Needs you">
                <h3 className="hm-head">Needs you <span>{needs.length}</span></h3>
                {needs.length ? needs.slice(0, 5).map((i) => <NeedsRow key={i.n.id} item={i} />) : <p className="hm-none">Nothing is waiting on you.</p>}
              </section>
              <section aria-label="Shipped recently">
                <h3 className="hm-head">Shipped recently <span>{shipped.length}</span></h3>
                {shipped.length ? <Shipped list={shipped} /> : <p className="hm-none">Merged work shows up here.</p>}
              </section>
            </div>
            <section aria-label="Rooms">
              <h3 className="hm-head">Rooms <span>{rooms.length}</span><span className="grow" /><button type="button" className="hm-see" onClick={() => go({ name: 'rooms' })}>See all</button></h3>
              <div className="col hm-rooms" style={{ gap: 10, marginTop: 10 }}>
                {rooms.map((r) => {
                  const team = agents[r.id] ?? []
                  const state = roomState(r, approvals, status[r.id])
                  return (
                    <button key={r.id} type="button" className="hm-room" onClick={() => go({ name: 'floor', roomId: r.id })}>
                      <span className="hm-room-top"><span className="hm-av" aria-hidden="true">{roomLetter(r.name)}</span><b>{r.name}</b><span className="grow" /><span className="hm-state" data-state={state}>{r.paused ? 'Paused' : stateLabel[state]}</span></span>
                      <span className="hm-room-sub"><span className="mono ellipsis">{sourceOf(r)}</span><span className="grow" />{team.length ? `${team.length} ${team.length === 1 ? 'agent' : 'agents'}` : ''}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
