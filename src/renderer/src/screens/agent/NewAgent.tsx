import { useEffect, useRef, useState } from 'react'
import type { AgentDraft, Effort, NewAgentPrefill } from '@shared/types'
import { MODELS } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { openLeadChat } from '../../lead'
import { AgentAvatar, Button, CodeLines, LinkButton, Modal, Pill, useBusy } from '../../ui'
import { openNewProject } from '../projects/draft'
import { ModelField } from '../workspace/composer/ModelField'
import { defaultEffortOf } from '../workspace/composer/modelPrefs'
import { AgentFile } from './AgentFile'
import { ModelTag } from './ModelTag'
import { modelAlias, sameModel } from './model'
import './agent.css'

type Step = 'describe' | 'draft' | 'done'

const PRESETS: { label: string; description: string }[] = [
  { label: 'Designer', description: 'A designer who checks every screen against DESIGN.md before review.' },
  { label: 'Security reviewer', description: 'A security reviewer who checks auth, tenant isolation and secrets in every diff.' },
  { label: 'Docs writer', description: 'A docs writer who keeps the README and docs in step with every merged change.' },
  { label: 'Data engineer', description: 'A data engineer who writes schema changes and migrations and checks them against real data.' }
]

/**
 * New agent in three steps (NewAgent.png, NewAgentDraft.png, NewAgentDone.png): describe it, review and edit the file Kernel drafted,
 * and see them join. The step is part of the modal route, the form lives here, so Back keeps what was typed. With no project at all (and
 * outside onboarding, whose team step has none either) the first step asks for a project, since an agent lives in a repo's .claude/agents
 * (NewAgentNoProject.png). While Kernel drafts, the first step shows what was written and nothing to change (NewAgentDrafting.png).
 * With no `projectId` (Settings, Agents before any project exists) the agent is personal: it saves to ~/.claude/agents and there is no project to refine it in.
 */
