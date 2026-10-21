import { useMemo, useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { actions, go, useStore } from '../../store'
import { ProjectIcon } from '../../components/ProjectIcon'
import { oneOf, useRemembered } from '../../remember'
import { Button, EmptyState, Icon, IconButton, Pill, useBusy, useListKeys } from '../../ui'
import { archivedList, historyName, deleteAllLabel, endedAt, groupOf, inTab, matches, prGlyph, prLabel, whenLabel, type HistoryGroup, type HistoryTab } from './model'
import { restoreArchived } from './restore'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import './history.css'
import { SidebarToggleSlot } from '../../components/PanelToggles'
import { useKeptScroll } from '../../ui/keptScroll'

const tabs: [HistoryTab, string][] = [['all', 'All'], ['merged', 'Merged'], ['notMerged', 'Not merged']]
const groups: HistoryGroup[] = ['Today', 'This week', 'Earlier']

/**
 * History.png: every archived workspace, and a way back. Restore recreates the worktree from its branch and reopens its chats.
 * Delete is the way out (KERNEL-333): one row, or every row in view.
 */
export function History() {
  const only = useStore((s) => (s.ui.route.name === 'history' ? s.ui.route.projectId : undefined))
  const workspaces = useStore((s) => s.workspaces)
  const projects = useStore((s) => s.projects)
  const agents = useStore((s) => s.agents)
  const [tab, setTab] = useRemembered<HistoryTab>('kernel.historyTab', oneOf<HistoryTab>(['all', 'merged', 'notMerged'], 'all'))
  const [q, setQ] = useState('')
  const [busy, run] = useBusy()
  const projectName = (w: Workspace) => projects.find((r) => r.id === w.projectId)?.name
  const agentOf = (w: Workspace) => agents[w.projectId]?.find((a) => a.id === w.agentId)
  const agentName = (w: Workspace) => agentOf(w)?.name ?? w.agentId
  /** "Ivy · QA" under a teammate's workspace. Kernel's own chat names Kernel alone. */
  const byLine = (w: Workspace) => { const a = agentOf(w); return a?.role && !isLeadChatWorkspace(w) ? `${a.name} · ${a.role}` : agentName(w) }
  const threads = useStore((s) => s.threads)
  const nameOf = (w: Workspace) => historyName(w, threads)

  const all = useMemo(() => archivedList(workspaces).filter((w) => !only || w.projectId === only), [workspaces, only])
  const found = all.filter((w) => matches({ ...w, name: nameOf(w) }, q, projectName(w), agentName(w)))
  const rows = found.filter((w) => inTab(w, tab))
  const count = (t: HistoryTab) => found.filter((w) => inTab(w, t)).length

  const restore = (w: Workspace) => run(w.id, () => restoreArchived(w, nameOf(w)))

  const order = groups.flatMap((g) => rows.filter((w) => groupOf(endedAt(w)) === g))
  const keys = useListKeys({ ids: order.map((w) => w.id), rowId: (id) => `hs-${id}`, onOpen: (id) => { const w = order.find((x) => x.id === id); if (w && busy === null) void restore(w) } })

  const body = useRef<HTMLDivElement>(null)
  useKeptScroll(body, { key: `history:${only ?? 'all'}`, ready: rows.length > 0 })

  const scope = only ? projects.find((r) => r.id === only) : undefined
  const showAll = () => go({ name: 'history' }, { history: 'replace' })
  const confirmDelete = (workspaceIds: string[]) => actions.ui.openModal({ name: 'confirm', kind: 'deleteHistory', workspaceIds })

  return (
    <div className="panel">
      <header className="header hs-header">
        <SidebarToggleSlot />
        <h1>History</h1>
        {scope && (
          <span className="hs-scope">
            <ProjectIcon project={scope} size={14} />
            <span className="ellipsis">{scope.name}</span>
            <button type="button" className="hs-scope-x" aria-label="Show every project" onClick={showAll}><Icon name="close" size={12} /></button>
          </span>
        )}
        <span className="grow" />
        {scope && <Button variant="ghost" onClick={showAll}>All projects<Icon name="arrowRight" size={12} /></Button>}
        <span className="hs-search">
          <Icon name="search" size={13} />
          <input type="search" placeholder="Search workspaces" aria-label="Search workspaces" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
      </header>
      <div className="hs-tabs" role="group" aria-label="Filter history">
        {tabs.map(([id, label]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="hs-n">{count(id)}</span></Pill>)}
        {rows.length > 0 && <Button variant="ghost" className="hs-bulk" disabled={busy !== null} onClick={() => confirmDelete(rows.map((w) => w.id))}>{deleteAllLabel(tab, q.trim() !== '', rows.length)}</Button>}
      </div>
      <div className="hs-body" ref={body}>
        {groups.map((g) => {
          const list = rows.filter((w) => groupOf(endedAt(w)) === g)
          if (!list.length) return null
          return (
            <section key={g} aria-label={g}>
              <h2 className="hs-group">{g}</h2>
              <ul className="hs-list" onKeyDown={keys.onKeyDown}>
                {list.map((w) => (
                  <li key={w.id} {...keys.rowProps(w.id)} data-keep-id={w.id} className="hs-row">
                    <span className="col hs-name"><span className="ellipsis hs-title">{isLeadChatWorkspace(w) && <Icon name="chat" size={14} />}{nameOf(w)}</span><span className="ellipsis hs-sub">{byLine(w)}</span></span>
                    <span className="mono ellipsis hs-branch">{w.branch}</span>
                    <span className="ellipsis hs-project">{projectName(w)}</span>
                    <span className="hs-pr" data-merged={w.prState === 'merged' ? 'true' : undefined}>{w.prNumber ? <Icon name={prGlyph(w)} size={12} /> : null}{prLabel(w)}</span>
                    <span className="hs-when">{whenLabel(endedAt(w))}</span>
                    <span className="hs-actions">
                      <Button busy={busy === w.id} busyPattern="ripple" busyLabel="Restoring" disabled={busy !== null} aria-label={busy === w.id ? `Restoring ${nameOf(w)}` : `Restore ${nameOf(w)}`} onClick={() => void restore(w)}>Restore</Button>
                      <IconButton icon="trash" label={`Delete ${nameOf(w)}`} disabled={busy !== null} onClick={() => confirmDelete([w.id])} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
        {!rows.length && (
          <EmptyState icon="archive" title={all.length ? 'Nothing matches' : 'Nothing archived yet'}>
            {all.length ? 'Try another word, or another tab.' : 'Archived chats and workspaces land here, ready to restore.'}
          </EmptyState>
        )}
      </div>
    </div>
  )
}
