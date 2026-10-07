import { useEffect, useState } from 'react'
import type { AgentDef, AgentStatus, Approval } from '@shared/types'
import { call } from '../api'
import { Icon } from '../icons'
import { go, loadRoom, setState, useStore } from '../store'
import floorUrl from '../floor/floor.svg'

// Seat anchors in the floor art's 800x600 viewBox, lead desk first. Same numbers as the prototype.
const SEATS: [number, number][] = [[443.8, 293.6], [245.6, 298.0], [332.2, 348.0], [162.5, 346.0], [249.1, 396.0], [453.5, 458.0]]
const LOOKS = [
  { shirt: '#3f4652', skin: '#d8b896', hair: '#2b2420' }, { shirt: '#5b6b5e', skin: '#c99b74', hair: '#1f1a17' },
  { shirt: '#6b5d73', skin: '#8d6346', hair: '#141212' }, { shirt: '#7a6a55', skin: '#e0c2a2', hair: '#5a4636' },
  { shirt: '#4b5560', skin: '#b07f5c', hair: '#2a2422' }, { shirt: '#5f6f7a', skin: '#c9a27e', hair: '#3a2c22' }
]
const WORD: Record<AgentStatus, string> = { working: 'working', planning: 'planning', walking: 'walking', needs: 'needs you', idle: 'idle', blocked: 'blocked', offline: 'offline', paused: 'paused' }
const pct = (x: number, y: number) => ({ left: `${(x / 800) * 100}%`, top: `${(y / 600) * 100}%` })

