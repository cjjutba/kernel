import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { AgentDef, Approval, Overlap } from '@shared/types'
import { call } from '../../api'
import { FileLabel } from '../../components/FileIcon'
import { actions, go, useStore } from '../../store'
import { oneOf, useRemembered } from '../../remember'
import { AgentAvatar, Button, LinkButton, EmptyList, Icon, IconButton, Pill, useBusy, useListKeys, listKeyAction } from '../../ui'
import { ApprovalCard } from '../workspace/cards/ApprovalCard'
import { outcome } from '../workspace/cards/steps'
import { attempt } from '../workspace/MessageActions'
import { decideAtOnce, useFoldPhase, useHeldRows } from '../workspace/cards/decideFold'
import { age, agentOf, allOverlaps, fileName, inboxItems, inTab, matchesFilter, names, needsYou, type InboxItem, type InboxTab } from './model'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import './inbox.css'
import { SidebarToggleSlot } from '../../components/PanelToggles'

const tabs: [InboxTab, string][] = [['all', 'All'], ['needs', 'Needs you'], ['updates', 'Updates']]

const isTool = (a?: Approval) => !!a && a.kind === 'tool' && a.toolName !== 'ExitPlanMode'

const NO_AGENTS: AgentDef[] = []

/** Agents changing the same file in different worktrees. The Lead sorts it out. */
export function SortOverlap({ overlap: o }: { overlap: Overlap }) {
  const lead = useStore((s) => s.agents[o.projectId]?.find((a) => a.lead))
  const [busy, run] = useBusy()
  const name = lead?.name ?? 'the Lead'
  return (
    <Button variant="primary" busy={!!busy} busyPattern="ripple" busyLabel="Sending" disabled={!!busy} onClick={() => void run('sort', () => attempt(`Could not hand that to ${name}`, () => call('projects.resolveOverlap', { overlapId: o.id })))}>
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
      <div className="ib-file mono"><FileLabel path={o.path} /></div>
      <div className="ib-files" role="list" aria-label={`Who changed ${fileName(o.path)}`}>
        {rows.map((r) => (
          <div key={r.workspaceId} className="ib-side" role="listitem">
            <AgentAvatar name={r.name} size={18} />
            <span className="col grow">
              {r.ws
                ? <LinkButton variant="action" size="ui" className="ib-side-name" aria-label={`Open ${r.name}'s workspace ${r.ws.name}`} onClick={() => go({ name: 'workspace', workspaceId: r.ws!.id })}>{r.name}'s workspace</LinkButton>
                : <span className="ib-side-name">{r.name}'s workspace</span>}
              <span className="ib-branch mono ellipsis">{r.ws?.branch ?? r.workspaceId}, {r.lines}</span>
            </span>
            {r.ws?.stat && <span className="ib-stat mono">+{r.ws.stat.added} −{r.ws.stat.removed}</span>}
          </div>
        ))}
      </div>
      <div className="ib-acts"><SortOverlap overlap={o} /></div>
    </>
  )
}

/** The facts under a permission: why Kernel asked, where it would run and in which chat. */
function Facts({ rows }: { rows: [string, ReactNode, boolean?][] }) {
  return (
    <dl className="ib-facts">
      {rows.map(([k, v, mono]) => <Fragment key={k}><dt>{k}</dt><dd className={mono ? 'mono' : undefined}>{v}</dd></Fragment>)}
    </dl>
  )
}

/** The fields an MCP tool was called with, one row each, as the chat's permission card lists them. */
function ToolFields({ input }: { input: Record<string, unknown> }) {
  const rows = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!rows.length) return null
  const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const label = (k: string) => k.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
  return <dl className="ib-fields">{rows.map(([k, v]) => <Fragment key={k}><dt>{label(k)}</dt><dd>{show(v)}</dd></Fragment>)}</dl>
}

