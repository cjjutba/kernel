import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentDef, AgentEdit, Effort, Role } from '@shared/types'
import { EFFORTS, MODELS } from '@shared/types'
import { roleOf } from '@shared/team'
import { roleSide } from '@shared/rolePick'
import { call } from '../../api'
import { useStore } from '../../store'
import { Icon, Pill, SegmentedControl } from '../../ui'
import { SettingsLink } from '../settings/kit'
import { defaultEffortOf } from '../workspace/composer/modelPrefs'
import { STANDARD_TOOLS, modelAlias, sameModel, warningText, withExtras } from './model'
import './agent.css'

export interface AgentForm { description: string; model: string; effort: Effort | undefined; tools: string[] | undefined; skills: string[]; prompt: string }

export const formOf = (a: AgentDef): AgentForm => ({ description: a.description, model: a.model ?? '', effort: a.effort, tools: a.tools, skills: a.skills ?? [], prompt: a.prompt })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const slash = (s: string) => (s.startsWith('/') ? s : `/${s}`)

/** What a save sends. An empty model clears the pin, so the agent follows its role's default in Settings again (KERNEL-406). */
export const editOf = (form: AgentForm): AgentEdit => ({
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
 * The fields of an agent file, shared by the profile and Settings, Agents: description, model, effort, tools, skills and instructions.
 * `builtIn` is Kernel as it ships, or Theo, shown as it runs (a customized Kernel has a file and edits like any agent), and `readOnly` is a plugin's agent. Both disable every field.
 */
export function AgentFields({ agent, form, set, skillNames, readOnly = false, noSkillsHint = 'No skills found in this project.' }: {
  agent: AgentDef; form: AgentForm; set: (patch: Partial<AgentForm>) => void; skillNames: string[]; readOnly?: boolean; noSkillsHint?: string
}) {
  const models = useStore((s) => s.settings?.models)
  const builtIn = !!agent.builtIn && !agent.file
  const locked = builtIn || readOnly
  const toolList = withExtras(STANDARD_TOOLS, agent.tools)
  const skillList = withExtras(skillNames, agent.skills?.map(slash))
  const pick = (list: string[] | undefined, item: string, order: string[]) => {
    const on = new Set(list ?? [])
    if (on.has(item)) on.delete(item); else on.add(item)
    return order.filter((x) => on.has(x))
  }
  // Kernel's own agents have no model of their own: Settings, Models picks it.
  const modelId = builtIn ? (models ? roleSide(agent.lead ? models.roles.lead : models.roles.reviewer).model : '') : MODELS.find((m) => sameModel(form.model, m.id))?.id ?? ''
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
        <ul className="ap-warns" aria-label="What Kernel noticed in this file">
          {agent.warnings.map((w) => <li key={w.kind}><Icon name="warning" size={14} />{warningText(w)}</li>)}
        </ul>
      )}
      <fieldset className="ap-fields" disabled={locked}>
        <div className="ap-field">
          <label className="ap-label" htmlFor="ap-desc">Description</label>
          <textarea id="ap-desc" className="ap-text" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          <span className="hint">Kernel reads this to decide what to hand {agent.name}.</span>
        </div>
        <div className="ap-two">
          <div className="ap-field">
            <span className="ap-label" id="ap-model">Model</span>
            <SegmentedControl label="Model" value={modelId} onChange={(id) => set({ model: modelAlias(id) })} options={['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'].map((id) => ({ value: id, label: MODELS.find((m) => m.id === id)?.label ?? id }))} />
            {builtIn ? <span className="hint">From <SettingsLink to={{ page: 'models' }}>Models and effort</SettingsLink></span> : <PinHint agent={agent} model={form.model} disabled={locked} onClear={() => set({ model: '' })} />}
          </div>
          <div className="ap-field">
            <span className="ap-label">Effort</span>
            <SegmentedControl label="Effort" value={effort} onChange={(v) => set({ effort: v as Effort })} options={EFFORTS.map((e) => ({ value: e.id, label: e.label }))} />
            {builtIn && <span className="hint">From <SettingsLink to={{ page: 'models' }}>Models and effort</SettingsLink></span>}
          </div>
        </div>
        <div className="ap-field">
          <span className="ap-label" id="ap-tools">Tools</span>
          <div className="ap-chips" role="group" aria-labelledby="ap-tools">
            {toolList.map((t) => <Pill key={t} pressed={!!form.tools?.includes(t)} onClick={() => set({ tools: pick(form.tools, t, toolList) })}>{t}</Pill>)}
          </div>
          {!form.tools && <span className="hint">{locked ? `${agent.name} can use every tool.` : `No tools line in the file, so ${agent.name} can use every tool. Pick some to limit them.`}</span>}
        </div>
        <div className="ap-field">
          <span className="ap-label" id="ap-skills">Skills</span>
          <div className="ap-chips" role="group" aria-labelledby="ap-skills">
            {skillList.map((t) => <Pill key={t} pressed={form.skills.map(slash).includes(t)} onClick={() => set({ skills: pick(form.skills.map(slash), t, skillList) })}>{t}</Pill>)}
            {!skillList.length && <span className="hint">{noSkillsHint}</span>}
          </div>
        </div>
        <div className="ap-field">
          <label className="ap-label" htmlFor="ap-prompt">Instructions</label>
          <textarea id="ap-prompt" className="ap-text mono" rows={12} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} spellCheck={false} />
        </div>
      </fieldset>
    </>
  )
}
