import { useMemo, useState } from 'react'
import { MODELS, type Effort, type ModelId, type WorkspaceMode } from '@shared/types'
import { call } from '../api'
import { Icon } from '../icons'
import { actions, go, loadWorkspace, useStore } from '../store'
import { Modal } from '../components/Shell'

/** The focused "What do you want to work on?" modal. It always goes to the room's Lead, who names the branch. */
export function NewWorkspaceModal({ roomId }: { roomId?: string }) {
  const rooms = useStore((s) => s.rooms)
  const [room, setRoom] = useState(roomId ?? rooms[0]?.id)
  const [prompt, setPrompt] = useState('')
  const [menu, setMenu] = useState<null | 'branch' | 'model'>(null)
  const [baseRef, setBaseRef] = useState('')
  const [mode, setMode] = useState<WorkspaceMode>('worktree')
  const [model, setModel] = useState<ModelId>('claude-opus-5-5')
  const [effort, setEffort] = useState<Effort>('high')
  const [plan, setPlan] = useState(true)
  const [busy, setBusy] = useState(false)
  const close = () => actions.ui.closeModal()
  const current = rooms.find((r) => r.id === room)

  const create = async () => {
    if (!room || !prompt.trim()) return
    setBusy(true)
    try {
      const ws = await call('workspaces.create', { roomId: room, prompt: prompt.trim(), mode, baseRef: baseRef || undefined, model, effort, plan })
      await loadWorkspace(ws.id)
      go({ name: 'workspace', workspaceId: ws.id })
    } catch (e) { alert((e as Error).message); setBusy(false) }
  }

  return (
    <>
      <div className="scrim" onClick={close} />
      <section role="dialog" aria-modal="true" aria-label="New workspace" className="modal" style={{ width: 680, top: 170 }} onKeyDown={(e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.metaKey) void create() }}>
        <div className="row" style={{ position: 'relative', height: 52, padding: '0 10px 0 12px', gap: 4, borderBottom: '1px solid #26272b' }}>
          <button className="btn ghost" style={{ fontSize: 14 }} onClick={() => { const i = rooms.findIndex((r) => r.id === room); setRoom(rooms[(i + 1) % rooms.length]?.id) }}>{current?.name ?? 'Pick a room'}<Icon name="chevron" size={10} /></button>
          <button className="icon-btn" aria-label="Branch options" onClick={() => setMenu(menu === 'branch' ? null : 'branch')}>···</button>
          {menu === 'branch' && (
            <div className="menu col" style={{ left: 140, top: 48, width: 340, gap: 6, padding: 10 }}>
              <label className="row muted" style={{ fontSize: 13 }}><span className="grow">Target branch</span><input className="input mono" style={{ height: 28, width: 160, fontSize: 12.5 }} placeholder={current ? `origin/${current.defaultBranch}` : 'origin/main'} value={baseRef} onChange={(e) => setBaseRef(e.target.value)} /></label>
              <label className="row muted" style={{ fontSize: 13 }}><span className="grow">Runs in</span><select value={mode} onChange={(e) => setMode(e.target.value as WorkspaceMode)} style={{ height: 28, background: 'var(--surface-3)', border: '1px solid var(--line-3)', borderRadius: 6 }}><option value="worktree">New worktree</option><option value="current">Current branch</option></select></label>
              <span className="muted" style={{ fontSize: 12 }}>{mode === 'worktree' ? 'An isolated copy on its own branch, named from your task.' : 'Works in your checkout. Changes already there are kept and left out of the diff.'}</span>
            </div>
          )}
        </div>
        <div style={{ padding: '14px 16px 6px' }}>
          <textarea autoFocus rows={7} aria-label="What do you want to work on?" placeholder="What do you want to work on?" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: '100%', resize: 'none', padding: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 15, lineHeight: 1.55 }} />
        </div>
        <div className="row" style={{ position: 'relative', padding: '10px 10px 12px 12px' }}>
          <button className="btn ghost" onClick={() => setMenu(menu === 'model' ? null : 'model')}>{MODELS.find((m) => m.id === model)?.label}<span className="muted" style={{ fontWeight: 400 }}>{effort}</span><Icon name="chevron" size={10} /></button>
          {menu === 'model' && (
            <div className="menu" style={{ left: 10, bottom: 50, width: 300 }}>
              {MODELS.map((m) => <button key={m.id} className="menu-item" style={{ background: m.id === model ? 'var(--hover)' : undefined }} onClick={() => { setModel(m.id); setMenu(null) }}>{m.label}</button>)}
              <div style={{ height: 1, margin: '6px 4px', background: '#2a2b30' }} />
              {(['low', 'medium', 'high', 'xhigh'] as Effort[]).map((e) => <button key={e} className="menu-item" style={{ background: e === effort ? 'var(--hover)' : undefined }} onClick={() => setEffort(e)}>Effort: {e === 'xhigh' ? 'Extra high' : e}</button>)}
            </div>
          )}
          <button className="btn" style={{ height: 26, borderColor: plan ? 'var(--line-4)' : 'transparent' }} onClick={() => setPlan(!plan)}>{plan ? 'Plan mode on' : 'Plan mode off'}</button>
          <span className="grow" />
          <button className="btn primary lg" disabled={busy || !prompt.trim()} onClick={() => void create()}>{busy ? <><span className="spin" />Creating</> : 'Create'}</button>
        </div>
      </section>
    </>
  )
}

export function SearchModal() {
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.status !== 'archived'))
  const [q, setQ] = useState('')
  const items = useMemo(() => [
    { label: 'New workspace', run: () => actions.ui.openModal({ name: 'newWorkspace' }) },
    { label: 'Inbox', run: () => go({ name: 'inbox' }) },
    { label: 'History', run: () => go({ name: 'history' }) },
    { label: 'Add a room', run: () => go({ name: 'onboarding', step: 'checks' }) },
    ...rooms.map((r) => ({ label: `${r.name} floor`, run: () => go({ name: 'floor', roomId: r.id }) })),
    ...workspaces.map((w) => ({ label: `${w.name} workspace`, run: () => go({ name: 'workspace', workspaceId: w.id }) }))
  ].filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [q, rooms, workspaces])
  return (
    <Modal title="Search" onClose={() => actions.ui.closeModal()}>
      <div style={{ padding: '0 16px 8px' }}><input autoFocus className="input" style={{ width: '100%' }} placeholder="Type a command or search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && items[0]?.run()} /></div>
      <div className="col" style={{ maxHeight: 420, overflowY: 'auto', padding: '0 6px 8px' }}>{items.map((i) => <button key={i.label} className="menu-item" onClick={i.run}>{i.label}</button>)}</div>
    </Modal>
  )
}
