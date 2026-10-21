import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentDef, AgentEdit, Effort, Role } from '@shared/types'
import { MODELS } from '@shared/types'
import { roleOf } from '@shared/team'
import { roleSide } from '@shared/rolePick'
import { call } from '../../api'
import { useStore } from '../../store'
import { Button, Icon, Menu } from '../../ui'
import { ModelField } from '../workspace/composer/ModelField'
import { Row, SettingsLink } from '../settings/kit'
import { agentSource } from '../settings/pages/agentRows'
import { defaultEffortOf } from '../workspace/composer/modelPrefs'
import { STANDARD_TOOLS, modelAlias, sameModel, shortFile, warningText, withExtras } from './model'
import './agent.css'

export interface AgentForm { role: string; description: string; model: string; effort: Effort | undefined; tools: string[] | undefined; skills: string[]; prompt: string }

export const formOf = (a: AgentDef): AgentForm => ({ role: a.role, description: a.description, model: a.model ?? '', effort: a.effort, tools: a.tools, skills: a.skills ?? [], prompt: a.prompt })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const slash = (s: string) => (s.startsWith('/') ? s : `/${s}`)

/**
 * What a save sends. An empty model clears the pin, so the agent follows its role's default in Settings again (KERNEL-406). The role goes only when it changed, since the
 * one the agent shows can come from its name and a file that never wrote one would start with it.
 */
export const editOf = (form: AgentForm, base?: AgentDef): AgentEdit => ({
  ...(!base || form.role.trim() !== base.role ? { role: form.role.trim() } : {}),
  description: form.description.trim(), model: form.model, effort: form.effort, tools: form.tools, skills: form.skills.map(slash), prompt: form.prompt
})

/**
 * The editable file of one agent: the form, whether it differs from the file, and whether it was just saved. It takes the file's new
 * values when it changes on disk, unless there are edits in the form that would be lost. `adopt` takes a saved agent as the new base.
 */
export function useAgentForm(agent: AgentDef | undefined) {
  const [form, setForm] = useState<AgentForm | null>(agent ? formOf(agent) : null)
  const [saved, setSaved] = useState(false)
  const base = useRef<AgentForm | null>(agent ? formOf(agent) : null)
  useEffect(() => {
    if (!agent) return
    const next = formOf(agent)
    if (!form || (base.current && same(form, base.current))) setForm(next)
    base.current = next
  }, [agent]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((patch: Partial<AgentForm>) => { setSaved(false); setForm((f) => f && { ...f, ...patch }) }, [])
  const adopt = useCallback((def: AgentDef) => { base.current = formOf(def); setForm(formOf(def)); setSaved(true) }, [])
  const dirty = !!agent && !!form && !same(form, formOf(agent))
  return { form, set, saved, adopt, dirty }
}

/** The skills a project offers as slash names. Without a project, such as on Settings, Agents, the first project's list stands in. */
export function useSkillNames(projectId?: string): string[] {
  const firstProject = useStore((s) => s.projects.find((r) => !r.hidden && !r.archived)?.id)
  const id = projectId ?? firstProject
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    if (!id) { setNames([]); return }
    void call('skills.list', { projectId: id }).then((l) => setNames(l.map((s) => slash(s.name)))).catch(() => undefined)
  }, [id])
  return names
}

/** Settings, Models and effort's name for the role an agent takes its default from. */
const ROLE_TITLES: Record<Role, string> = { lead: 'Kernel', reviewer: 'Reviewer', qa: 'QA', frontend: 'Frontend', engineers: 'Backend' }
const roleTitle = (a: AgentDef) => ROLE_TITLES[roleOf(a)]

/**
 * Whether the agent follows Settings or its file pins a model (KERNEL-406), with Use Settings to clear the pin. Saved with
 * the rest of the profile.
 */
function PinHint({ agent, model, onClear, disabled }: { agent: AgentDef; model: string; onClear: () => void; disabled: boolean }) {
  if (!model || model === 'inherit') return <span className="hint">Uses Settings ({roleTitle(agent)} default)</span>
  const label = MODELS.find((m) => sameModel(model, m.id))?.label ?? model
  return <span className="hint">Pinned to {label}{agent.provider === 'codex' || !MODELS.some((m) => sameModel(model, m.id)) ? ' on Codex' : ''}.{!disabled && <> <button type="button" className="ap-unpin" onClick={onClear}>Use Settings</button></>}</span>
}

/**
 * A list of what an agent may use, as tags with × and an Add button that opens the choices left (Tools, Skills; Pen 15.9). `options` are the choices, and a value the agent has that is not one of them is kept as a tag.
 */
function PickList({ label, noun, value, options, onChange, disabled, hint }: { label: string; noun: string; value: string[]; options: string[]; onChange: (next: string[]) => void; disabled?: boolean; hint?: string }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const left = options.filter((o) => !value.includes(o))
  const close = () => { setOpen(false); button.current?.focus() }
  return (
    <div className="set-tags" role="list" aria-label={label}>
      {value.map((t) => (
        <span key={t} role="listitem" className="set-tag">
          <span className="set-tag-text mono" title={t}>{t}</span>
          <button type="button" className="set-tag-x" aria-label={`Remove ${t}`} disabled={disabled} onClick={() => onChange(value.filter((v) => v !== t))}><Icon name="close" size={12} /></button>
        </span>
      ))}
      {left.length > 0 && (
        <span ref={anchor} className="ae-add">
          <button ref={button} type="button" className="set-tag-add" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><Icon name="plus" size={12} />Add {noun}</button>
          {open && <Menu label={`Add ${noun}`} anchorRef={anchor} onClose={close} style={{ left: 0, top: 30, width: 220, maxHeight: 280, overflowY: 'auto' }} items={left.map((o) => ({ id: o, label: o, onSelect: () => { setOpen(false); onChange([...value, o]) } }))} />}
        </span>
      )}
      {hint && !value.length && <span className="set-desc">{hint}</span>}
    </div>
  )
}

