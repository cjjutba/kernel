import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { MODELS, type ChangedFile, type Chat, type ChatItem, type ChatPart, type Effort, type ModelId, type Workspace } from '@shared/types'
import { call } from '../api'
import { Icon } from '../icons'
import { actions, go, loadWorkspace, useStore } from '../store'

const EFFORTS: { id: Effort; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }]
let pasteCount = 1

export function WorkspaceScreen({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const room = useStore((s) => s.rooms.find((r) => r.id === ws?.roomId))
  const agent = useStore((s) => (ws ? s.agents[ws.roomId]?.find((a) => a.id === ws.agentId) : undefined))
  const chats = useStore((s) => s.chats[workspaceId] ?? [])
  const [chatId, setChatId] = useState<string | null>(null)
  const [right, setRight] = useState<'changes' | 'checks'>('changes')
  const [bottom, setBottom] = useState<'setup' | 'run' | 'archive'>('setup')
  const [changes, setChanges] = useState<ChangedFile[]>([])
  const [diff, setDiff] = useState<string | null>(null)
  const [tabMenu, setTabMenu] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const active = chats.find((c) => c.id === chatId) ?? chats[0]

  useEffect(() => { void loadWorkspace(workspaceId).then((c) => setChatId(c[0]?.id ?? null)) }, [workspaceId])
  const refreshChanges = () => call('workspaces.changes', { workspaceId }).then(setChanges).catch(() => setChanges([]))
  useEffect(() => { void refreshChanges() }, [workspaceId])
  const running = useStore((s) => (active ? !!s.running[active.id] : false))
  useEffect(() => { if (!running) void refreshChanges() }, [running])

  if (!ws) return <div className="panel" />
  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)

  const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await fn() } catch (e) { alert(String((e as Error).message)) } finally { setBusy(null) } }

  return (
    <div className="panel">
      <header className="header">
        <button className="btn ghost" style={{ padding: '0 4px' }} onClick={() => room && go({ name: 'floor', roomId: room.id })}>{room?.name}</button>
        <Icon name="right" size={12} />
        <h1>{ws.name}</h1>
        <span className="mono muted" style={{ fontSize: 12 }}>{ws.mode === 'current' ? `current branch · ${ws.branch}` : ws.branch}</span>
        <button className="icon-btn" aria-label="Open in editor" onClick={() => call('system.openInEditor', { path: ws.path })}><Icon name="code" size={15} /></button>
        <span className="grow" />
        <PrControls ws={ws} busy={busy} act={act} />
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <section aria-label="Agent" className="col grow" style={{ position: 'relative' }}>
          <div className="row" style={{ height: 40, flexShrink: 0, padding: '0 12px', borderBottom: '1px solid var(--line)', alignItems: 'flex-end', gap: 2, position: 'relative' }}>
            <div role="tablist" className="row" style={{ gap: 2, alignItems: 'flex-end' }}>
              {chats.map((c) => (
                <button key={c.id} role="tab" aria-selected={c.id === active?.id} onClick={() => { setChatId(c.id); setDiff(null) }}
                  style={{ height: 40, maxWidth: 220, padding: '0 12px', border: 0, borderBottom: `2px solid ${c.id === active?.id ? 'var(--ink)' : 'transparent'}`, background: 'transparent', color: c.id === active?.id ? 'var(--ink)' : 'var(--muted)', fontWeight: 500 }}>
                  <span className="ellipsis">{c.title}</span>
                </button>
              ))}
            </div>
            <button className="icon-btn" style={{ alignSelf: 'center' }} aria-label="New tab" onClick={() => setTabMenu(!tabMenu)}><Icon name="plus" size={14} /></button>
            {tabMenu && (
              <div className="menu" role="menu" style={{ left: 24 + chats.length * 140, top: 38 }}>
                <button className="menu-item" onClick={async () => { setTabMenu(false); const c = await call('chats.create', { workspaceId }); await loadWorkspace(workspaceId); setChatId(c.id) }}><span className="grow">New chat</span><span className="muted">⌘T</span></button>
                <button className="menu-item" onClick={async () => { setTabMenu(false); const c = await call('chats.create', { workspaceId, kind: 'terminal' }); await loadWorkspace(workspaceId); setChatId(c.id) }}><span className="grow">Big terminal</span><span className="muted">⌘⇧T</span></button>
              </div>
            )}
          </div>
          {diff !== null ? <DiffView text={diff} onClose={() => setDiff(null)} /> : active ? <Transcript chat={active} /> : <div className="grow" />}
          {active && <Composer chat={active} agentName={agent?.name ?? ws.agentId} agentRole={agent?.role ?? ''} />}
        </section>
        <aside aria-label="Workspace panels" className="col" style={{ width: 400, flexShrink: 0, borderLeft: '1px solid var(--line)', minHeight: 0 }}>
          <div className="col grow" style={{ minHeight: 0 }}>
            <div role="tablist" className="row" style={{ height: 44, padding: '0 10px', gap: 4 }}>
              <button role="tab" className="tab" aria-selected={right === 'changes'} onClick={() => setRight('changes')}>Changes <span className="mono muted" style={{ fontSize: 11.5 }}>{changes.length}</span></button>
              <button role="tab" className="tab" aria-selected={right === 'checks'} onClick={() => setRight('checks')}>Checks</button>
            </div>
            {right === 'changes' ? (
              <div className="col grow" style={{ minHeight: 0, overflowY: 'auto', padding: '4px 10px' }}>
                {changes.length ? (
                  <>
                    <div className="row muted" style={{ height: 32, padding: '0 6px', fontSize: 12.5 }}>{changes.length} files <span className="mono add">+{added}</span><span className="mono del">-{removed}</span><span className="grow" /><button className="btn" onClick={async () => setDiff(await call('workspaces.diff', { workspaceId }))}>Review all</button></div>
                    {changes.map((f) => (
                      <button key={f.path} className="nav-item mono" style={{ fontSize: 12.5 }} onClick={async () => setDiff(await call('workspaces.diff', { workspaceId, file: f.path }))}>
                        <span style={{ width: 12, color: f.status === 'A' ? 'var(--add)' : 'var(--ink-2)' }}>{f.status}</span>
                        <span className="grow ellipsis" style={{ color: 'var(--ink)' }}>{f.path}</span>
                        <span style={{ fontSize: 11.5 }}><span className="add">+{f.added}</span> <span className="del">-{f.removed}</span></span>
                      </button>
                    ))}
                    {ws.mode === 'current' && <p className="muted" style={{ margin: '8px 6px', fontSize: 12 }}>Changes from before this workspace started are hidden.</p>}
                  </>
                ) : <div className="col grow" style={{ alignItems: 'center', justifyContent: 'center', gap: 6 }}><span className="ink2" style={{ fontWeight: 500 }}>No file changes yet</span><span className="muted">Changes appear here.</span></div>}
              </div>
            ) : <Checks ws={ws} />}
          </div>
          <ScriptsPanel ws={ws} tab={bottom} setTab={setBottom} />
        </aside>
      </div>
    </div>
  )
}