export function FloorScreen({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? [])
  const status = useStore((s) => s.status[roomId] ?? {})
  const saying = useStore((s) => s.saying)
  const activity = useStore((s) => s.activity.filter((a) => a.roomId === roomId).slice(0, 12))
  const approvals = useStore((s) => s.approvals.filter((a) => a.roomId === roomId && a.status === 'pending'))
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived'))
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [to, setTo] = useState<string>('')
  useEffect(() => { void loadRoom(roomId) }, [roomId])
  if (!room) return <div className="panel" />

  const seated = agents.slice(0, SEATS.length)
  const overflow = agents.slice(SEATS.length)
  const lead = agents.find((a) => a.lead)
  const sel = agents.find((a) => a.id === selected) ?? lead ?? agents[0]
  const selWs = sel && workspaces.find((w) => w.agentId === sel.id)
  const working = agents.filter((a) => ['working', 'planning'].includes(status[a.id])).length
  const needs = agents.filter((a) => status[a.id] === 'needs').length + approvals.length

  const send = async () => {
    if (!draft.trim()) return
    const text = draft.trim(); setDraft('')
    await call('rooms.brief', { roomId, text, agentId: to || undefined }).catch((e) => alert(e.message))
  }

  return (
    <div className="panel">
      <header className="header" style={{ borderBottom: 0 }}>
        <span className="ink2">{room.name}</span><Icon name="right" size={12} /><h1>Floor</h1>
        <span className="grow" /><span className="mono muted" style={{ fontSize: 12 }}>{room.repo ?? room.path} · {room.defaultBranch}</span>
      </header>
      <div className="row" style={{ height: 44, flexShrink: 0, padding: '0 12px', borderBottom: '1px solid var(--line)', gap: 6 }}>
        <button className="pill" aria-current="page">Floor</button>
        <button className="pill" onClick={() => go({ name: 'board', roomId })}>Board</button>
        <button className="pill" onClick={() => go({ name: 'team', roomId })}>Team</button>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>{working} working</span>
        {needs > 0 && <span style={{ fontSize: 12, fontWeight: 500 }}>{needs} needs you</span>}
        <button className="btn" onClick={() => call('rooms.setPaused', { roomId, paused: !room.paused }).then((r) => setState((s) => ({ rooms: s.rooms.map((x) => (x.id === r.id ? r : x)) })))}>
          <Icon name={room.paused ? 'play' : 'pause'} size={11} />{room.paused ? 'Resume room' : 'Pause room'}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <main className="col grow" style={{ position: 'relative', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '12px 24px 18px' }}>
          {sel && (
            <div className="card col" style={{ position: 'absolute', top: 14, left: 14, zIndex: 90, width: 248, padding: '12px 14px', gap: 4, background: 'rgba(20,21,22,.95)' }}>
              <div className="row" style={{ gap: 10 }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: LOOKS[Math.max(0, agents.indexOf(sel)) % LOOKS.length].shirt, fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{sel.name[0]}</span>
                <span className="col grow"><span style={{ fontSize: 14, fontWeight: 600 }}>{sel.name}</span><span className="muted" style={{ fontSize: 12 }}>{sel.role}{sel.model ? ` · ${sel.model}` : ''}</span></span>
              </div>
              <span className="ink2" style={{ marginTop: 6, fontSize: 12 }}>{cap(WORD[status[sel.id] ?? 'idle'])}{selWs ? <span className="mono muted"> · {selWs.name}</span> : null}</span>
              <span className="ink2">{saying[sel.id] ?? (selWs ? `Working in ${selWs.branch}` : 'No active task')}</span>
              {selWs && <button className="btn" style={{ marginTop: 8 }} onClick={() => go({ name: 'workspace', workspaceId: selWs.id })}>Open workspace<Icon name="right" size={12} /></button>}
            </div>
          )}
          <div style={{ position: 'relative', width: '100%', maxWidth: 740, aspectRatio: '4 / 3' }}>
            <img src={floorUrl} alt="Isometric office" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            {seated.map((a, i) => <Seat key={a.id} agent={a} index={i} status={status[a.id] ?? 'idle'} />)}
            {seated.map((a, i) => {
              const [x, y] = SEATS[i]
              const st = status[a.id] ?? 'idle'
              const loud = st === 'needs' || st === 'blocked'
              return (
                <button key={a.id} aria-pressed={sel?.id === a.id} aria-label={`${a.name}, ${a.role}, ${WORD[st]}`} onClick={() => setSelected(a.id)}
                  style={{ position: 'absolute', ...pct(x + 2.1, y - 76), transform: 'translate(-50%, -100%)', zIndex: 70, minHeight: 30, padding: 0, border: 0, background: 'transparent', display: 'flex', alignItems: 'center' }}>
                  <span className="row" style={{ gap: 6, height: 22, padding: '0 9px', borderRadius: 999, border: `1px solid ${loud ? 'var(--ink)' : sel?.id === a.id ? 'var(--muted)' : '#2e3036'}`, background: 'rgba(15,16,17,.92)', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {a.name}<span style={{ color: loud ? 'var(--ink)' : 'var(--muted)', fontWeight: 400 }}>{WORD[st]}</span>
                  </span>
                </button>
              )
            })}
            {!agents.length && (
              <div className="card col" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 360, padding: 18, gap: 8, zIndex: 85 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>No agents in this room yet</span>
                <span className="muted">Kernel reads agents from .claude/agents in this repo. Add files there, or copy a starter team from docs/starter-agents.</span>
              </div>
            )}
            {overflow.length > 0 && (
              <div className="card col" style={{ position: 'absolute', right: '2%', bottom: '3%', zIndex: 85, width: 230, padding: 12, gap: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>No desk yet, still working</span>
                {overflow.map((a) => <span key={a.id} className="row">{a.name}<span className="muted">{a.role}</span><span className="grow" /><span className="muted" style={{ fontSize: 12 }}>{WORD[status[a.id] ?? 'idle']}</span></span>)}
              </div>
            )}
          </div>
          <div className="composer" style={{ width: '100%', maxWidth: 620 }}>
            <input aria-label="Message" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send() } }} placeholder={lead && !to ? `Brief ${lead.name} on what to build` : 'Message'} />
            <div className="row">
              <select aria-label="Send to" value={to} onChange={(e) => setTo(e.target.value)} style={{ height: 26, padding: '0 8px', borderRadius: 6, border: '1px solid var(--line-2)', background: 'var(--surface-2)', color: 'var(--ink-2)', fontSize: 12 }}>
                <option value="">{lead ? `To ${lead.name} · Lead` : 'To the Lead'}</option>
                {agents.filter((a) => !a.lead).map((a) => <option key={a.id} value={a.id}>To {a.name} · {a.role}</option>)}
              </select>
              <span className="grow" />
              <button className="icon-btn" aria-label="Send" style={{ background: draft ? 'var(--ink)' : 'var(--surface-3)', color: draft ? 'var(--canvas)' : 'var(--muted)', borderRadius: '50%' }} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>
            </div>
          </div>
        </main>
        <aside aria-label="Logs" className="col" style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--line)', minHeight: 0 }}>
          <div className="row" style={{ height: 44, padding: '0 16px', borderBottom: '1px solid var(--line)' }}><h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Logs</h2></div>
          <div className="col grow" style={{ overflowY: 'auto', padding: '14px 16px', gap: 14 }}>
            {approvals.map((a) => <ApprovalCard key={a.id} approval={a} agents={agents} />)}
            <div className="col">
              {activity.map((e) => {
                const who = agents.find((a) => a.id === e.agentId)
                return (
                  <div key={e.id} className="row" style={{ alignItems: 'flex-start', gap: 10, padding: '6px 0' }}>
                    <span style={{ width: 20, height: 20, flexShrink: 0, borderRadius: '50%', background: 'var(--surface-3)', color: 'var(--ink-2)', fontSize: 9.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{(who?.name ?? 'K')[0]}</span>
                    <span className="grow muted" style={{ lineHeight: '20px' }}><span style={{ color: 'var(--ink)', fontWeight: 500 }}>{who?.name ?? 'Kernel'}</span> {e.text} {e.object && <span className="mono" style={{ fontSize: 11.5, padding: '0 5px', borderRadius: 4, border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink-2)' }}>{e.object}</span>}</span>
                    <span className="mono muted" style={{ fontSize: 11.5, lineHeight: '20px' }}>{new Date(e.ts).toTimeString().slice(0, 5)}</span>
                  </div>
                )
              })}
              {!activity.length && <span className="muted">Nothing yet. Brief the Lead to get started.</span>}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function Seat({ agent, index, status }: { agent: AgentDef; index: number; status: AgentStatus }) {
  const [x, y] = SEATS[index]
  const look = LOOKS[index % LOOKS.length]
  const present = status !== 'offline'
  return (
    <div aria-hidden="true" style={{ position: 'absolute', ...pct(x - 30, y - 80), width: '7.5%', height: '14.667%', zIndex: Math.round(y / 10), pointerEvents: 'none' }}>
      <svg viewBox="-30 -80 60 88" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        {present && (
          <g>
            <path d="M-8.9 -24.4 L-8.9 -43.4 Q-8.9 -53.4 2.1 -53.4 Q13.1 -53.4 13.1 -43.4 L13.1 -24.4 Z" fill={look.shirt} />
            <path d="M4.1 -52.4 Q13.1 -52.4 13.1 -43.4 L13.1 -24.4 L6.1 -24.4 Z" fill="#000" fillOpacity={0.16} />
            <circle cx={2.1} cy={-61.4} r={8.4} fill={look.skin} />
            <circle cx={2.1} cy={-63} r={8.6} fill={look.hair} />
            {status === 'needs' && <g><line x1={11.1} y1={-46.4} x2={20.1} y2={-70.4} stroke={look.skin} strokeWidth={4} strokeLinecap="round" /><circle cx={20.1} cy={-72.4} r={3.5} fill={look.skin} /></g>}
          </g>
        )}
        <polygon points="-21.5,-24.0 -1.4,-12.4 -1.4,-29.2 -21.5,-40.8" fill="#d8d5ce" />
        <polygon points="1.7,-14.2 -1.4,-12.4 -1.4,-29.2 1.7,-31.0" fill="#c6c3bb" />
        <polygon points="-18.4,-42.6 1.7,-31.0 -1.4,-29.2 -21.5,-40.8" fill="#eeece7" />
      </svg>
      <span style={{ display: 'none' }}>{agent.name}</span>
    </div>
  )
}

export function ApprovalCard({ approval: a, agents }: { approval: Approval; agents: AgentDef[] }) {
  const [reply, setReply] = useState('')
  const who = agents.find((x) => x.id === a.agentId)?.name ?? 'An agent'
  const decide = (decision: Parameters<typeof call<'approvals.decide'>>[1]['decision']) => call('approvals.decide', { id: a.id, decision }).catch((e) => alert(e.message))
  return (
    <section aria-label={a.title} className="card col" style={{ padding: 12, gap: 10, borderColor: 'var(--line-4)' }}>
      <span style={{ fontWeight: 500 }}>{a.kind === 'plan' ? `${who}'s plan is ready` : a.kind === 'question' ? `${who} has a question` : `${who} needs you`}</span>
      <span className="ink2" style={{ fontSize: 12.5 }}>{a.title}</span>
      {a.detail && <div className="code">{a.detail}</div>}
      {a.kind === 'tool' && a.toolName === 'Bash' && <div className="code">{String((a.input as any)?.command ?? '')}</div>}
      {a.kind === 'question' ? (
        <div className="col" style={{ gap: 6 }}>
          {(a.options ?? []).map((o) => <button key={o} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => decide({ behavior: 'answer', text: o })}>{o}</button>)}
          <input className="input" placeholder="Or type an answer" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reply.trim() && decide({ behavior: 'answer', text: reply.trim() })} />
        </div>
      ) : a.kind === 'plan' ? (
        <>
          <input className="input" placeholder="Changes you want (optional)" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="row" style={{ gap: 8 }}><button className="btn grow" onClick={() => decide({ behavior: 'deny', message: reply || 'Please revise the plan.' })}>Request changes</button><button className="btn primary grow" onClick={() => decide({ behavior: 'allow' })}>Approve plan</button></div>
        </>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => decide({ behavior: 'deny', message: 'Denied in Kernel.' })}>Deny</button>
          <button className="btn ghost grow" onClick={() => decide({ behavior: 'allow', always: true })}>Always allow</button>
          <button className="btn primary" onClick={() => decide({ behavior: 'allow' })}>Approve</button>
        </div>
      )}
    </section>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
