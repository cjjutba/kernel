import './agents.css'
import { COMPACT_WINDOWS, EFFORT_LABELS, type AgentDef, type AppSettings, type CompactWindow, type Provider, type Role, type RoleModel } from '@shared/types'
import { roleOf } from '@shared/team'
import { Select, Toggle } from '../../../ui'
import { effortsOf, fitEffort, modelLabelOf, useProviderModels } from '../../workspace/composer/providerModels'
import { appliesTo, Page, Row, Section } from '../kit'
import { go, useStore } from '../../../store'
import { patchSettings } from '../useSettings'

const ROLES: { key: Role; title: string }[] = [
  { key: 'lead', title: 'Kernel' },
  { key: 'frontend', title: 'Frontend' },
  // `engineers` is every engineer but a frontend one. The key kept its name so saved settings still read (KERNEL-974).
  { key: 'engineers', title: 'Backend' },
  { key: 'qa', title: 'QA' },
  { key: 'reviewer', title: 'Reviewer' }
]

const COMPACT_LABELS: Record<CompactWindow, string> = { '200k': '200k tokens', full: 'Full window' }
const LIMITS = [1, 2, 3, 4, 5, 6, 8]

const ROLE_GRID = 'minmax(0, 1fr) 196px 128px 128px'

/** The agents of every project that read a role's row, by project. Retired agents are left out. */
function useRoleAgents(roleKey: Role) {
  const projects = useStore((st) => st.projects)
  const agents = useStore((st) => st.agents)
  return projects
    .map((p) => ({ project: p, agents: (agents[p.id] ?? []).filter((a) => !a.retired && roleOf(a) === roleKey) }))
    .filter((g) => g.agents.length)
}

/** Who a row covers (KERNEL-974): an agent whose file sets its own model keeps it, and its name opens the profile. */
function RoleAgents({ roleKey, models }: { roleKey: Role; models: ReturnType<typeof useProviderModels> }) {
  const groups = useRoleAgents(roleKey)
  if (!groups.length) return <span className="ag-covers">No agents use this yet</span>
  const name = (projectId: string, a: AgentDef) =>
    a.file
      ? <button type="button" className="set-link" onClick={() => go({ name: 'settings', page: 'project', projectId, section: 'agents', agentId: a.id })}>{a.name}</button>
      : <span>{a.name}</span>
  return (
    <ul className="ag-covers" aria-label="Agents on this row">
      {groups.map(({ project, agents }) => (
        <li key={project.id}>
          {agents.map((a, i) => (
            <span key={a.id}>{i > 0 && ', '}{name(project.id, a)}{a.model && <span className="ag-pinned"> (uses {modelLabelOf(a.model, models)} from its file)</span>}</span>
          ))}
          {' in '}{project.name}
        </li>
      ))}
    </ul>
  )
}

/**
 * One role's row (KERNEL-406, KERNEL-680): the model picker is grouped by provider, so picking a model also picks the provider, and the
 * effort moves to one the model takes. Codex manages its own context, so its compact cell says Auto.
 */
function RoleLine({ title, roleKey, current, compact }: { title: string; roleKey: Role; current: RoleModel; compact: CompactWindow }) {
  const claude = useProviderModels('claude')
  const codex = useProviderModels('codex')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const save = (next: RoleModel) => void patchSettings({ models: { roles: { [roleKey]: next } } })
  const pick = (model: string) => {
    const provider: Provider = codex.some((m) => m.id === model) ? 'codex' : claude.some((m) => m.id === model) ? 'claude' : current.provider
    save({ provider, model, effort: fitEffort(current.effort, model, listOf(provider)) })
  }
  const group = (label: string, p: Provider) => {
    const ids = [...new Set([...listOf(p).map((m) => m.id), ...(current.provider === p ? [current.model] : [])])]
    return { label, options: ids.map((id) => ({ value: id, label: modelLabelOf(id, listOf(p)) })) }
  }
  const groups = [group('Claude Code', 'claude'), group('Codex', 'codex')].filter((g) => g.options.length)
  const efforts = [...new Set([...effortsOf(current.model, listOf(current.provider)), current.effort])]
  return (
    <div className="set-table-row" role="row" aria-label={title} style={{ gridTemplateColumns: ROLE_GRID }}>
      <span role="cell" className="ag-role-name"><span className="set-label">{title}</span><span className="set-desc">{current.provider === 'codex' ? 'Codex' : 'Claude Code'}</span><RoleAgents roleKey={roleKey} models={[...claude, ...codex]} /></span>
      <span role="cell"><Select label={`${title} model`} value={current.model} options={groups} onChange={pick} /></span>
      <span role="cell"><Select label={`${title} effort`} value={current.effort} options={efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))} onChange={(v) => save({ ...current, effort: v as RoleModel['effort'] })} /></span>
      <span role="cell">
        {current.provider === 'codex'
          ? <span className="ag-auto" title="Codex manages its own context">Auto</span>
          : <Select label={`${title} compact at`} value={compact} options={COMPACT_WINDOWS.map((w) => ({ value: w, label: COMPACT_LABELS[w] }))} onChange={(v) => void patchSettings({ models: { compact: { [roleKey]: v as CompactWindow } } })} />}
      </span>
    </div>
  )
}

