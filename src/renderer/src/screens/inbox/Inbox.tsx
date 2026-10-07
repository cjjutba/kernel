import { useEffect, useMemo, useRef, useState } from 'react'
import type { Approval, Decision } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon, Pill } from '../../ui'
import { ApprovalCard } from '../workspace/cards/ApprovalCard'
import { outcome } from '../workspace/cards/steps'
import { attempt } from '../workspace/MessageActions'
import { age, agentOf, inboxItems, inTab, needsYou, type InboxItem, type InboxTab } from './model'
import './inbox.css'

const tabs: [InboxTab, string][] = [['all', 'All'], ['needs', 'Needs you'], ['updates', 'Updates']]

const isTool = (a?: Approval) => !!a && a.kind === 'tool' && a.toolName !== 'ExitPlanMode'

/** Answer from the detail pane. The same channel the floor and the workspace use; the returned approval updates every list. */
const decide = (a: Approval, decision: Decision) => attempt('Could not send your answer', async () => actions.approvals.upsert(await call('approvals.decide', { id: a.id, decision })))

function Letter({ item, agents }: { item: InboxItem; agents: ReturnType<typeof agentOf> }) {
  return <span className="ib-av" aria-hidden="true">{(agents?.name ?? 'Kernel')[0].toUpperCase()}</span>
}

function Detail({ item }: { item: InboxItem }) {
  const { n, approval: a } = item
  const agents = useStore((s) => s.agents)
  const ws = useStore((s) => s.workspaces.find((w) => w.id === (a?.workspaceId ?? n.workspaceId)))
  const agent = agentOf(n, agents)
  const input = (a?.input ?? {}) as Record<string, unknown>
  const code = a?.toolName === 'Bash' ? `$ ${String(input.command ?? '')}` : String(input.file_path ?? input.path ?? '') || (a?.input ? JSON.stringify(a.input, null, 2) : '')
  const heading = n.heading ?? n.title
  const pending = a ? a.status === 'pending' : n.needsYou
  const result = a && a.status !== 'pending' ? (n.resolved ?? outcome(a)) : n.resolved
  return (
    <article className="ib-detail" aria-label={heading}>
      <header className="ib-who">
        <Letter item={item} agents={agent} />
        <div className="col">
          <span style={{ fontWeight: 500 }}>{agent?.name ?? 'Kernel'}</span>
          <span className="muted" style={{ fontSize: 12 }}>{n.sub} · {age(n.createdAt)} ago</span>
        </div>
      </header>
      <h2>{heading}</h2>
      {n.body && <p className="ib-body">{n.body}</p>}
      {a && pending && isTool(a) && (
        <>
          {code && <div className="ib-code mono">{code}</div>}
          <dl className="ib-facts">
            {a.detail && <><dt>Why</dt><dd>{a.detail}</dd></>}
            {ws && <><dt>Workspace</dt><dd className="mono">{ws.branch}</dd></>}
          </dl>
          <div className="ib-acts">
            <Button onClick={() => void decide(a, { behavior: 'deny', message: 'Denied in Kernel.' })}>Deny</Button>
            <button type="button" className="ib-link" onClick={() => void decide(a, { behavior: 'allow', always: true })}>Always allow in this room</button>
            <span className="grow" />
            <Button variant="primary" onClick={() => void decide(a, { behavior: 'allow' })}>Approve</Button>
          </div>
        </>
      )}
      {a && pending && !isTool(a) && <div className="ib-card"><ApprovalCard approval={a} /></div>}
      {!a && pending && n.workspaceId && (
        <div className="ib-acts">
          <Button variant="primary" onClick={() => go({ name: 'workspace', workspaceId: n.workspaceId! })}>{n.kind === 'merge' ? 'Open PR' : 'Open workspace'}</Button>
        </div>
      )}
      {!pending && (
        <div className="ib-outcome">
          {result && <span>{result}</span>}
          {n.workspaceId && <button type="button" className="ib-link" onClick={() => go({ name: 'workspace', workspaceId: n.workspaceId! })}>Open workspace</button>}
        </div>
      )}
    </article>
  )
}

