import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, AgentEdit, Effort } from '@shared/types'
import { EFFORTS, MODELS } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadRoom, useStore } from '../../store'
import { Button, SegmentedControl, useBusy } from '../../ui'
import { STANDARD_TOOLS, STATUS_WORD, currentWorkspace, modelAlias, recentWork, sameModel, shirtOf, shortFile, withExtras } from '../team/model'
import '../team/team.css'
import { SidebarToggle } from '../../components/PanelToggles'

const NO_AGENTS: AgentDef[] = []

interface Form { description: string; model: string; effort: Effort | undefined; tools: string[] | undefined; skills: string[]; prompt: string }

const formOf = (a: AgentDef): Form => ({ description: a.description, model: a.model ?? '', effort: a.effort, tools: a.tools, skills: a.skills ?? [], prompt: a.prompt })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const slash = (s: string) => (s.startsWith('/') ? s : `/${s}`)

/** AgentProfile.png: who the agent is and what they have been doing on the left, the editable file on the right. Save rewrites the agent file. */
export function AgentProfile({ roomId, agentId }: { roomId: string; agentId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId] ?? NO_AGENTS)
  const allAgents = useStore((s) => s.agents)
  const rooms = useStore((s) => s.rooms)
  const status = useStore((s) => s.status[roomId]?.[agentId] ?? 'idle')
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks[roomId])
  const defaultEffort = useStore((s) => s.settings?.models.effort)
  const agent = agents.find((a) => a.id === agentId && !a.retired)
  useEffect(() => { void loadRoom(roomId) }, [roomId])

  const [form, setForm] = useState<Form | null>(agent ? formOf(agent) : null)
  const [saving, run] = useBusy()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skillNames, setSkillNames] = useState<string[]>([])
  // Take the file's new values when it changes on disk, unless there are edits in the form that would be lost.
  const base = useRef<Form | null>(agent ? formOf(agent) : null)
  useEffect(() => {
    if (!agent) return
    const next = formOf(agent)
    if (!form || (base.current && same(form, base.current))) setForm(next)
    base.current = next
  }, [agent]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void call('skills.list', { roomId }).then((l) => setSkillNames(l.map((s) => slash(s.name)))).catch(() => undefined) }, [roomId])

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

  const dirty = !same(form, formOf(agent))
  const set = (patch: Partial<Form>) => { setSaved(false); setForm({ ...form, ...patch }) }
  const toolList = withExtras(STANDARD_TOOLS, agent.tools)
  const skillList = withExtras(skillNames, agent.skills?.map(slash))
  const pick = (list: string[] | undefined, item: string, order: string[]) => {
    const on = new Set(list ?? [])
    if (on.has(item)) on.delete(item); else on.add(item)
    return order.filter((x) => on.has(x))
  }
  const ws = currentWorkspace(agent.id, roomId, workspaces)
  const recent = recentWork(agent.id, tasks ?? [], workspaces)
  const team = agents.filter((a) => !a.retired)
  const modelId = MODELS.find((m) => sameModel(form.model, m.id))?.id ?? ''
  const effort = form.effort ?? defaultEffort ?? 'high'

  const save = () => run('save', async () => {
    setError(null)
    const patch: AgentEdit = {
      description: form.description.trim(), model: form.model || undefined, effort: form.effort, tools: form.tools, skills: form.skills.map(slash), prompt: form.prompt
    }
    try {
      const def = await call('agents.save', { roomId, agentId: agent.id, patch })
      actions.agents.set(roomId, agents.map((a) => (a.id === def.id ? { ...a, ...def } : a)))
      base.current = formOf(def)
      setForm(formOf(def))
      setSaved(true)
    } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  })
  const retire = () => actions.ui.openModal({ name: 'confirm', kind: 'retire', roomId, agentId: agent.id })

  return (
    <div className="panel">
      <header className="header">
        <SidebarToggle />
        <button type="button" className="tm-crumb" onClick={() => go({ name: 'floor', roomId })}>{room.name}</button><span className="tm-sep">/</span>
        <button type="button" className="tm-crumb" onClick={() => go({ name: 'team', roomId })}>Team</button><span className="tm-sep">/</span>
        <h1>{agent.name}</h1>
        <span className="grow" />
        {error && <span role="alert" className="ap-save-note del">{error}</span>}
        {saved && !dirty && <span role="status" className="ap-save-note">Saved to {shortFile(agent.file)}</span>}
        <Button variant="ghost" disabled={agent.lead} title={agent.lead ? `${agent.name} leads this room. Mark another agent as the Lead first.` : undefined} onClick={retire}>Retire</Button>
        <Button variant={dirty ? 'primary' : 'secondary'} busy={!!saving} busyLabel="Saving" disabled={!dirty || !form.description.trim()} onClick={() => void save()}>Save changes</Button>
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
            <dt>File</dt><dd className="tm-mono tm-ink3">{shortFile(agent.file)}</dd>
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
          <form className="ap-form" onSubmit={(e) => { e.preventDefault(); if (dirty) void save() }}>
            <div className="ap-field">
              <label className="ap-label" htmlFor="ap-desc">Description</label>
              <textarea id="ap-desc" className="ap-text" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
              <span className="hint">Rowan reads this to decide what to hand {agent.name}.</span>
            </div>
            <div className="ap-two">
              <div className="ap-field">
                <span className="ap-label" id="ap-model">Model</span>
                <SegmentedControl label="Model" value={modelId} onChange={(id) => set({ model: modelAlias(id) })} options={['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'].map((id) => ({ value: id, label: MODELS.find((m) => m.id === id)?.label ?? id }))} />
              </div>
              <div className="ap-field">
                <span className="ap-label">Effort</span>
                <SegmentedControl label="Effort" value={effort} onChange={(v) => set({ effort: v as Effort })} options={EFFORTS.map((e) => ({ value: e.id, label: e.label }))} />
              </div>
            </div>
            <div className="ap-field">
              <span className="ap-label" id="ap-tools">Tools</span>
              <div className="ap-chips" role="group" aria-labelledby="ap-tools">
                {toolList.map((t) => <button key={t} type="button" className="ap-chip" aria-pressed={!!form.tools?.includes(t)} onClick={() => set({ tools: pick(form.tools, t, toolList) })}>{t}</button>)}
              </div>
              {!form.tools && <span className="hint">No tools line in the file, so {agent.name} can use every tool. Pick some to limit them.</span>}
            </div>
            <div className="ap-field">
              <span className="ap-label" id="ap-skills">Skills</span>
              <div className="ap-chips" role="group" aria-labelledby="ap-skills">
                {skillList.map((t) => <button key={t} type="button" className="ap-chip" aria-pressed={form.skills.map(slash).includes(t)} onClick={() => set({ skills: pick(form.skills.map(slash), t, skillList) })}>{t}</button>)}
                {!skillList.length && <span className="hint">No skills found in this room.</span>}
              </div>
            </div>
            <div className="ap-field">
              <label className="ap-label" htmlFor="ap-prompt">Instructions</label>
              <textarea id="ap-prompt" className="ap-text mono" rows={12} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} spellCheck={false} />
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