function Roles({ s }: { s: AppSettings }) {
  return (
    <div className="set-card ag-roles" role="table" aria-label="Roles">
      <div className="set-table-head" role="row" style={{ gridTemplateColumns: ROLE_GRID }}>{['Role', 'Model', 'Effort', 'Compact at'].map((c) => <span key={c} role="columnheader">{c}</span>)}</div>
      {ROLES.map((r) => <RoleLine key={r.key} title={r.title} roleKey={r.key} current={s.models.roles[r.key]} compact={s.models.compact[r.key]} />)}
    </div>
  )
}

/** Settings > Models and effort (AgentsPage.dc.html, KERNEL-680). The agent limit is enforced by the engine with a queue. */
export function Models({ s }: { s: AppSettings }) {
  const m = s.models
  const limits = [...new Set([...LIMITS, m.agentLimit])].filter((n) => n > 0).sort((a, b) => a - b)
  return (
    <Page title="Models and effort">
      <Section title="Roles" plain label="Roles" footnote={appliesTo('models.roles')}>
        <Roles s={s} />
      </Section>
      <Section title="Planning">
        <Row id="lead-plan-mode" setting="models.leadPlanMode" label="Kernel starts in plan mode"><Toggle label="Kernel starts in plan mode" checked={m.leadPlanMode} onChange={(v) => void patchSettings({ models: { leadPlanMode: v } })} /></Row>
        <Row id="workspace-plan-mode" setting="models.workspacePlanMode" label="New workspaces start in plan mode" desc="Kernel’s hand-offs skip it, since Kernel already planned."><Toggle label="New workspaces start in plan mode" checked={m.workspacePlanMode} onChange={(v) => void patchSettings({ models: { workspacePlanMode: v } })} /></Row>
      </Section>
      <Section title="Teamwork">
        <Row id="agent-limit" label="Agents working at once" desc="More agents use more of your limits. Chats with Kernel don’t count.">
          <Select label="Agents working at once" value={String(m.agentLimit)} options={[...limits.map((n) => ({ value: String(n), label: String(n) })), { value: '0', label: 'No limit' }]} onChange={(v) => void patchSettings({ models: { agentLimit: Number(v) } })} />
        </Row>
        <Row id="lead-updates" label="Keep Kernel updated" desc="Tells Kernel about failed checks, reviews and questions."><Toggle label="Keep Kernel updated" checked={m.leadUpdates} onChange={(v) => void patchSettings({ models: { leadUpdates: v } })} /></Row>
        <Row id="agent-teams" setting="models.agentTeams" label={<>Agent teams <span className="set-badge">Experimental</span></>} desc="Kernel coordinates teammates through a shared task list."><Toggle label="Agent teams" checked={m.agentTeams} onChange={(v) => void patchSettings({ models: { agentTeams: v } })} /></Row>
        {m.agentTeams && (
          <>
            <Row child label="Send back tasks without test output" desc="A task marked done before any test ran goes back once."><Toggle label="Send back tasks without test output" checked={s.hooks.requireTestOutput} onChange={(v) => void patchSettings({ hooks: { requireTestOutput: v } })} /></Row>
            <Row child label="Keep idle teammates working" desc="An idle teammate picks up an open task."><Toggle label="Keep idle teammates working" checked={s.hooks.keepTeammatesWorking} onChange={(v) => void patchSettings({ hooks: { keepTeammatesWorking: v } })} /></Row>
          </>
        )}
      </Section>
    </Page>
  )
}