function PrControls({ ws, busy, act }: { ws: Workspace; busy: string | null; act: (l: string, fn: () => Promise<unknown>) => void }) {
  const [menu, setMenu] = useState(false)
  const link = ws.prNumber && ws.prUrl ? <button className="btn" onClick={() => call('system.openExternal', { url: ws.prUrl! })} style={ws.prState === 'merged' ? { borderColor: '#4b3d86', color: 'var(--merged)' } : undefined}><span className="mono">#{ws.prNumber}</span><Icon name="ext" size={11} stroke={1.8} /></button> : null
  const spinBtn = (label: string) => <button className="btn" disabled><span className="spin" />{label}</button>
  if (busy) return <>{link}{spinBtn(busy)}</>
  switch (ws.prState) {
    case 'none': return (
      <span className="row" style={{ gap: 0, position: 'relative' }}>
        <button className="btn primary" style={{ borderRadius: '7px 0 0 7px' }} onClick={() => act('Creating PR', () => call('pr.create', { workspaceId: ws.id }))}>Create PR</button>
        <button className="btn primary" aria-label="More pull request options" style={{ borderRadius: '0 7px 7px 0', padding: '0 7px', borderLeft: '1px solid var(--ink-2)' }} onClick={() => setMenu(!menu)}><Icon name="chevron" size={10} /></button>
        {menu && <div className="menu" style={{ right: 0, top: 32 }}><button className="menu-item" onClick={() => { setMenu(false); act('Creating PR', () => call('pr.create', { workspaceId: ws.id, draft: true })) }}>Create draft PR</button></div>}
      </span>
    )
    case 'checks': return <>{link}{spinBtn('Checks running')}</>
    case 'draft': return <>{link}<span className="muted">Draft</span><button className="btn" onClick={() => act('Marking ready', () => call('pr.ready', { workspaceId: ws.id }))}>Ready for review</button></>
    case 'cifail': return <>{link}<span className="del">Checks failed</span><button className="btn primary" onClick={() => act('Sending', () => call('pr.resolve', { workspaceId: ws.id }))}>Fix checks</button></>
    case 'changes': return <>{link}<span className="ink2">Changes requested</span><button className="btn primary" onClick={() => act('Sending', () => call('pr.resolve', { workspaceId: ws.id }))}>Address review</button></>
    case 'conflict': return <>{link}<button className="btn" style={{ borderColor: 'var(--line-4)' }} onClick={() => act('Resolving', () => call('pr.resolve', { workspaceId: ws.id }))}>Resolve conflicts</button></>
    case 'ready': case 'open': return <>{link}<button className="btn primary" onClick={() => act('Merging', () => call('pr.merge', { workspaceId: ws.id }))}>Merge PR</button></>
    case 'merged': return (
      <>{link}<span style={{ color: 'var(--merged)', fontWeight: 500, padding: '0 4px' }}>Merged</span>
        <button className="btn" style={{ borderStyle: 'dashed', borderColor: '#6e56c4', color: 'var(--merged)' }} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: ws.roomId })}>Continue</button>
        <button className="btn merged" onClick={() => act('Archiving', async () => { await call('workspaces.archive', { workspaceId: ws.id }); go({ name: 'floor', roomId: ws.roomId }) })}>Archive</button></>
    )
    case 'closed': return <>{link}<span className="muted">Closed</span><button className="btn" onClick={() => act('Reopening', () => call('pr.reopen', { workspaceId: ws.id }))}>Reopen</button></>
  }
}

