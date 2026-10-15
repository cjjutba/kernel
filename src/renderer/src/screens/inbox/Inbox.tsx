import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { AgentDef, Approval, Overlap } from '@shared/types'
import { call } from '../../api'
import { FileLabel } from '../../components/FileIcon'
import { actions, go, useStore } from '../../store'
import { oneOf, useRemembered } from '../../remember'
import { Button, EmptyList, Icon, Pill, useBusy, useListKeys, listKeyAction } from '../../ui'
import { ApprovalCard } from '../workspace/cards/ApprovalCard'
import { outcome } from '../workspace/cards/steps'
import { attempt } from '../workspace/MessageActions'
import { decideAtOnce, useFoldPhase, useHeldRows } from '../workspace/cards/decideFold'
import { openProject } from '../../lead'
import { age, agentOf, allOverlaps, fileName, inboxItems, inTab, names, needsYou, type InboxItem, type InboxTab } from './model'
import './inbox.css'
import { SidebarToggleSlot } from '../../components/PanelToggles'

const tabs: [InboxTab, string][] = [['all', 'All'], ['needs', 'Needs you'], ['updates', 'Updates']]

const isTool = (a?: Approval) => !!a && a.kind === 'tool' && a.toolName !== 'ExitPlanMode'

function Letter({ item, agents }: { item: InboxItem; agents: ReturnType<typeof agentOf> }) {
  return <span className="ib-av" aria-hidden="true">{(agents?.name ?? 'Kernel')[0].toUpperCase()}</span>
}

const NO_AGENTS: AgentDef[] = []

/** Agents changing the same file in different worktrees. The Lead sorts it out. */
export function SortOverlap({ overlap: o }: { overlap: Overlap }) {
  const lead = useStore((s) => s.agents[o.projectId]?.find((a) => a.lead))
  const [busy, run] = useBusy()
  const name = lead?.name ?? 'the Lead'
  return (
    <Button variant="primary" busy={!!busy} busyPattern="arrow-right" busyLabel="Sending" disabled={!!busy} onClick={() => void run('sort', () => attempt(`Could not hand that to ${name}`, () => call('projects.resolveOverlap', { overlapId: o.id })))}>
      Let {name} sort it
    </Button>
  )
}

