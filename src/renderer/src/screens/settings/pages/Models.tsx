import './agents.css'
import { COMPACT_WINDOWS, EFFORT_LABELS, type AppSettings, type CompactWindow, type Provider, type Role, type RoleModel } from '@shared/types'
import { IconButton, Select, Toggle } from '../../../ui'
import { effortsOf, fitEffort, modelLabelOf, useProviderModels } from '../../workspace/composer/providerModels'
import { appliesTo, Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

const ROLES: { key: Role; title: string }[] = [
  { key: 'lead', title: 'Lead' },
  { key: 'engineers', title: 'Frontend and Backend' },
  { key: 'qa', title: 'QA' },
  { key: 'reviewer', title: 'Reviewer' }
]

const COMPACT_LABELS: Record<CompactWindow, string> = { '200k': '200k tokens', full: 'Full window' }
const PIN_NOTE = 'An agent file with its own model line keeps that model. Its profile shows the pin.'
const LIMITS = [1, 2, 3, 4, 5, 6, 8]

const ROLE_GRID = 'minmax(0, 1fr) 196px 128px 128px'

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
      <span role="cell" className="ag-role-name"><span className="set-label">{title}</span><span className="set-desc">{current.provider === 'codex' ? 'Codex' : 'Claude Code'}</span></span>
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
      <Section title="Roles" note={<IconButton icon="info" size={14} label="About pinned models" className="ag-info" data-tip={PIN_NOTE} />} plain label="Roles" footnote={appliesTo('models.roles')}>
        <Roles s={s} />
      </Section>
      <Section title="Planning">
        <Row setting="models.leadPlanMode" label="Lead starts in plan mode"><Toggle label="Lead starts in plan mode" checked={m.leadPlanMode} onChange={(v) => void patchSettings({ models: { leadPlanMode: v } })} /></Row>
        <Row setting="models.workspacePlanMode" label="New workspaces start in plan mode" desc="The Lead’s hand-offs skip it, since the Lead already planned."><Toggle label="New workspaces start in plan mode" checked={m.workspacePlanMode} onChange={(v) => void patchSettings({ models: { workspacePlanMode: v } })} /></Row>
      </Section>
      <Section title="Teamwork">
        <Row label="Agents working at once" desc="More agents use more of your limits. Lead chats don’t count.">
          <Select label="Agents working at once" value={String(m.agentLimit)} options={[...limits.map((n) => ({ value: String(n), label: String(n) })), { value: '0', label: 'No limit' }]} onChange={(v) => void patchSettings({ models: { agentLimit: Number(v) } })} />
        </Row>
        <Row label="Keep the Lead updated" desc="Tells the Lead about failed checks, reviews and questions."><Toggle label="Keep the Lead updated" checked={m.leadUpdates} onChange={(v) => void patchSettings({ models: { leadUpdates: v } })} /></Row>
        <Row setting="models.agentTeams" label={<>Agent teams <span className="set-badge">Experimental</span></>} desc="The Lead coordinates teammates through a shared task list."><Toggle label="Agent teams" checked={m.agentTeams} onChange={(v) => void patchSettings({ models: { agentTeams: v } })} /></Row>
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