function Transcript({ chat }: { chat: Chat }) {
  const items = useStore((s) => s.items[chat.id] ?? [])
  const running = useStore((s) => !!s.running[chat.id])
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [items.length, running])
  return (
    <div className="grow selectable" style={{ overflowY: 'auto', padding: '16px 32px 8px' }}>
      <div className="col" style={{ maxWidth: 760, margin: '0 auto', gap: 12 }}>
        {!items.length && <div className="col" style={{ alignItems: 'center', gap: 6, padding: '120px 0', textAlign: 'center' }}><span style={{ fontSize: 18, fontWeight: 600 }}>{chat.kind === 'terminal' ? 'Big terminal' : 'New chat'}</span><span className="muted">Same worktree and branch, fresh context.</span></div>}
        {items.map((it) => <Item key={it.id} item={it} />)}
        {running && <span className="row muted mono" style={{ fontSize: 12.5 }}><span className="spin" />Working</span>}
        <div ref={end} />
      </div>
    </div>
  )
}

function Item({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false)
  switch (item.kind) {
    case 'user': return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '82%', padding: '10px 14px', borderRadius: 10, background: '#1a1b1e', fontSize: 14, lineHeight: 1.7 }}>
        {item.parts.map((p, i) => (p.type === 'text' ? <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{p.text} </span> : <span key={i} className="chip" style={{ marginRight: 4 }}><Icon name={p.type === 'image' ? 'image' : 'doc'} size={12} />{p.name}</span>))}
      </div>
    )
    case 'text': return <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#e3e5e8', whiteSpace: 'pre-wrap' }}>{item.text}</p>
    case 'thinking': return <div className="row" style={{ minWidth: 0 }}><span className="muted"><Icon name="bulb" size={15} stroke={1.3} /></span><span className="ink2">Thinking</span><span className="muted ellipsis">{item.text}</span></div>
    case 'tool': return (
      <div className="col" style={{ gap: 4 }}>
        <button className="row" style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', minWidth: 0 }} onClick={() => setOpen(!open)}>
          <span style={{ color: item.status === 'failed' ? 'var(--del)' : 'var(--muted)' }}><Icon name="term" size={15} stroke={1.5} /></span>
          <span className="ink2 ellipsis" style={{ maxWidth: 300, flexShrink: 0 }}>{item.label}</span>
          <span className="mono muted ellipsis" style={{ fontSize: 12 }}>{item.detail}</span>
          {item.status === 'running' && <span className="spin" />}
        </button>
        {open && item.output && <div className="code" style={{ marginLeft: 25, maxHeight: 260, overflow: 'auto' }}>{item.output}</div>}
      </div>
    )
    case 'result': return <span className="muted" style={{ fontSize: 12 }}>{fmtDuration(item.durationMs)}{item.ok ? '' : ` · ${item.error ?? 'stopped'}`}</span>
    case 'note': return <div style={{ padding: '9px 12px', borderRadius: 8, background: '#141517', color: 'var(--ink-3)', fontSize: 12.5 }}>{item.text}</div>
    case 'interrupted': return <span className="mono muted" style={{ fontSize: 12, letterSpacing: '0.06em' }}>INTERRUPTED BY YOU</span>
  }
}