function OverlapDetail({ overlap: o }: { overlap: Overlap }) {
  const team = useStore((s) => s.agents[o.projectId]) ?? NO_AGENTS
  const workspaces = useStore((s) => s.workspaces)
  const rows = o.parties.map((p) => ({ ...p, name: team.find((a) => a.id === p.agentId)?.name ?? p.agentId, ws: workspaces.find((w) => w.id === p.workspaceId) }))
  return (
    <>
      <p className="ib-body">{names(rows.map((r) => r.name))} edited {fileName(o.path)} in different worktrees. Merging {rows.length > 2 ? 'them all' : 'both'} later will conflict.</p>
      <dl className="ib-facts">
        <dt>File</dt><dd className="mono"><FileLabel path={o.path} /></dd>
        {rows.map((r) => (
          <Fragment key={r.workspaceId}>
            <dt>{r.name}</dt>
            <dd className="mono">
              {r.ws ? <button type="button" className="ib-link mono" aria-label={`Open ${r.name}'s workspace ${r.ws.name}`} onClick={() => go({ name: 'workspace', workspaceId: r.ws!.id })}>{r.ws.name}</button> : r.workspaceId}, {r.lines}
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="ib-acts"><span className="grow" /><SortOverlap overlap={o} /></div>
    </>
  )
}

function Detail({ item }: { item: InboxItem }) {
  const { n, approval: a } = item
  const agents = useStore((s) => s.agents)
  const ws = useStore((s) => s.workspaces.find((w) => w.id === (a?.workspaceId ?? n.workspaceId)))
  const phase = useFoldPhase(a?.id ?? '')
  const agent = agentOf(n, agents)
  const input = (a?.input ?? {}) as Record<string, unknown>
  const path = a?.toolName === 'Bash' ? '' : String(input.file_path ?? input.path ?? '')
  const code = a?.toolName === 'Bash' ? `$ ${String(input.command ?? '')}` : path || (a?.input ? JSON.stringify(a.input, null, 2) : '')
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
      {item.overlap && <OverlapDetail overlap={item.overlap} />}
      {a && (pending || phase === 'folding') && isTool(a) && (
        <>
          {code && <div className="ib-code mono">{path ? <FileLabel path={path} /> : code}</div>}
          <dl className="ib-facts">
            {a.detail && <><dt>Why</dt><dd>{a.detail}</dd></>}
            {ws && <><dt>Workspace</dt><dd className="mono">{ws.branch}</dd></>}
          </dl>
          {phase !== 'folded' && (
            <div className={`ib-acts${phase ? ' decide-fold' : ''}`}>
              <Button onClick={() => decideAtOnce(a, { behavior: 'deny', message: 'Denied in Kernel.' })}>Deny</Button>
              <button type="button" className="ib-link" onClick={() => decideAtOnce(a, { behavior: 'allow', always: true })}>Always allow in this project</button>
              <span className="grow" />
              <Button variant="primary" onClick={() => decideAtOnce(a, { behavior: 'allow' })}>Approve</Button>
            </div>
          )}
        </>
      )}
      {a && pending && !isTool(a) && <div className="ib-card"><ApprovalCard approval={a} /></div>}
      {n.kind === 'trust' && n.projectId && n.workspaceId && (
        <div className="ib-acts">
          <button type="button" className="ib-link" onClick={() => go({ name: 'workspace', workspaceId: n.workspaceId! })}>Open workspace</button>
          <span className="grow" />
          <Button variant="primary" onClick={() => actions.ui.openModal({ name: 'confirm', kind: 'trust', projectId: n.projectId! })}>Review scripts</Button>
        </div>
      )}
      {!a && pending && n.kind !== 'trust' && n.workspaceId && (
        <div className="ib-acts">
          <Button variant="primary" onClick={() => go({ name: 'workspace', workspaceId: n.workspaceId! })}>{n.kind === 'merge' ? 'Open PR' : 'Open workspace'}</Button>
        </div>
      )}
      {!pending && phase !== 'folding' && (
        <div className="ib-outcome">
          {result && <span>{result}</span>}
          {n.workspaceId && <button type="button" className="ib-link" onClick={() => go({ name: 'workspace', workspaceId: n.workspaceId! })}>{n.kind === 'finished' ? 'Review diff' : 'Open workspace'}</button>}
        </div>
      )}
    </article>
  )
}

/** Inbox.png and InboxEmpty.png: everything that needs the user, and what happened while they were away. */
export function Inbox() {
  const notifications = useStore((s) => s.notifications)
  const approvals = useStore((s) => s.approvals)
  const projects = useStore((s) => s.projects)
  const overlaps = useStore((s) => s.overlaps)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const firstProject = useStore((s) => s.projects.find((r) => !r.archived)?.id)
  const lead = useStore((s) => (firstProject ? s.agents[firstProject]?.find((a) => a.lead) : undefined))
  // The tab stays picked when you leave the Inbox and come back (DESIGN.md, Remembered choices).
  const [tab, setTab] = useRemembered<InboxTab>('kernel.inboxTab', oneOf<InboxTab>(['all', 'needs', 'updates'], 'all'))
  const [sel, setSel] = useState<string | null>(null)
  const detail = useRef<HTMLDivElement>(null)
  const all = useMemo(() => inboxItems(notifications, approvals, projects, allOverlaps(overlaps), workspaces), [notifications, approvals, projects, overlaps, workspaces])
  const list = all.filter((i) => inTab(i, tab))
  const shownRows = useHeldRows(list, (i) => i.n.id, (i) => i.approval?.id)
  const cur = list.find((i) => i.n.id === sel) ?? list[0]
  const count = (t: InboxTab) => all.filter((i) => inTab(i, t)).length

  const markRead = (ids: string[] | 'all') => void call('notifications.read', { ids }).then((rows) => rows.forEach(actions.notifications.upsert)).catch(() => undefined)
  const open = (i: InboxItem) => { setSel(i.n.id); if (!i.n.read) markRead([i.n.id]) }

  // Keyboard: the list keys come from useListKeys, j and k also work from anywhere on the screen, a approves, d denies. Typing in a field is left alone.
  const keys = useListKeys({
    ids: list.map((i) => i.n.id),
    rowId: (id) => `ib-${id}`,
    current: cur?.n.id,
    onCurrent: (id) => { const i = list.find((x) => x.n.id === id); if (i) open(i) },
    onOpen: (id) => {
      const i = list.find((x) => x.n.id === id)
      if (i) flushSync(() => open(i))
      detail.current?.querySelector<HTMLElement>('button, input')?.focus()
    },
  })
  const state = useRef({ list, cur, sel })
  state.current = { list, cur, sel }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return
      const { list, cur, sel } = state.current
      // Nothing chosen yet: the first row only looks selected, so the first j or k lands on it.
      const at = cur && sel ? list.findIndex((i) => i.n.id === cur.n.id) : -1
      if ((e.key === 'j' || e.key === 'k') && !t?.closest('[data-list-row]')) {
        const move = listKeyAction(e, at, list.length)
        const next = move?.kind === 'move' ? list[move.to] : undefined
        if (next) { e.preventDefault(); open(next); const row = document.getElementById(`ib-${next.n.id}`); row?.focus(); row?.scrollIntoView({ block: 'nearest' }) }
      } else if ((e.key === 'a' || e.key === 'd') && cur?.approval?.status === 'pending' && cur.approval.kind !== 'question') {
        e.preventDefault()
        decideAtOnce(cur.approval, e.key === 'a' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied in Kernel.' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="panel">
      <header className="header" style={{ paddingRight: 12 }}>
        <SidebarToggleSlot />
        <Icon name="inbox" />
        <h1>Inbox</h1>
        <span className="grow" />
        <button type="button" className="ib-link muted" disabled={!all.some((i) => !i.n.read)} onClick={() => markRead('all')}>Mark all read</button>
      </header>
      <div className="ib-tabs" role="group" aria-label="Filter the inbox">
        {tabs.map(([id, label]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="ib-n">{count(id)}</span></Pill>)}
      </div>
      <div className="ib-body-wrap">
        <div className="ib-list" role="group" aria-label="Inbox items" onKeyDown={keys.onKeyDown}>
          {shownRows.map(({ item: i, held }) => (
            <button key={i.n.id} type="button" {...keys.rowProps(i.n.id)} className={`ib-row${held ? ' decide-fold' : ''}`} aria-current={i.n.id === cur?.n.id ? 'true' : undefined} data-unread={!i.n.read ? 'true' : undefined} onClick={() => open(i)}>
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
          {cur ? <Detail key={cur.n.id} item={cur} /> : !projects.some((r) => !r.archived) ? (
            <EmptyList icon="branch" title="Add your first project" action={<div className="ib-first"><Button variant="primary" onClick={() => actions.ui.openModal({ name: 'connectRepo' })}>Connect a repo</Button><Button onClick={() => actions.ui.openModal({ name: 'openFolder' })}>Open a folder</Button></div>}>
              A project is one project with its own team of agents. Nothing needs you until you add one.
            </EmptyList>
          ) : (
            <div className="ib-empty">
              <h2>You're all caught up</h2>
              <p>Approvals, plans to review and finished work land here. Nothing needs you right now.</p>
              {firstProject && <button type="button" className="ib-link" onClick={() => void openProject(firstProject)}>{lead ? `Open ${lead.name}'s chat` : 'Open the team'}</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
