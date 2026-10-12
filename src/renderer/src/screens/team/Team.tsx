import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, loadRoom, useStore } from '../../store'
import { Button, EmptyState, Icon, Menu, useBusy } from '../../ui'
import { TeamTemplates } from './Templates'
import { FILTERS, LOUD, STATUS_WORD, currentWorkspace, fileLabel, isNew, modelName, roleTags, shirtOf, shortFile, warningText, workspaceLabel, type FilterId } from './model'
import { STARTER_TEAMMATES } from '../rooms/draft'
import './team.css'
import { SidebarToggle } from '../../components/PanelToggles'

const NO_AGENTS: AgentDef[] = []

/**
 * Team.png: everyone in .claude/agents with their model, status, workspace and file. A row opens the profile (AgentProfile.png).
 * TeamOwnAgents.png: Kernel's own Rowan and Theo where the repo has no Lead or reviewer, tags, and what Kernel noticed in a
 * file (KERNEL-397).
 */
export function Team({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? NO_AGENTS)
  const status = useStore((s) => s.status[roomId])
  const workspaces = useStore((s) => s.workspaces)
  const [filter, setFilter] = useState<FilterId>('all')
  const [retired, setRetired] = useState<AgentDef[]>([])
  const [busy, run] = useBusy()
  const [adding, setAdding] = useState(false)
  const starterAnchor = useRef<HTMLDivElement>(null)
  useEffect(() => { void loadRoom(roomId) }, [roomId])
  // Retired agents sit in .claude/retired-agents (D-003). The list is read again when the team changes, so a retire shows here at once.
  useEffect(() => { void call('agents.list', { roomId, retired: true }).then(setRetired).catch(() => setRetired([])) }, [roomId, agents])

  const team = useMemo(() => agents.filter((a) => !a.retired), [agents])
  const files = team.filter((a) => !a.builtIn)
  const starters = STARTER_TEAMMATES.filter((m) => !team.some((a) => a.id === m.id))
  const stateOf = (a: AgentDef) => status?.[a.id] ?? 'idle'
  const count = (id: FilterId) => { const f = FILTERS.find((x) => x.id === id)!; return f.states ? team.filter((a) => f.states!.includes(stateOf(a))).length : team.length }
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!
    return f.states ? team.filter((a) => f.states!.includes(status?.[a.id] ?? 'idle')) : team
  }, [team, filter, status])

  if (!room) return <div className="panel" />
  const hire = () => actions.ui.openModal({ name: 'newAgent', roomId, step: 'describe' })
  const addStarter = (id: string) => run('starter', async () => {
    try {
      await call('agents.addStarter', { roomId, id })
    } catch (e) { actions.ui.toast({ title: 'Could not add the agent', sub: cleanError(e) }) }
  })
  const restore = (a: AgentDef) => run(a.id, async () => {
    try {
      const def = await call('agents.restore', { roomId, agentId: a.id })
      actions.agents.set(roomId, [...team.filter((x) => x.id !== def.id), def])
      setRetired((r) => r.filter((x) => x.id !== a.id))
    } catch (e) { actions.ui.toast({ title: 'Could not restore', sub: cleanError(e) }) }
  })

  return (
    <div className="panel">
      <header className="header" style={{ borderBottom: 0 }}>
        <SidebarToggle />
        <span className="ink2">{room.name}</span><Icon name="right" size={12} /><h1>Team</h1>
        <span className="grow" />
        {!!files.length && !!starters.length && (
          <div className="tm-starters" ref={starterAnchor}>
            <Button aria-haspopup="menu" aria-expanded={adding} busy={busy === 'starter'} busyLabel="Adding" disabled={busy !== null} onClick={() => setAdding((o) => !o)}>Add a starter agent<Icon name="chevron" size={10} stroke={1.9} /></Button>
            {adding && <Menu label="Starter agents" anchorRef={starterAnchor} onClose={() => setAdding(false)} style={{ right: 0, top: 34, width: 220 }} items={starters.map((m) => ({ id: m.id, label: `${m.name} · ${m.role}`, onSelect: () => { setAdding(false); void addStarter(m.id) } }))} />}
          </div>
        )}
        <Button variant="primary" icon="plus" onClick={hire}>New agent</Button>
      </header>
      <div className="tm-bar">
        <div role="group" aria-label="Filter by status" className="tm-filter">
          {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="tm-n">{count(f.id)}</span></button>)}
        </div>
      </div>
      <div className="tm-body">
        <p className="tm-intro">
          Agents come from <span className="mono ink2">.claude/agents</span> in this repo. Add a file, or ask Rowan to write one, and the agent joins the team.
          {!!files.length && team.some((a) => a.builtIn) && <> Kernel{'\u2019'}s own Rowan and Theo fill in when the repo has no Lead or reviewer. <button type="button" className="tm-link" onClick={() => go({ name: 'settings', page: 'room', roomId, section: 'agents' })}>Change who leads and reviews</button></>}
        </p>
        {!files.length ? (
          <EmptyState icon="team" title="No agents yet" action={<><TeamTemplates room={room} /><Button variant="ghost" icon="plus" onClick={hire}>Make one agent instead</Button></>}>Start from a team, or describe one agent and Rowan writes the file.</EmptyState>
        ) : (
          <>
            <div className="tm-grid tm-head" aria-hidden="true"><span>Agent</span><span>Model</span><span>Status</span><span>Workspace</span><span>File</span></div>
            <ul className="tm-list" aria-label="Agents">
              {shown.map((a) => {
                const st = stateOf(a)
                const warning = a.warnings?.[0]
                return (
                  <li key={a.id}>
                    <button type="button" className="tm-grid tm-row" data-warn={warning ? '' : undefined} onClick={() => go({ name: 'agent', roomId, agentId: a.id })}>
                      <span className="tm-who">
                        <span className="tm-av" aria-hidden="true" style={{ background: shirtOf(a, team, room) }}>{a.name[0]}</span>
                        <span className="tm-text">
                          <span className="tm-line"><span className="tm-name">{a.name}</span><span className="tm-role">{a.role}</span>{isNew(a) && <span className="tm-new">New</span>}{roleTags(a).map((t) => <span key={t} className="tm-new">{t}</span>)}</span>
                          <span className="tm-desc">{a.description}</span>
                          {warning && <span className="tm-warn"><Icon name="warning" size={12} />{warningText(warning)}</span>}
                        </span>
                      </span>
                      <span className="tm-model">{modelName(a.model)}</span>
                      <span className="tm-status" data-loud={LOUD.includes(st)}>{STATUS_WORD[st]}</span>
                      <span className="tm-mono ink2">{workspaceLabel(currentWorkspace(a.id, roomId, workspaces))}</span>
                      <span className={a.builtIn ? 'tm-file' : 'tm-mono muted'}>{fileLabel(a)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        {!!retired.length && (
          <section className="tm-retired" aria-label="Retired agents">
            <h2>Retired</h2>
            <ul className="tm-list">
              {retired.map((a) => (
                <li key={a.id}>
                  <span className="tm-av" aria-hidden="true">{a.name[0]}</span>
                  <span className="grow">{a.name} <span className="tm-role">{a.role}</span></span>
                  <span className="tm-mono">{shortFile(a.file)}</span>
                  <Button busy={busy === a.id} busyLabel="Restoring" disabled={busy !== null} onClick={() => void restore(a)}>Restore</Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