function DiffView({ text, onClose }: { text: string; onClose: () => void }) {
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="row" style={{ height: 40, padding: '0 16px', borderBottom: '1px solid var(--line)' }}><span className="grow muted">Diff</span><button className="btn ghost" onClick={onClose}>Back to chat</button></div>
      <div className="grow selectable mono" style={{ overflow: 'auto', padding: '8px 0', fontSize: 12.5, lineHeight: '22px' }}>
        {lines.map((l, i) => {
          const add = l.startsWith('+') && !l.startsWith('+++'), del = l.startsWith('-') && !l.startsWith('---'), hunk = l.startsWith('@@')
          return <div key={i} style={{ padding: '0 16px', whiteSpace: 'pre', background: add ? 'rgba(76,183,130,.08)' : del ? 'rgba(235,87,87,.08)' : 'transparent', color: hunk ? 'var(--muted)' : del ? 'var(--ink-3)' : '#e3e5e8' }}>{l || ' '}</div>
        })}
      </div>
    </div>
  )
}

function Composer({ chat, agentName, agentRole }: { chat: Chat; agentName: string; agentRole: string }) {
  const running = useStore((s) => !!s.running[chat.id])
  const [draft, setDraft] = useState('')
  const [chips, setChips] = useState<ChatPart[]>([])
  const [menu, setMenu] = useState<null | 'model'>(null)

  const send = async () => {
    const parts: ChatPart[] = [...chips, ...(draft.trim() ? [{ type: 'text' as const, text: draft.trim() }] : [])]
    if (!parts.length) return
    setDraft(''); setChips([])
    await call('chats.send', { chatId: chat.id, parts })
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
    if (e.key === 'Backspace' && !draft && chips.length) setChips(chips.slice(0, -1))
  }
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      const reader = new FileReader()
      reader.onload = () => setChips((c) => [...c, { type: 'image', name: file.name || 'image.png', dataUrl: String(reader.result) }])
      reader.readAsDataURL(file)
      return
    }
    const text = e.clipboardData.getData('text')
    const lines = text.split('\n').length
    if (text.length > 280 || lines > 4) { e.preventDefault(); setChips((c) => [...c, { type: 'file', name: `pasted_text_${pasteCount++}.txt`, lines, text }]) }
  }
  const configure = (patch: { model?: ModelId; effort?: Effort; plan?: boolean }) => call('chats.configure', { chatId: chat.id, ...patch }).then(() => loadWorkspace(chat.workspaceId))
  const model = MODELS.find((m) => m.id === chat.model)?.label ?? chat.model
  const effort = EFFORTS.find((x) => x.id === chat.effort)?.label ?? chat.effort

  return (
    <div style={{ flexShrink: 0, padding: '4px 24px 18px' }}>
      <div style={{ position: 'relative', maxWidth: 760, margin: '0 auto' }}>
        {menu === 'model' && (
          <div className="menu" role="menu" style={{ left: 120, bottom: 'calc(100% + 8px)', width: 300 }}>
            {MODELS.map((m) => <button key={m.id} className="menu-item" onClick={() => { setMenu(null); void configure({ model: m.id }) }} style={{ background: m.id === chat.model ? 'var(--hover)' : undefined }}><span style={{ fontWeight: 500 }}>{m.label}</span><span className="grow muted">{m.id === chat.model ? effort : ''}</span></button>)}
            <div style={{ height: 1, margin: '6px 4px', background: '#26272b' }} />
            <button className="menu-item" onClick={() => { const i = EFFORTS.findIndex((x) => x.id === chat.effort); void configure({ effort: EFFORTS[(i + 1) % EFFORTS.length].id }) }}><span className="grow">Effort</span><span className="muted">{effort}</span></button>
          </div>
        )}
        <div className="composer">
          <div className="row" style={{ flexWrap: 'wrap', gap: '6px 4px', minHeight: 44, alignContent: 'flex-start', fontSize: 14 }}>
            {chips.map((c, i) => (
              <span key={i} className="chip"><Icon name={c.type === 'image' ? 'image' : 'doc'} size={12} />{'name' in c ? c.name : ''}{c.type === 'file' && c.lines ? <span className="muted">{c.lines} lines</span> : null}
                <button className="icon-btn" style={{ width: 18, height: 18 }} aria-label="Remove" onClick={() => setChips(chips.filter((_, j) => j !== i))}><Icon name="close" size={9} stroke={2} /></button></span>
            ))}
            <input aria-label={`Message ${agentName}`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste} placeholder={chips.length ? '' : running ? 'Add a follow up' : `Ask ${agentName} to make changes, @mention files, run /skills`} />
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="row" style={{ gap: 6, fontSize: 12.5 }}><span style={{ width: 18, height: 18, borderRadius: '50%', background: '#3f4652', fontSize: 9, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{agentName[0]?.toUpperCase()}</span>{agentName}<span className="muted">{agentRole}</span></span>
            <span style={{ width: 1, height: 16, background: '#26272b' }} />
            <button className="btn ghost" onClick={() => setMenu(menu ? null : 'model')}>{model}<span className="muted" style={{ fontWeight: 400 }}>{effort}</span><Icon name="chevron" size={10} /></button>
            {chat.plan && <button className="btn" style={{ height: 26 }} onClick={() => void configure({ plan: false })}>Plan mode<Icon name="close" size={9} stroke={2} /></button>}
            <span className="grow" />
            {!chat.plan && <button className="btn ghost" style={{ height: 26 }} onClick={() => void configure({ plan: true })}>Plan</button>}
            {running
              ? <button className="icon-btn" aria-label="Stop" style={{ border: '1px solid var(--line-4)' }} onClick={() => call('chats.interrupt', { chatId: chat.id })}><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--ink)' }} /></button>
              : <button className="icon-btn" aria-label="Send" style={{ background: draft || chips.length ? 'var(--ink)' : 'var(--surface-3)', color: draft || chips.length ? 'var(--canvas)' : 'var(--muted)' }} onClick={() => void send()}><Icon name="up" size={14} stroke={1.8} /></button>}
          </div>
        </div>
      </div>
    </div>
  )
}