function Detail({ item }: { item: InboxItem }) {
  const { n, approval: a } = item
  const agents = useStore((s) => s.agents)
  const projects = useStore((s) => s.projects)
  const ws = useStore((s) => s.workspaces.find((w) => w.id === (a?.workspaceId ?? n.workspaceId)))
  const chat = useStore((s) => (ws && a?.chatId ? s.chats[ws.id]?.find((c) => c.id === a.chatId) : undefined))
  const phase = useFoldPhase(a?.id ?? '')
  const agent = agentOf(n, agents)
  const input = (a?.input ?? {}) as Record<string, unknown>
  const mcp = !!a?.gate?.server || /^mcp__/.test(a?.toolName ?? '')
  const bash = a?.toolName === 'Bash'
  const path = bash || mcp ? '' : String(input.file_path ?? input.path ?? '')
  const code = bash ? String(input.command ?? '') : path || (!mcp && a?.input ? JSON.stringify(a.input, null, 2) : '')
  const heading = n.heading ?? n.title
  const pending = a ? a.status === 'pending' : n.needsYou
  const result = a && a.status !== 'pending' ? (n.resolved ?? outcome(a)) : n.resolved
  const projectName = projects.find((r) => r.id === (n.projectId ?? a?.projectId))?.name
  const who = agent?.name ?? 'Kernel'
  const open = () => ws && go({ name: 'workspace', workspaceId: ws.id })
  return (
    <article className="ib-detail" aria-label={heading}>
      {item.overlap ? (
        <header className="ib-who ib-who-plain"><Icon name="prConflict" size={14} /><span>Overlap</span><span className="ib-from-sub">· {projectName ? `${projectName} · ` : ''}{age(n.createdAt)} ago</span></header>
      ) : (
        <header className="ib-who">
          <AgentAvatar name={who} size={32} />
          <div className="col">
            <span className="ib-from">{who}</span>
            <span className="ib-from-sub">{n.sub} · {age(n.createdAt)} ago</span>
          </div>
        </header>
      )}
      <h2>{heading}</h2>
      {n.body && <p className="ib-body">{n.body}</p>}
      {item.overlap && <OverlapDetail overlap={item.overlap} />}
      {a && (pending || phase === 'folding') && isTool(a) && (
        <>
          {code && <div className="ib-code mono">{path ? <FileLabel path={path} /> : <>{bash && <span className="ib-prompt" aria-hidden="true">$</span>}{code}</>}</div>}
          {mcp && <ToolFields input={input} />}
          <Facts rows={[...(a.detail ? [['Why', a.detail] as [string, ReactNode]] : []), ...(ws ? [['Workspace', ws.branch, true] as [string, ReactNode, boolean]] : []), ...(chat ? [['Chat', chat.title] as [string, ReactNode]] : [])]} />
          {a.reason && <p className="ib-reason"><Icon name="info" size={12} />{a.reason}</p>}
          {phase !== 'folded' && (
            <div className={`ib-acts${phase ? ' decide-fold' : ''}`}>
              <Button onClick={() => decideAtOnce(a, { behavior: 'deny', message: 'Denied in Kernel.' })}>Deny</Button>
              <Button variant="ghost" onClick={() => decideAtOnce(a, { behavior: 'allow', always: true })}>Always allow here</Button>
              <span className="grow" />
              <Button variant="primary" aria-keyshortcuts="Meta+Enter" onClick={() => decideAtOnce(a, { behavior: 'allow' })}>Allow once<span className="ib-kbd" aria-hidden="true">⌘↵</span></Button>
            </div>
          )}
          {ws && phase !== 'folded' && <LinkButton variant="quiet" size="ui" className="ib-open-chat" onClick={open}>Open {who}'s chat<Icon name="arrowRight" size={12} /></LinkButton>}
        </>
      )}
      {a && pending && !isTool(a) && <div className="ib-card"><ApprovalCard approval={a} /></div>}
      {!a && !item.overlap && pending && n.workspaceId && (
        <div className="ib-acts">
          <Button variant="primary" onClick={() => go({ name: 'workspace', workspaceId: n.workspaceId! })}>{n.kind === 'merge' ? 'Open PR' : 'Open workspace'}</Button>
        </div>
      )}
      {!pending && phase !== 'folding' && (
        <div className="ib-outcome">
          {result && <span>{result}</span>}
          {n.workspaceId && <LinkButton variant="action" size="ui" onClick={() => go({ name: 'workspace', workspaceId: n.workspaceId! })}>{n.kind === 'finished' ? 'Review diff' : 'Open workspace'}</LinkButton>}
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
  const agents = useStore((s) => s.agents)
  // The tab stays picked when you leave the Inbox and come back (DESIGN.md, Remembered choices).
  const [tab, setTab] = useRemembered<InboxTab>('kernel.inboxTab', oneOf<InboxTab>(['all', 'needs', 'updates'], 'all'))
  const [sel, setSel] = useState<string | null>(null)
  const detail = useRef<HTMLDivElement>(null)
  const all = useMemo(() => inboxItems(notifications, approvals, projects, allOverlaps(overlaps)), [notifications, approvals, projects, overlaps])
  // A filter typed in the header narrows the rows of the tab. It lasts while the Inbox is open.
  const [filter, setFilter] = useState<string | null>(null)
  const filterBox = useRef<HTMLInputElement>(null)
  const list = all.filter((i) => inTab(i, tab) && matchesFilter(i, filter ?? ''))
  const shownRows = useHeldRows(list, (i) => i.n.id, (i) => i.approval?.id)
  const cur = list.find((i) => i.n.id === sel) ?? list[0]
  // The list keeps one spot per tab and the reading pane one per item. A j or k is going somewhere on purpose, so it ends a restore (KERNEL-919).
  const listEl = useRef<HTMLDivElement>(null)
  const listKeep = useKeptScroll(listEl, { key: spotKey.inbox('list', tab), ready: list.length > 0 })
  useKeptScroll(detail, { key: spotKey.inbox('pane', cur?.n.id), ready: !!cur })
  const count = (t: InboxTab) => all.filter((i) => inTab(i, t)).length

  const markRead = (ids: string[] | 'all') => void call('notifications.read', { ids }).then((rows) => rows.forEach(actions.notifications.upsert)).catch(() => undefined)
  const open = (i: InboxItem) => { listKeep.stop(); setSel(i.n.id); if (!i.n.read) markRead([i.n.id]) }

  // Keyboard: the list keys come from useListKeys, j and k also work from anywhere on the screen, a approves, d denies. Typing in a field is left alone.
  const keys = useListKeys({
    ids: list.map((i) => i.n.id),
    rowId: (id) => `ib-${id}`,
    current: cur?.n.id,
    onCurrent: (id) => { const i = list.find((x) => x.n.id === id); if (i) open(i) },
    onOpen: (id) => {
      const i = list.find((x) => x.n.id === id)
      if (i) flushSync(() => open(i))
      detail.current?.querySelector<HTMLElement>('textarea, button, input')?.focus()
    },
  })
  const state = useRef({ list, cur, sel })
  state.current = { list, cur, sel }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const { list, cur, sel } = state.current
      // Cmd+Enter is Allow once, from anywhere on the screen that is not a button of its own.
      if (e.metaKey && e.key === 'Enter' && !e.ctrlKey && !e.altKey && !t?.closest('button, a, textarea, input') && cur?.approval?.status === 'pending' && cur.approval.kind === 'tool' && cur.approval.toolName !== 'ExitPlanMode') {
        e.preventDefault()
        decideAtOnce(cur.approval, { behavior: 'allow' })
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return
      // Nothing chosen yet: the first row only looks selected, so the first j or k lands on it.
      const at = cur && sel ? list.findIndex((i) => i.n.id === cur.n.id) : -1
      if ((e.key === 'j' || e.key === 'k') && !t?.closest('[data-list-row]')) {
        const move = listKeyAction(e, at, list.length)
        const next = move?.kind === 'move' ? list[move.to] : undefined
        if (next) { e.preventDefault(); open(next); const row = document.getElementById(`ib-${next.n.id}`); row?.focus(); row?.scrollIntoView({ block: 'nearest' }) }
      } else if (e.key === '/' ) {
        e.preventDefault()
        setFilter((f) => f ?? '')
        setTimeout(() => filterBox.current?.focus())
      } else if ((e.key === 'a' || e.key === 'd') && cur?.approval?.status === 'pending' && cur.approval.kind !== 'question') {
        e.preventDefault()
        decideAtOnce(cur.approval, e.key === 'a' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied in Kernel.' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const noProject = !projects.some((r) => !r.archived)
  const empty = list.length === 0
  return (
    <div className="panel">
      <header className="header ib-header">
        <SidebarToggleSlot />
        <h1>Inbox</h1>
        <span className="grow" />
        {filter === null
          ? <IconButton icon="search" size={14} label="Filter the inbox" data-tip-kbd="/" onClick={() => { setFilter(''); setTimeout(() => filterBox.current?.focus()) }} />
          : (
            <span className="ib-filter">
              <Icon name="search" size={14} />
              <input ref={filterBox} type="search" aria-label="Filter the inbox" placeholder="Filter the inbox" autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFilter(null) } }} />
            </span>
          )}
        <LinkButton variant="quiet" size="ui" disabled={!all.some((i) => !i.n.read)} onClick={() => markRead('all')}>Mark all read</LinkButton>
      </header>
      <div className="ib-tabs" role="group" aria-label="Show in the inbox">
        {tabs.map(([id, label]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="ib-n">{count(id)}</span></Pill>)}
      </div>
      <div className="ib-body-wrap">
        {empty ? (
          noProject ? (
            <EmptyList icon="folder" title="Add your first project" action={<><Button variant="primary" onClick={() => actions.ui.openModal({ name: 'connectRepo' })}>Connect a repo</Button><Button onClick={() => actions.ui.openModal({ name: 'openFolder' })}>Open a folder</Button></>}>
              A project is one repo with its own team of agents. Nothing needs you until you add one.
            </EmptyList>
          ) : all.length === 0 ? (
            <EmptyList icon="inbox" title="You're all caught up">Questions, approvals, plans and pull requests from your agents land here.</EmptyList>
          ) : (
            <EmptyList icon="search" title={filter?.trim() ? 'Nothing matches' : 'Nothing here'} action={filter?.trim() ? <Button onClick={() => setFilter('')}>Clear the filter</Button> : tab !== 'all' ? <Button onClick={() => setTab('all')}>Show everything</Button> : undefined}>
              {filter?.trim() ? `Nothing in the inbox matches "${filter.trim()}".` : tab === 'needs' ? 'Nothing needs you right now.' : 'No updates yet.'}
            </EmptyList>
          )
        ) : (
          <>
            <div className="ib-list" ref={listEl} role="group" aria-label="Inbox items" onKeyDown={keys.onKeyDown}>
              {shownRows.map(({ item: i, held }) => {
                const who = agentOf(i.n, agents)?.name ?? 'Kernel'
                return (
                  <button key={i.n.id} type="button" {...keys.rowProps(i.n.id)} data-keep-id={i.n.id} className={`ib-row${held ? ' decide-fold' : ''}`} aria-current={i.n.id === cur?.n.id ? 'true' : undefined} data-unread={!i.n.read || needsYou(i) ? 'true' : undefined} onClick={() => open(i)}>
                    <AgentAvatar name={who} size={26} />
                    <span className="col grow" style={{ minWidth: 0 }}>
                      <span className="ib-title ellipsis">{i.n.title}</span>
                      <span className="ib-sub ellipsis">{needsYou(i) && <><span className="ib-needs">Needs you</span><span aria-hidden="true" className="ib-dot">·</span></>}{i.n.sub}</span>
                    </span>
                    <span className="ib-age">{age(i.n.createdAt)}</span>
                  </button>
                )
              })}
            </div>
            <div className="ib-pane" ref={detail}>{cur && <Detail key={cur.n.id} item={cur} />}</div>
          </>
        )}
      </div>
    </div>
  )
}
