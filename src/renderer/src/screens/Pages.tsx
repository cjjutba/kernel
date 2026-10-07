import { useEffect, useState } from 'react'
import type { PreflightCheck } from '@shared/types'
import { call } from '../api'
import { Icon } from '../icons'
import { boot, go, loadRoom, pending, setState, useStore } from '../store'
import { ApprovalCard } from './Floor'

export function HomeScreen() {
  const rooms = useStore((s) => s.rooms)
  const needs = useStore(pending)
  const agents = useStore((s) => s.agents)
  const status = useStore((s) => s.status)
  const shipped = useStore((s) => s.workspaces.filter((w) => w.prState === 'merged').slice(-6).reverse())
  const hour = new Date().getHours()
  const working = Object.values(status).flatMap((m) => Object.values(m)).filter((x) => x === 'working' || x === 'planning').length
  return (
    <div className="panel">
      <header className="header"><Icon name="home" /><h1>Home</h1></header>
      <div className="grow" style={{ overflowY: 'auto', padding: '32px 40px' }}>
        <div className="row" style={{ alignItems: 'flex-end', marginBottom: 24 }}>
          <div className="col grow"><span style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.4px' }}>Good {hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, CJ</span><span className="muted" style={{ marginTop: 6 }}>{rooms.length} rooms, {working} agents working. {needs.length ? `${needs.length} things need you.` : 'Nothing needs you.'}</span></div>
          <button className="btn primary lg" onClick={() => setState({ modal: { name: 'newWorkspace' } })}><Icon name="plus" size={13} />New workspace</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 24 }}>
          <div className="col" style={{ gap: 12 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>Needs you {needs.length || ''}</span>
            {needs.length ? needs.slice(0, 5).map((a) => <ApprovalCard key={a.id} approval={a} agents={a.roomId ? agents[a.roomId] ?? [] : []} />) : <span className="muted">You're all caught up.</span>}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500, marginTop: 16 }}>Shipped recently</span>
            {shipped.map((w) => <button key={w.id} className="nav-item" onClick={() => go({ name: 'workspace', workspaceId: w.id })}><Icon name="branch" /><span className="grow ellipsis">{w.name}</span><span className="mono" style={{ fontSize: 12, color: 'var(--merged)' }}>#{w.prNumber}</span></button>)}
            {!shipped.length && <span className="muted">Merged work shows up here.</span>}
          </div>
          <div className="col" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>Rooms {rooms.length}</span>
            {rooms.map((r) => {
              const team = agents[r.id] ?? []
              const busy = team.filter((a) => ['working', 'planning'].includes(status[r.id]?.[a.id])).length
              return <button key={r.id} className="card col" style={{ padding: '12px 14px', gap: 4, textAlign: 'left', color: 'var(--ink)' }} onClick={() => go({ name: 'floor', roomId: r.id })}><span className="row"><span className="grow" style={{ fontWeight: 500 }}>{r.name}</span><span className="muted" style={{ fontSize: 12 }}>{r.paused ? 'Paused' : busy ? `${busy} working` : 'Idle'}</span></span><span className="mono muted" style={{ fontSize: 12 }}>{r.repo ?? r.path}</span></button>
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export function InboxScreen() {
  const approvals = useStore((s) => s.approvals)
  const agents = useStore((s) => s.agents)
  const [tab, setTab] = useState<'needs' | 'all'>('needs')
  const [sel, setSel] = useState<string | null>(null)
  const list = approvals.filter((a) => tab === 'all' || a.status === 'pending')
  const cur = list.find((a) => a.id === sel) ?? list[0]
  return (
    <div className="panel">
      <header className="header"><Icon name="inbox" /><h1>Inbox</h1></header>
      <div className="row" style={{ height: 44, padding: '0 12px', gap: 6, borderBottom: '1px solid var(--line)' }}>
        <button className="pill" aria-pressed={tab === 'needs'} onClick={() => setTab('needs')}>Needs you</button>
        <button className="pill" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>All</button>
      </div>
      <div className="grow" style={{ minHeight: 0, display: 'flex' }}>
        <div role="list" style={{ width: 400, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid var(--line)', padding: 6 }}>
          {list.map((a) => {
            const who = a.roomId ? agents[a.roomId]?.find((x) => x.id === a.agentId)?.name : undefined
            return <button key={a.id} role="listitem" aria-current={a.id === cur?.id} onClick={() => setSel(a.id)} className="col" style={{ width: '100%', padding: '10px 12px', border: 0, borderRadius: 8, background: a.id === cur?.id ? 'var(--surface-3)' : 'transparent', textAlign: 'left', gap: 2 }}>
              <span className="ellipsis" style={{ fontWeight: a.status === 'pending' ? 600 : 400 }}>{a.title}</span>
              <span className="muted" style={{ fontSize: 12 }}>{who ?? 'Agent'} · {a.kind} · {a.status}</span>
            </button>
          })}
        </div>
        <div className="grow" style={{ padding: '28px 40px', overflowY: 'auto' }}>
          {cur ? (cur.status === 'pending' ? <div style={{ maxWidth: 640 }}><ApprovalCard approval={cur} agents={cur.roomId ? agents[cur.roomId] ?? [] : []} /></div> : <div className="col" style={{ gap: 8, maxWidth: 640 }}><span style={{ fontSize: 18, fontWeight: 600 }}>{cur.title}</span><span className="muted">{cur.status}{cur.answer ? `: ${cur.answer}` : ''}</span></div>)
            : <div className="col" style={{ alignItems: 'center', gap: 8, paddingTop: 160, textAlign: 'center' }}><span style={{ fontSize: 15, fontWeight: 600 }}>You're all caught up</span><span className="muted">Approvals, plans and questions land here.</span></div>}
        </div>
      </div>
    </div>
  )
}

export function BoardScreen({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const ws = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.name !== 'lead'))
  const agents = useStore((s) => s.agents[roomId] ?? [])
  const cols: [string, (w: (typeof ws)[number]) => boolean][] = [
    ['Setting up', (w) => w.status === 'setup' || w.status === 'failed'],
    ['Building', (w) => w.status === 'ready' && w.prState === 'none'],
    ['In review', (w) => w.status !== 'archived' && !['none', 'merged', 'closed'].includes(w.prState)],
    ['Done', (w) => w.prState === 'merged']
  ]
  return (
    <div className="panel">
      <header className="header"><span className="ink2">{room?.name}</span><Icon name="right" size={12} /><h1>Board</h1></header>
      <div className="grow" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8, padding: 12, minHeight: 0 }}>
        {cols.map(([name, test]) => {
          const cards = ws.filter(test)
          return (
            <section key={name} className="col" style={{ gap: 6, padding: 4, borderRadius: 10, background: '#0c0d0e', minHeight: 0, overflowY: 'auto' }}>
              <div className="row" style={{ height: 34, padding: '0 8px' }}><h2 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>{name}</h2><span className="muted" style={{ fontSize: 12 }}>{cards.length}</span></div>
              {cards.map((w) => <button key={w.id} className="card col" style={{ padding: '10px 12px', gap: 6, textAlign: 'left', color: 'var(--ink)' }} onClick={() => go({ name: 'workspace', workspaceId: w.id })}><span style={{ fontWeight: 500 }}>{w.name}</span><span className="row muted" style={{ fontSize: 12 }}>{agents.find((a) => a.id === w.agentId)?.name ?? w.agentId}<span className="grow" />{w.prNumber ? `#${w.prNumber}` : ''}</span><span className="mono muted ellipsis" style={{ fontSize: 11 }}>{w.branch}</span></button>)}
            </section>
          )
        })}
      </div>
    </div>
  )
}

export function TeamScreen({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? [])
  const status = useStore((s) => s.status[roomId] ?? {})
  return (
    <div className="panel">
      <header className="header"><span className="ink2">{room?.name}</span><Icon name="right" size={12} /><h1>Team</h1></header>
      <div className="grow" style={{ overflowY: 'auto', padding: '20px 28px' }}>
        <p className="muted" style={{ margin: '0 0 16px' }}>Agents come from <span className="mono ink2">.claude/agents</span> in this repo. Ask the Lead to hire someone and they take a desk on the floor.</p>
        {agents.map((a) => (
          <div key={a.id} className="row" style={{ height: 64, borderTop: '1px solid #17181a', gap: 16, padding: '0 12px' }}>
            <span className="col grow"><span><span style={{ fontWeight: 500 }}>{a.name}</span> <span className="muted" style={{ fontSize: 12 }}>{a.role}{a.lead ? ' · Lead' : ''}</span></span><span className="muted ellipsis" style={{ fontSize: 12 }}>{a.description}</span></span>
            <span className="ink2" style={{ width: 110 }}>{a.model ?? 'default model'}</span>
            <span className="ink2" style={{ width: 90 }}>{status[a.id] ?? 'idle'}</span>
            <span className="mono muted ellipsis" style={{ width: 240, fontSize: 12 }}>{a.file.split('/.claude/')[1] ? '.claude/' + a.file.split('/.claude/')[1] : a.file}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function HistoryScreen() {
  const archived = useStore((s) => s.workspaces.filter((w) => w.status === 'archived').reverse())
  const rooms = useStore((s) => s.rooms)
  return (
    <div className="panel">
      <header className="header"><Icon name="history" /><h1>History</h1></header>
      <div className="grow" style={{ overflowY: 'auto', padding: '8px 20px' }}>
        {archived.map((w) => (
          <div key={w.id} className="row" style={{ height: 52, gap: 16, padding: '0 8px', borderTop: '1px solid #17181a' }}>
            <span className="grow" style={{ fontWeight: 500 }}>{w.name}</span>
            <span className="mono muted" style={{ width: 280, fontSize: 12 }}>{w.branch}</span>
            <span className="ink2" style={{ width: 120 }}>{rooms.find((r) => r.id === w.roomId)?.name}</span>
            <span style={{ width: 110, fontSize: 12.5, color: w.prState === 'merged' ? 'var(--merged)' : 'var(--muted)' }}>{w.prNumber ? `#${w.prNumber} ${w.prState}` : 'No PR'}</span>
          </div>
        ))}
        {!archived.length && <p className="muted" style={{ margin: 40 }}>Archived workspaces show up here.</p>}
      </div>
    </div>
  )
}

export function OnboardingScreen() {
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null)
  const [hooks, setHooks] = useState<string | null>(null)
  const recheck = () => call('preflight.run', undefined).then(setChecks)
  useEffect(() => { void recheck() }, [])
  const ready = checks?.every((c) => c.ok)
  const addRoom = async () => {
    const path = await call('system.pickFolder', undefined)
    if (!path) return
    const room = await call('rooms.add', { path })
    await boot(); await loadRoom(room.id)
    go({ name: 'floor', roomId: room.id })
  }
  return (
    <div className="panel" style={{ alignItems: 'center', paddingTop: 70 }}>
      <div className="col" style={{ width: 560, gap: 20 }}>
        <div className="col" style={{ gap: 6 }}><h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.4px' }}>Getting Kernel ready</h1><span className="muted">Kernel checks your Mac before it starts any agents.</span></div>
        <div className="card col">
          {(checks ?? []).map((c, i) => (
            <div key={c.id} className="col" style={{ gap: 10, padding: '14px 16px', borderTop: i ? '1px solid var(--line)' : 0 }}>
              <div className="row" style={{ gap: 12 }}><span style={{ color: c.ok ? 'var(--add)' : 'var(--del)' }}><Icon name={c.ok ? 'check' : 'x'} size={15} stroke={1.7} /></span><span className="col grow"><span style={{ fontWeight: 500 }}>{c.title}</span><span className="muted" style={{ fontSize: 12.5 }}>{c.detail}</span></span></div>
              {!c.ok && c.fix?.command && <div className="code selectable" style={{ marginLeft: 27 }}>{c.fix.command}</div>}
            </div>
          ))}
          {!checks && <div className="row muted" style={{ padding: 16 }}><span className="spin" />Checking</div>}
        </div>
        <div className="row">
          <button className="btn" onClick={() => void recheck()}>Check again</button>
          <button className="btn" onClick={async () => { const r = await call('hooks.install', { port: 7420 }); setHooks(`Installed ${r.events.length} hooks in ${r.path}`) }}>Install hooks</button>
          <span className="grow muted" style={{ fontSize: 12.5 }}>{hooks}</span>
          <button className="btn primary lg" disabled={!ready} onClick={() => void addRoom()}>Add a room</button>
        </div>
      </div>
    </div>
  )
}