function Checks({ ws }: { ws: Workspace }) {
  const rows: [string, string][] = [
    ['Pull request', ws.prNumber ? `#${ws.prNumber} · ${ws.prState}` : 'No pull request yet'],
    ['Branch', ws.branch],
    ['Base', ws.baseRef],
    ['Port', String(ws.port)]
  ]
  return (
    <div className="col" style={{ gap: 14, padding: '6px 16px' }}>
      {rows.map(([k, v]) => <div key={k} className="col" style={{ gap: 4 }}><span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>{k}</span><span className="mono ink2" style={{ fontSize: 12.5 }}>{v}</span></div>)}
      {ws.prNumber && <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => call('pr.refresh', { workspaceId: ws.id })}>Refresh checks</button>}
    </div>
  )
}

function ScriptsPanel({ ws, tab, setTab }: { ws: Workspace; tab: 'setup' | 'run' | 'archive'; setTab: (t: 'setup' | 'run' | 'archive') => void }) {
  const lines = useStore((s) => (s.scripts[ws.id] ?? []).filter((l) => l.kind === tab))
  return (
    <div className="col" style={{ height: 280, flexShrink: 0, borderTop: '1px solid var(--line)' }}>
      <div role="tablist" className="row" style={{ height: 40, padding: '0 8px 0 10px', gap: 4 }}>
        {(['setup', 'run'] as const).map((t) => <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'setup' ? 'Setup' : 'Run'}</button>)}
        <span className="grow" />
        {tab === 'run' ? <><button className="btn" onClick={() => call('scripts.run', { workspaceId: ws.id, kind: 'run' }).catch((e) => alert(e.message))}><Icon name="play" size={10} />Run</button><button className="btn" onClick={() => call('scripts.stop', { workspaceId: ws.id, kind: 'run' })}>Stop</button></> : <button className="btn" onClick={() => call('scripts.run', { workspaceId: ws.id, kind: 'setup' }).catch((e) => alert(e.message))}>Run setup</button>}
      </div>
      <div className="grow selectable mono" style={{ overflow: 'auto', padding: '6px 16px 12px', fontSize: 12, lineHeight: 1.7 }}>
        {lines.length ? lines.map((l, i) => <div key={i} style={{ whiteSpace: 'pre-wrap', color: l.stream === 'stderr' ? 'var(--del)' : l.line.startsWith('$') ? 'var(--ink)' : 'var(--ink-3)' }}>{l.line}</div>) : <span className="muted">{tab === 'setup' ? 'Setup output appears here.' : 'Start the run script to see output.'}</span>}
      </div>
    </div>
  )
}

const fmtDuration = (ms: number) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s` }