/** Inbox.png and InboxEmpty.png: everything that needs CJ, and what happened while he was away. */
export function Inbox() {
  const notifications = useStore((s) => s.notifications)
  const approvals = useStore((s) => s.approvals)
  const rooms = useStore((s) => s.rooms)
  const agents = useStore((s) => s.agents)
  const firstRoom = useStore((s) => s.rooms.find((r) => !r.archived)?.id)
  const [tab, setTab] = useState<InboxTab>('all')
  const [sel, setSel] = useState<string | null>(null)
  const detail = useRef<HTMLDivElement>(null)
  const all = useMemo(() => inboxItems(notifications, approvals, rooms), [notifications, approvals, rooms])
  const list = all.filter((i) => inTab(i, tab))
  const cur = list.find((i) => i.n.id === sel) ?? list[0]
  const count = (t: InboxTab) => all.filter((i) => inTab(i, t)).length

  const markRead = (ids: string[] | 'all') => void call('notifications.read', { ids }).then((rows) => rows.forEach(actions.notifications.upsert)).catch(() => undefined)
  const open = (i: InboxItem) => { setSel(i.n.id); if (!i.n.read) markRead([i.n.id]) }

  // Keyboard: j and k move, Enter jumps into the detail, a approves, d denies. Typing in a field is left alone.
  const state = useRef({ list, cur })
  state.current = { list, cur }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return
      const { list, cur } = state.current
      const at = cur ? list.findIndex((i) => i.n.id === cur.n.id) : -1
      if (e.key === 'j' || e.key === 'k') {
        const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'j' ? 1 : -1)))]
        if (next) { e.preventDefault(); open(next); document.getElementById(`ib-${next.n.id}`)?.scrollIntoView({ block: 'nearest' }) }
      } else if (e.key === 'Enter' && t?.closest('.ib-list') && cur) {
        e.preventDefault()
        detail.current?.querySelector<HTMLElement>('button, input')?.focus()
      } else if ((e.key === 'a' || e.key === 'd') && cur?.approval?.status === 'pending' && cur.approval.kind !== 'question') {
        e.preventDefault()
        void decide(cur.approval, e.key === 'a' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied in Kernel.' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="panel">
      <header className="header" style={{ paddingRight: 12 }}>
        <Icon name="inbox" />
        <h1>Inbox</h1>
        <span className="grow" />
        <button type="button" className="ib-link muted" disabled={!all.some((i) => !i.n.read)} onClick={() => markRead('all')}>Mark all read</button>
      </header>
      <div className="ib-tabs" role="group" aria-label="Filter the inbox">
        {tabs.map(([id, label]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="ib-n">{count(id)}</span></Pill>)}
      </div>
      <div className="ib-body-wrap">
        <div className="ib-list" role="group" aria-label="Inbox items">
          {list.map((i) => (
            <button key={i.n.id} id={`ib-${i.n.id}`} type="button" className="ib-row" aria-current={i.n.id === cur?.n.id ? 'true' : undefined} data-unread={!i.n.read ? 'true' : undefined} onClick={() => open(i)}>
              <Letter item={i} agents={agentOf(i.n, agents)} />
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="ib-title ellipsis">{i.n.title}</span>
                <span className="ib-sub ellipsis">{i.n.sub}</span>
              </span>
              <span className="ib-age">{age(i.n.createdAt)}</span>
            </button>
          ))}
        </div>
        <div className="ib-pane" ref={detail}>
          {cur ? <Detail item={cur} /> : (
            <div className="ib-empty">
              <h2>You're all caught up</h2>
              <p>Approvals, plans to review and finished work land here. Nothing needs you right now.</p>
              <button type="button" className="ib-link" onClick={() => go(firstRoom ? { name: 'floor', roomId: firstRoom } : { name: 'home' })}>Go to the floor</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