/**
 * The fields of an agent file, as the rows of one card (Pen 15.9): name, role, description, model and effort, tools and skills, then the instructions under it. `builtIn` is Kernel as it ships, or Theo,
 * shown as it runs (a customized Kernel has a file and edits like any agent), and `readOnly` is a plugin's agent. Both disable every field. The name is the file's, so it shows and doesn't change.
 */
export function AgentFields({ agent, form, set, skillNames, readOnly = false, noSkillsHint = 'No skills found in this project.' }: {
  agent: AgentDef; form: AgentForm; set: (patch: Partial<AgentForm>) => void; skillNames: string[]; readOnly?: boolean; noSkillsHint?: string
}) {
  const models = useStore((s) => s.settings?.models)
  const builtIn = !!agent.builtIn && !agent.file
  const locked = builtIn || readOnly
  const toolList = withExtras(STANDARD_TOOLS, agent.tools)
  const skillList = withExtras(skillNames, agent.skills?.map(slash))
  // Kernel's own agents have no model of their own: Settings, Models picks it.
  const modelId = builtIn ? (models ? roleSide(agent.lead ? models.roles.lead : models.roles.reviewer).model : '') : agent.provider === 'codex' ? form.model : MODELS.find((m) => sameModel(form.model, m.id))?.id ?? ''
  const effort = form.effort ?? defaultEffortOf(agent, models)
  return (
    <>
      {builtIn && (
        <p className="ap-note" role="note">
          {agent.lead
            ? <>Kernel leads every project and plans with you. It isn{'’'}t a file in this repo, so it can{'’'}t be edited here. Customize copies it to <span className="mono">.claude/agents/kernel.md</span>, where you can change it like any agent.</>
            : <>{agent.name} is built into Kernel and reviews for this project because <span className="mono">.claude/agents</span> has no reviewer. It isn{'’'}t a file in this repo, so it can{'’'}t be edited here. Customize copies it to <span className="mono">.claude/agents/theo.md</span>, where you can change it like any agent.</>}
        </p>
      )}
      {!locked && !!agent.warnings?.length && (
        <section className="ap-notices" aria-labelledby="ap-notices-title">
          <h3 id="ap-notices-title">What Kernel noticed in this file</h3>
          <ul className="ap-warns">
            {agent.warnings.map((w) => <li key={w.kind}><Icon name="alertCircle" size={14} />{warningText(w)}</li>)}
          </ul>
          {!readOnly && !!form.model && agent.warnings.some((w) => w.kind === 'model-unavailable' || w.kind === 'model-unknown') && <Button size="sm" onClick={() => set({ model: '' })}>Use Settings</Button>}
        </section>
      )}
      <fieldset className="ap-fields" disabled={locked}>
        <div className="set-card ae-card">
          <Row label={<label htmlFor="ap-name">Name</label>} desc="Set by the file's name, so renaming the file renames the agent.">
            <input id="ap-name" className="ae-input" value={agent.name} readOnly disabled />
          </Row>
          <Row label={<label htmlFor="ap-role">Role</label>} desc="Shown next to the name in chats and the sidebar.">
            <input id="ap-role" className="ae-input" value={form.role} onChange={(e) => set({ role: e.target.value })} spellCheck={false} />
          </Row>
          <Row label={<label htmlFor="ap-desc">Description</label>} desc="When Kernel hands this agent a task. Kernel needs it to pick who works.">
            <textarea id="ap-desc" className="ae-input ae-area" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </Row>
          <Row label="Model and effort" desc={<>What {agent.name} runs on unless a chat changes it.{builtIn ? <> <SettingsLink to={{ page: 'models' }}>Models and effort</SettingsLink></> : <> <PinHint agent={agent} model={form.model} disabled={locked} onClear={() => set({ model: '' })} /></>}</>}>
            <span className="ae-model">
              <ModelField label="Model and effort" provider={agent.provider === 'codex' ? 'codex' : 'claude'} disabled={locked} model={modelId} effort={effort} onChange={(id, e) => set({ model: agent.provider === 'codex' ? id : modelAlias(id), effort: e })} onEffort={(e) => set({ effort: e })} />
            </span>
          </Row>
          <Row label="Tools" desc={form.tools ? `Off for Edit and Write makes ${agent.name} read-only, like a reviewer.` : `${agent.name} can use every tool. Take one off to limit them.`}
            full={<PickList label="Tools" noun="tool" value={form.tools ?? toolList} options={toolList} disabled={locked} onChange={(next) => set({ tools: next })} />} />
          <Row label="Skills" desc={`Skills ${agent.name} can use in this project.`}
            full={<PickList label="Skills" noun="skill" value={form.skills.map(slash)} options={skillList} disabled={locked} onChange={(next) => set({ skills: next })} hint={skillList.length ? undefined : noSkillsHint} />} />
        </div>
        <div className="ap-field">
          <label className="ap-label" htmlFor="ap-prompt">Instructions</label>
          <textarea id="ap-prompt" className="ap-text mono" rows={12} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} spellCheck={false} />
          <span className="hint">Markdown.{agent.file ? ` Saved to ${agent.origin === 'personal' ? agentSource(agent) : `${shortFile(agent.file)} in this project`}.` : ''}</span>
        </div>
      </fieldset>
    </>
  )
}
