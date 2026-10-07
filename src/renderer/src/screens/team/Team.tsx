import { useEffect, useMemo, useState } from 'react'
import type { AgentDef } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadRoom, useStore } from '../../store'
import { Button, EmptyState, Icon } from '../../ui'
import { FILTERS, LOUD, STATUS_WORD, currentWorkspace, isNew, modelName, shirtOf, shortFile, workspaceLabel, type FilterId } from './model'
import './team.css'

const NO_AGENTS: AgentDef[] = []

/** Team.png: everyone in .claude/agents with their model, status, workspace and file. A row opens the profile (AgentProfile.png). */
export function Team({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? NO_AGENTS)
  const status = useStore((s) => s.status[roomId])
  const workspaces = useStore((s) => s.workspaces)
  const [filter, setFilter] = useState<FilterId>('all')
  const [retired, setRetired] = useState<AgentDef[]>([])
  useEffect(() => { void loadRoom(roomId) }, [roomId])
  // Retired agents sit in .claude/retired-agents (D-003). The list is read again when the team changes, so a retire shows here at once.
  useEffect(() => { void call('agents.list', { roomId, retired: true }).then(setRetired).catch(() => setRetired([])) }, [roomId, agents])

  const team = useMemo(() => agents.filter((a) => !a.retired), [agents])
  const stateOf = (a: AgentDef) => status?.[a.id] ?? 'idle'
  const count = (id: FilterId) => { const f = FILTERS.find((x) => x.id === id)!; return f.states ? team.filter((a) => f.states!.includes(stateOf(a))).length : team.length }
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!
    return f.states ? team.filter((a) => f.states!.includes(status?.[a.id] ?? 'idle')) : team
  }, [team, filter, status])

  if (!room) return <div className="panel" />
  const hire = () => actions.ui.openModal({ name: 'newAgent', roomId, step: 'describe' })
  const restore = async (a: AgentDef) => {
    try {
      const def = await call('agents.restore', { roomId, agentId: a.id })
      actions.agents.set(roomId, [...team.filter((x) => x.id !== def.id), def])
      setRetired((r) => r.filter((x) => x.id !== a.id))
      actions.ui.toast({ title: `${def.name} is back on the team` })
    } catch (e) { actions.ui.toast({ title: 'Could not restore', sub: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }) }
  }

  return (
    <div className="panel">
      <header className="header" style={{ borderBottom: 0 }}>
        <span className="ink2">{room.name}</span><Icon name="right" size={12} /><h1>Team</h1>
        <span className="grow" />
        <Button variant="primary" icon="plus" onClick={hire}>New agent</Button>
      </header>
      <div className="tm-bar">
        <button type="button" className="pill" onClick={() => go({ name: 'floor', roomId })}>Floor</button>
        <button type="button" className="pill" onClick={() => go({ name: 'board', roomId })}>Board</button>
        <button type="button" className="pill" aria-current="page">Team</button>
        <span className="grow" />
        <div role="group" aria-label="Filter by status" className="tm-filter">
          {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="tm-n">{count(f.id)}</span></button>)}
        </div>
      </div>
      <div className="tm-body">
        <p className="tm-intro">Agents come from <span className="mono ink2">.claude/agents</span> in this repo. Add a file, or ask Rowan to write one, and the agent takes a desk on the floor.</p>
        {!team.length ? (
          <EmptyState icon="team" title="No agents yet" action={<Button variant="primary" icon="plus" onClick={hire}>New agent</Button>}>Describe one and Rowan writes the file.</EmptyState>
        ) : (
          <>
            <div className="tm-grid tm-head" aria-hidden="true"><span>Agent</span><span>Model</span><span>Status</span><span>Workspace</span><span>File</span></div>
            <ul className="tm-list" aria-label="Agents">
              {shown.map((a) => {
                const st = stateOf(a)
                return (
                  <li key={a.id}>
                    <button type="button" className="tm-grid tm-row" onClick={() => go({ name: 'agent', roomId, agentId: a.id })}>
                      <span className="tm-who">
                        <span className="tm-av" aria-hidden="true" style={{ background: shirtOf(a, team, room) }}>{a.name[0]}</span>
                        <span className="tm-text">
                          <span className="tm-line"><span className="tm-name">{a.name}</span><span className="tm-role">{a.role}</span>{isNew(a) && <span className="tm-new">New</span>}</span>
                          <span className="tm-desc">{a.description}</span>
                        </span>
                      </span>
                      <span className="tm-model">{modelName(a.model)}</span>
                      <span className="tm-status" data-loud={LOUD.includes(st)}>{STATUS_WORD[st]}</span>
                      <span className="tm-mono ink2">{workspaceLabel(currentWorkspace(a.id, roomId, workspaces))}</span>
                      <span className="tm-mono muted">{shortFile(a.file)}</span>
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
                  <Button onClick={() => void restore(a)}>Restore</Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