export function NewAgent({ projectId, step, prefill }: { projectId?: string; step: Step; prefill?: NewAgentPrefill }) {
  const noProjects = useStore((s) => !s.projects.some((r) => !r.hidden && !r.archived) && s.ui.route.name !== 'onboarding')
  const agents = useStore((s) => (projectId ? s.agents[projectId] : undefined))
  const [name, setName] = useState(prefill?.name ?? '')
  const [description, setDescription] = useState(prefill?.description ?? '')
  const [model, setModel] = useState(prefill?.model ?? 'sonnet')
  const settingsModels = useStore((s) => s.settings?.models)
  const [effort, setEffort] = useState<Effort | undefined>()
  const modelId = MODELS.find((m) => sameModel(model, m.id))?.id ?? ''
  const [draft, setDraft] = useState<AgentDraft | undefined>(prefill?.draft)
  const [text, setText] = useState(prefill?.draft?.text ?? '')
  const [busy, run] = useBusy<'draft' | 'create' | 'refine'>()
  const [error, setError] = useState<string | null>(null)
  const gone = useRef(false)
  useEffect(() => { gone.current = false; return () => { gone.current = true } }, [])
  const close = () => { gone.current = true; actions.ui.closeModal() }
  // Done with no project goes back to Settings, Agents, where the new agent shows under Yours.
  const finish = () => { actions.ui.closeModal(); if (!projectId && getState().ui.route.name !== 'onboarding') actions.ui.go({ name: 'settings', page: 'agents' }) }
  const lead = agents?.find((a) => a.lead)
  const to = (next: Step, p: NewAgentPrefill = { name, description, model, draft }) => actions.ui.openModal({ name: 'newAgent', projectId, step: next, prefill: p })

  const makeDraft = () => run('draft', async () => {
    setError(null)
    try {
      const d = await call('agents.draft', { ...(projectId ? { projectId } : {}), description: description.trim(), name: name.trim() || undefined, model })
      if (gone.current) return
      setDraft(d); setText(d.text)
      to('draft', { name, description, model, draft: d })
    } catch (e) { setError(cleanError(e)) }
  })

  const create = () => draft && run('create', async () => {
    setError(null)
    try {
      const def = await call('agents.create', projectId ? { projectId, draft: { ...draft, text } } : { draft: { ...draft, text }, scope: 'me' })
      if (projectId) actions.agents.set(projectId, [...(getState().agents[projectId] ?? []).filter((a) => a.id !== def.id), def])
      const done = { ...draft, id: def.id, name: def.name, file: def.file.includes('.claude/') ? `.claude/${def.file.split('.claude/')[1]}` : draft.file, text }
      if (gone.current) return
      setDraft(done)
      to('done', { name, description, model, draft: done })
    } catch (e) { setError(cleanError(e)) }
  })

  // Hand the draft to Kernel to improve in a chat. It proposes the final file with create_agent, and it comes back as an approval card.
  const refine = () => draft && projectId && run('refine', async () => {
    setError(null)
    try {
      // A new Lead chat, which opens before its worktree exists (KERNEL-542). The brief is a plain one, not a plan.
      const chat = await call('lead.start', { projectId, prompt: `I am adding a new agent. Here is the draft of ${draft.file}. Improve it with me, then propose the final file with create_agent.\n\n${text}`, plan: false })
      actions.chats.upsert(chat)
      await openLeadChat(projectId, chat.id)
    } catch (e) { setError(cleanError(e)) }
  })

  if (step === 'describe' && !projectId && noProjects) {
    return (
      <Modal
        title="New agent" onClose={close} width={600} top={122}
        footer={<><span className="grow" /><Button variant="ghost" size="lg" onClick={close}>Cancel</Button><Button variant="primary" size="lg" onClick={() => openNewProject()}>Add a project</Button></>}
      >
        <div className="na-body"><p>An agent lives in a project{'’'}s .claude/agents folder, so Kernel needs a project first.</p></div>
      </Modal>
    )
  }

  if (step === 'describe') {
    const ready = description.trim() !== ''
    const drafting = busy === 'draft'
    const author = lead?.name ?? 'Kernel'
    return (
      <Modal
        title="New agent" onClose={close} width={600} top={122}
        footer={<><span className="grow">{error && <span role="alert" className="del">{error}</span>}</span><Button variant="ghost" size="lg" onClick={close}>Cancel</Button><Button variant="primary" size="lg" busy={drafting} busyLabel="Drafting" disabled={!ready} onClick={() => void makeDraft()}>{`Draft with ${author}`}</Button></>}
      >
        {drafting ? (
          <div className="na-body">
            <p>{author} writes the file in .claude/agents and you review it before it joins.</p>
            <div className="na-sent" role="status" aria-label="What you asked for">{description}</div>
            <span className="na-start">Start from a role</span>
          </div>
        ) : (
          <form className="na-body" onSubmit={(e) => { e.preventDefault(); if (ready) void makeDraft() }}>
            <p>Describe the agent. {author} writes the file in .claude/agents and you review it before it joins.</p>
            <textarea className="na-text" aria-label="What should this agent do?" placeholder="What should this agent do?" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="na-presets" role="group" aria-label="Start from a role">
              {PRESETS.map((p) => <Pill key={p.label} onClick={() => { setDescription(p.description); if (!name.trim()) setName(p.label) }}>{p.label}</Pill>)}
            </div>
            <div className="na-two">
              <label className="col na-field"><span className="muted na-label">Name</span><input className="input" value={name} placeholder="Wren" onChange={(e) => setName(e.target.value)} /></label>
              <div className="col na-field"><span className="muted na-label">Model</span><ModelField label="Model" only="claude" model={modelId} effort={effort ?? defaultEffortOf(undefined, settingsModels)} onChange={(id, e) => { setModel(modelAlias(id)); setEffort(e) }} onEffort={setEffort} /></div>
            </div>
          </form>
        )}
      </Modal>
    )
  }

  if (!draft) return null

  if (step === 'draft') {
    const author = lead?.name ?? 'Kernel'
    return (
      <Modal
        title={`Review ${draft.name}`} onClose={close} width={600} top={122}
        footer={<><Button variant="ghost" size="lg" icon="left" disabled={busy !== null} onClick={() => to('describe', { name, description, model, draft })}>Back</Button><span className="grow">{error && <span role="alert" className="del">{error}</span>}</span><Button variant="ghost" size="lg" onClick={close}>Cancel</Button><Button variant="primary" size="lg" busy={busy === 'create'} busyLabel="Adding" disabled={busy !== null || !text.trim()} onClick={() => void create()}>{`Add ${draft.name}`}</Button></>}
      >
        <div className="na-body">
          <p>{author} drafted the agent{'’'}s file. Edit anything here, then add {draft.name} to the team.</p>
          <div className="na-file">
            <div className="na-file-head"><AgentFile file={draft.file} /><span className="na-by">Drafted by {author}</span></div>
            <CodeLines value={text} onChange={setText} label={`Contents of ${draft.file}`} minLines={14} maxLines={14} />
          </div>
          {projectId && <LinkButton size="ui" className="na-link" disabled={busy !== null} busy={busy === 'refine'} busyLabel={`Sending to ${author}`} busyPattern="ripple" onClick={() => void refine()}>{`Refine it in a chat with ${author}`}</LinkButton>}
        </div>
      </Modal>
    )
  }

  const team = agents ?? []
  const joined = team.find((a) => a.id === draft.id)
  const author = lead?.name ?? 'Kernel'
  return (
    <Modal
      title={`${draft.name} joined the team`} onClose={close} width={600} top={122}
      footer={<><span className="grow" /><Button variant="primary" size="lg" onClick={finish}>Close</Button></>}
    >
      <div className="na-body">
        <p>Pick {draft.name} in the composer, or let {author} hand {draft.name} a task when it plans.</p>
        <div className="na-joined">
          <AgentAvatar name={draft.name} size={24} />
          <span className="na-joined-who">
            <span className="na-joined-name">{draft.name}{joined?.role && <span className="na-joined-role">{joined.role}</span>}</span>
            <AgentFile file={draft.file} plain />
          </span>
          <ModelTag agent={{ name: draft.name, model: joined?.model ?? model, effort: joined?.effort ?? effort ?? defaultEffortOf(undefined, settingsModels), provider: joined?.provider }} />
        </div>
      </div>
    </Modal>
  )
}
