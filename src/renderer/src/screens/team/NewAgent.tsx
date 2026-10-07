import { useState } from 'react'
import type { AgentDraft, NewAgentPrefill } from '@shared/types'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { Button, Modal, Pill, SegmentedControl } from '../../ui'
import { seating } from '../../floor/layout'
import { shirtOf, shortFile } from './model'
import './team.css'

type Step = 'describe' | 'draft' | 'done'

const PRESETS: { label: string; description: string }[] = [
  { label: 'Designer', description: 'A designer who checks every screen against DESIGN.md before review.' },
  { label: 'Security reviewer', description: 'A security reviewer who checks auth, tenant isolation and secrets in every diff.' },
  { label: 'Docs writer', description: 'A docs writer who keeps the README and docs in step with every merged change.' },
  { label: 'Data engineer', description: 'A data engineer who writes schema changes and migrations and checks them against real data.' }
]
const MODEL_CHOICES = [{ value: 'sonnet', label: 'Sonnet 5.5' }, { value: 'opus', label: 'Opus 5.5' }, { value: 'haiku', label: 'Haiku 4.5' }]
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * New agent in three steps (NewAgent.png, NewAgentDraft.png, NewAgentDone.png): describe it, review and edit the file Rowan drafted,
 * and see them join. The step is part of the modal route, the form lives here, so Back keeps what was typed.
 */
export function NewAgent({ roomId, step, prefill }: { roomId: string; step: Step; prefill?: NewAgentPrefill }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId])
  const [name, setName] = useState(prefill?.name ?? '')
  const [description, setDescription] = useState(prefill?.description ?? '')
  const [model, setModel] = useState(prefill?.model ?? 'sonnet')
  const [draft, setDraft] = useState<AgentDraft | undefined>(prefill?.draft)
  const [text, setText] = useState(prefill?.draft?.text ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = actions.ui.closeModal
  const lead = agents?.find((a) => a.lead)
  const to = (next: Step, p: NewAgentPrefill = { name, description, model, draft }) => actions.ui.openModal({ name: 'newAgent', roomId, step: next, prefill: p })

  const makeDraft = async () => {
    setBusy(true); setError(null)
    try {
      const d = await call('agents.draft', { roomId, description: description.trim(), name: name.trim() || undefined, model })
      setDraft(d); setText(d.text)
      to('draft', { name, description, model, draft: d })
    } catch (e) { setError(clean(e)) }
    setBusy(false)
  }

  const create = async () => {
    if (!draft) return
    setBusy(true); setError(null)
    try {
      const def = await call('agents.create', { roomId, draft: { ...draft, text } })
      actions.agents.set(roomId, [...(getState().agents[roomId] ?? []).filter((a) => a.id !== def.id), def])
      const done = { ...draft, id: def.id, name: def.name, file: def.file.includes('.claude/') ? `.claude/${def.file.split('.claude/')[1]}` : draft.file, text }
      setDraft(done)
      to('done', { name, description, model, draft: done })
    } catch (e) { setError(clean(e)) }
    setBusy(false)
  }

  // Hand the draft to Rowan to improve in his own chat. He proposes the final file with hire_agent, and it comes back as an approval card.
  const refine = async () => {
    if (!draft) return
    setBusy(true); setError(null)
    try {
      await call('lead.ask', { roomId, text: `I am adding a new agent. Here is the draft of ${draft.file}. Improve it with me, then propose the final file with hire_agent.\n\n${text}` })
      const home = getState().workspaces.find((w) => w.roomId === roomId && w.name === 'lead' && w.status !== 'archived')
      actions.ui.go(home ? { name: 'workspace', workspaceId: home.id } : { name: 'floor', roomId })
    } catch (e) { setError(clean(e)); setBusy(false) }
  }

  if (step === 'describe') {
    const ready = description.trim() !== ''
    return (
      <Modal
        title="New agent" onClose={close} width={600} top={122}
        footer={<><span className="grow">{error && <span role="alert" className="del">{error}</span>}</span><Button variant="ghost" size="lg" onClick={close}>Cancel</Button><Button variant="primary" size="lg" disabled={!ready || busy} onClick={() => void makeDraft()}>{busy ? 'Drafting' : `Draft with ${lead?.name ?? 'Rowan'}`}</Button></>}
      >
        <form className="na-body" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void makeDraft() }}>
          <p>Describe the agent. {lead?.name ?? 'Rowan'} writes the file in .claude/agents and you review it before it joins.</p>
          <textarea className="na-text" aria-label="What should this agent do?" placeholder="What should this agent do?" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="na-presets" role="group" aria-label="Start from a role">
            {PRESETS.map((p) => <Pill key={p.label} onClick={() => { setDescription(p.description); if (!name.trim()) setName(p.label) }}>{p.label}</Pill>)}
          </div>
          <div className="na-two">
            <label className="col" style={{ gap: 6 }}><span className="muted" style={{ fontSize: 12 }}>Name</span><input className="input" value={name} placeholder="Lumi" onChange={(e) => setName(e.target.value)} /></label>
            <div className="col" style={{ gap: 6 }}><span className="muted" style={{ fontSize: 12 }}>Model</span><SegmentedControl label="Model" value={model} onChange={setModel} options={MODEL_CHOICES} /></div>
          </div>
        </form>
      </Modal>
    )
  }

  if (!draft) return null

  if (step === 'draft') {
    const rowan = lead ?? agents?.[0]
    return (
      <Modal
        title={`Review ${draft.id}.md`} onClose={close} width={600} top={122}
        footer={<><span className="grow">{error && <span role="alert" className="del">{error}</span>}</span><Button variant="ghost" size="lg" onClick={() => to('describe', { name, description, model, draft })}>Back</Button><Button variant="primary" size="lg" disabled={busy || !text.trim()} onClick={() => void create()}>Create agent</Button></>}
      >
        <div className="na-body">
          <div className="na-by">
            <span className="tm-av" aria-hidden="true" style={{ background: rowan && agents ? shirtOf(rowan, agents, room) : undefined }}>{(rowan?.name ?? 'R')[0]}</span>
            <span><b style={{ fontWeight: 500 }}>{rowan?.name ?? 'Rowan'}</b> drafted the agent file</span>
          </div>
          <div className="na-file">
            <div className="na-file-head">{draft.file}<span className="na-tag">new file</span></div>
            <textarea className="na-code" aria-label={`Contents of ${draft.file}`} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
          </div>
          <button type="button" className="na-link" disabled={busy} onClick={() => void refine()}>Refine it in a chat with {rowan?.name ?? 'Rowan'}</button>
        </div>
      </Modal>
    )
  }

  const team = agents ?? []
  const seated = seating(team, room).seated.some((a) => a.id === draft.id)
  const joined = team.find((a) => a.id === draft.id)
  return (
    <Modal
      title="New agent" onClose={close} width={600} top={122}
      footer={<><span className="grow" /><Button variant="ghost" size="lg" onClick={close}>Close</Button><Button variant="primary" size="lg" onClick={() => actions.ui.go({ name: 'floor', roomId })}>See on the floor</Button></>}
    >
      <div className="na-done">
        <span className="tm-av xl" aria-hidden="true" style={{ background: joined ? shirtOf(joined, team, room) : undefined }}>{draft.name[0]}</span>
        <h3>{draft.name} is on the team</h3>
        <p>Saved to {shortFile(draft.file)}. {seated || !joined ? `${draft.name} takes the open desk on the floor and shows up in every new workspace picker.` : `${draft.name} waits by the wall until a desk frees up, and shows up in every new workspace picker.`}</p>
      </div>
    </Modal>
  )
}
