import { useEffect, useMemo, useState } from 'react'
import type { AgentDef } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, loadRoom, useStore } from '../../store'
import { openRoom } from '../../lead'
import { Button, useBusy } from '../../ui'
import { STATUS_WORD, currentWorkspace, fileLabel, recentWork, shirtOf, shortFile } from '../team/model'
import '../team/team.css'
import { SidebarToggle } from '../../components/PanelToggles'
import { AgentFields, editOf, useAgentForm, useSkillNames } from './AgentEditor'

const NO_AGENTS: AgentDef[] = []

/**
 * AgentProfile.png: who the agent is and what they have been doing on the left, the editable file on the right. Save rewrites
 * the agent file. AgentProfileBuiltIn.png: Kernel's own Rowan or Theo, shown as it runs, with Customize to copy it into
 * .claude/agents (KERNEL-397). The fields are AgentEditor's, which Settings, Agents shows too (KERNEL-641).
 */
export function AgentProfile({ roomId, agentId }: { roomId: string; agentId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? NO_AGENTS)
  const allAgents = useStore((s) => s.agents)
  const rooms = useStore((s) => s.rooms)
  const status = useStore((s) => s.status[roomId]?.[agentId] ?? 'idle')
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks[roomId])
  const agent = agents.find((a) => a.id === agentId && !a.retired)
  useEffect(() => { void loadRoom(roomId) }, [roomId])

  const { form, set, saved, adopt, dirty } = useAgentForm(agent)
  const [saving, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const skillNames = useSkillNames(roomId)

  const inRooms = useMemo(() => rooms.filter((r) => !r.archived && (allAgents[r.id] ?? []).some((a) => a.id === agentId && !a.retired)), [rooms, allAgents, agentId])
  if (!room) return <div className="panel" />
  if (!agent || !form) {
    return (
      <div className="panel">
        <header className="header"><SidebarToggle /><button type="button" className="tm-crumb" onClick={() => go({ name: 'team', roomId })}>{room.name}</button><span className="tm-sep">/</span><h1>{agentId}</h1></header>
        <div className="tm-body"><p className="tm-intro">{agentId} is not on this team. They may have been retired, or the file was renamed.</p><Button onClick={() => go({ name: 'team', roomId })}>Back to the team</Button></div>
      </div>
    )
  }

  const ws = currentWorkspace(agent.id, roomId, workspaces)
  const recent = recentWork(agent.id, tasks ?? [], workspaces)
  const team = agents.filter((a) => !a.retired)
  const builtIn = !!agent.builtIn

  const save = () => run('save', async () => {
    setError(null)
    try {
      const def = await call('agents.save', { roomId, agentId: agent.id, patch: editOf(form) })
      actions.agents.set(roomId, agents.map((a) => (a.id === def.id ? { ...a, ...def } : a)))
      adopt(def)
    } catch (e) { setError(cleanError(e)) }
  })
  const retire = () => actions.ui.openModal({ name: 'confirm', kind: 'retire', roomId, agentId: agent.id })
  const customize = () => run('customize', async () => {
    setError(null)
    try {
      const def = await call('agents.customize', { roomId, agentId: agent.id })
      actions.ui.toast({ title: `${def.name} is in ${shortFile(def.file)} now`, sub: 'Edit it here like any agent.' })
      go({ name: 'agent', roomId, agentId: def.id })
    } catch (e) { setError(cleanError(e)) }
  })

  return (
    <div className="panel">
      <header className="header">
        <SidebarToggle />
        <button type="button" className="tm-crumb" onClick={() => void openRoom(roomId)}>{room.name}</button><span className="tm-sep">/</span>
        <button type="button" className="tm-crumb" onClick={() => go({ name: 'team', roomId })}>Team</button><span className="tm-sep">/</span>
        <h1>{agent.name}</h1>
        <span className="grow" />
        {error && <span role="alert" className="ap-save-note del">{error}</span>}
        {builtIn ? (
          <Button variant="primary" busy={saving === 'customize'} busyLabel="Copying" onClick={() => void customize()}>Customize</Button>
        ) : (
          <>
            {saved && !dirty && <span role="status" className="ap-save-note">Saved to {shortFile(agent.file)}</span>}
            <Button variant="ghost" disabled={agent.lead || !!saving} title={agent.lead ? `${agent.name} leads this room. Pick another Lead in Settings, Agents first.` : undefined} onClick={retire}>Retire</Button>
            <Button variant={dirty ? 'primary' : 'secondary'} busy={saving === 'save'} busyLabel="Saving" disabled={!dirty || !form.description.trim() || !!saving} onClick={() => void save()}>Save changes</Button>
          </>
        )}
      </header>
      <div className="ap-body">
        <aside className="ap-side" aria-label={agent.name}>
          <div className="ap-id">
            <span className="tm-av lg" aria-hidden="true" style={{ background: shirtOf(agent, team, room) }}>{agent.name[0]}</span>
            <div className="tm-text"><span className="tm-name">{agent.name}</span><span className="muted">{agent.role}</span></div>
          </div>
          <dl className="ap-facts">
            <dt>Status</dt><dd>{STATUS_WORD[status]}</dd>
            <dt>Workspace</dt>
            <dd>{ws && ws.mode !== 'current' ? <button type="button" className="ap-link" onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>{ws.name}</button> : <span className="tm-mono">{ws ? 'main checkout' : 'none'}</span>}</dd>
            <dt>File</dt><dd className={builtIn ? 'tm-ink3' : 'tm-mono tm-ink3'}>{fileLabel(agent)}</dd>
            <dt>Rooms</dt><dd className="ink2">{inRooms.map((r) => r.name).join(', ') || room.name}</dd>
          </dl>
          {!!recent.length && (
            <div className="ap-recent">
              <h2>Recent work</h2>
              {recent.map((r) => {
                const body = <><span>{r.title}</span><span>{r.meta}</span></>
                return r.workspaceId
                  ? <button key={r.id} type="button" className="ap-card" onClick={() => go({ name: 'workspace', workspaceId: r.workspaceId! })}>{body}</button>
                  : <div key={r.id} className="ap-card">{body}</div>
              })}
            </div>
          )}
        </aside>
        <div className="ap-main">
          <form className="ap-form" onSubmit={(e) => { e.preventDefault(); if (dirty && !builtIn) void save() }}>
            <AgentFields agent={agent} form={form} set={set} skillNames={skillNames} />
          </form>
        </div>
      </div>
    </div>
  )
}
