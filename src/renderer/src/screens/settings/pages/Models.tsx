import { COMPACT_WINDOWS, EFFORT_LABELS, PROVIDERS, type AppSettings, type CompactWindow, type Provider, type Role, type RoleModel } from '@shared/types'
import { Select, Toggle } from '../../../ui'
import { effortsOf, fitEffort, modelLabelOf, useProviderModels } from '../../workspace/composer/providerModels'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

const ROLES: { key: Role; title: string }[] = [
  { key: 'lead', title: 'Lead' },
  { key: 'engineers', title: 'Frontend and Backend' },
  { key: 'qa', title: 'QA' },
  { key: 'reviewer', title: 'Reviewer' }
]

/**
 * One role's provider, model and effort (KERNEL-406). Switching provider moves to that provider's default model, and the
 * effort to one the model takes. Codex shows once its models are read.
 */
function RoleModels({ title, roleKey, current }: { title: string; roleKey: Role; current: RoleModel }) {
  const claude = useProviderModels('claude')
  const codex = useProviderModels('codex')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const models = listOf(current.provider)
  const save = (next: RoleModel) => void patchSettings({ models: { roles: { [roleKey]: next } } })
  const pickProvider = (p: Provider) => {
    const list = listOf(p)
    const model = (list.find((m) => m.isDefault) ?? list[0])?.id
    if (model) save({ provider: p, model, effort: fitEffort(current.effort, model, list) })
  }
  const modelOptions = [...new Set([...models.map((m) => m.id), current.model])].map((id) => ({ value: id, label: modelLabelOf(id, models) }))
  const efforts = [...new Set([...effortsOf(current.model, models), current.effort])]
  return (
    <Row label={title} className="set-role">
      <span className="set-actions">
        <Select label={`${title} provider`} value={current.provider} options={PROVIDERS.filter((p) => p.id === current.provider || listOf(p.id).length).map((p) => ({ value: p.id, label: p.label }))} onChange={(e) => pickProvider(e.target.value as Provider)} />
        <Select label={`${title} model`} value={current.model} options={modelOptions} onChange={(e) => save({ ...current, model: e.target.value, effort: fitEffort(current.effort, e.target.value, models) })} />
        <Select label={`${title} effort`} value={current.effort} options={efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))} onChange={(e) => save({ ...current, effort: e.target.value as RoleModel['effort'] })} />
      </span>
    </Row>
  )
}

const COMPACT_LABELS: Record<CompactWindow, string> = { '200k': '200k tokens', full: "Model's full window" }

/** Settings > Models and effort (SettingsModels.png). The agent limit is enforced by the engine with a queue. */
export function Models({ s }: { s: AppSettings }) {
  const m = s.models
  return (
    <Page title="Models and effort">
      <Section title="Default model by role" note="An agent file with its own model line keeps that model. Its profile shows the pin.">
        {ROLES.map((r) => <RoleModels key={r.key} title={r.title} roleKey={r.key} current={m.roles[r.key]} />)}
      </Section>
      <Section title="Compact window by role" note="A chat compacts when it reaches this size. It applies to Claude models. A chat already past it compacts on its next turn.">
        {ROLES.map((r) => {
          const codex = m.roles[r.key].provider === 'codex'
          return (
            <Row key={r.key} label={r.title} desc={codex ? 'Codex manages its own context.' : undefined}>
              <Select label={`${r.title} compact window`} value={m.compact[r.key]} disabled={codex} options={COMPACT_WINDOWS.map((w) => ({ value: w, label: COMPACT_LABELS[w] }))} onChange={(e) => void patchSettings({ models: { compact: { [r.key]: e.target.value as CompactWindow } } })} />
            </Row>
          )
        })}
      </Section>
      <Section title="Defaults">
        <Row label="Start the Lead in plan mode"><Toggle label="Start the Lead in plan mode" checked={m.leadPlanMode} onChange={(v) => void patchSettings({ models: { leadPlanMode: v } })} /></Row>
        <Row label="Start new workspaces in plan mode" desc="For workspaces you start from New workspace. The Lead's hand-offs start without it, because the Lead already planned."><Toggle label="Start new workspaces in plan mode" checked={m.workspacePlanMode} onChange={(v) => void patchSettings({ models: { workspacePlanMode: v } })} /></Row>
        <Row label="Keep the Lead updated" desc="Kernel tells the Lead when a teammate needs it: a failed check, a review, a question or a finished plan. Each of those updates uses a Lead turn."><Toggle label="Keep the Lead updated" checked={m.leadUpdates} onChange={(v) => void patchSettings({ models: { leadUpdates: v } })} /></Row>
        <Row label="Agents working at once" desc="More agents means more usage and more diffs for you to review. The Lead's chats don't count. It also caps the workspaces open in each room, unless the room's Agents page sets its own.">
          <Select label="Agents working at once" value={String(m.agentLimit)} options={[...[...new Set([1, 2, 3, 4, 5, 6, 8, m.agentLimit])].filter((n) => n > 0).sort((a, b) => a - b).map((n) => ({ value: String(n), label: String(n) })), { value: '0', label: 'No limit' }]} onChange={(e) => void patchSettings({ models: { agentLimit: Number(e.target.value) } })} />
        </Row>
        <Row label="Use agent teams" desc="Experimental in Claude Code. The Lead coordinates teammates through a shared task list."><Toggle label="Use agent teams" checked={m.agentTeams} onChange={(v) => void patchSettings({ models: { agentTeams: v } })} /></Row>
      </Section>
    </Page>
  )
}
