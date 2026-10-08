import { EFFORTS, MODELS, type AppSettings, type Effort, type ModelId } from '@shared/types'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

const label = (id: ModelId) => MODELS.find((m) => m.id === id)?.label ?? id
const pick = (ids: ModelId[], current: ModelId) => [...new Set([...ids, current])].map((id) => ({ value: id, label: label(id) }))
const OPUS: ModelId = 'claude-opus-5-5', SONNET: ModelId = 'claude-sonnet-5-5', HAIKU: ModelId = 'claude-haiku-4-5-20251001', FABLE: ModelId = 'claude-fable-5-1'

/** Settings > Models and effort (SettingsModels.png). The agent limit is enforced by the engine with a queue. */
export function Models({ s }: { s: AppSettings }) {
  const m = s.models
  const role = (key: 'lead' | 'engineers' | 'qa' | 'reviewer', title: string, ids: ModelId[]) => (
    <Row label={title}>
      <Select label={title} value={m[key]} options={pick(ids, m[key])} onChange={(e) => void patchSettings({ models: { [key]: e.target.value as ModelId } })} />
    </Row>
  )
  return (
    <Page title="Models and effort">
      <Section title="Default model by role">
        {role('lead', 'Lead', [OPUS, SONNET, FABLE])}
        {role('engineers', 'Frontend and Backend', [SONNET, OPUS, HAIKU])}
        {role('qa', 'QA', [SONNET, HAIKU])}
        {role('reviewer', 'Reviewer', [OPUS, SONNET])}
      </Section>
      <Section title="Defaults">
        <Row label="Effort">
          <SegmentedControl label="Effort" value={m.effort} options={EFFORTS.map((e) => ({ value: e.id, label: e.label }))} onChange={(v) => void patchSettings({ models: { effort: v as Effort } })} />
        </Row>
        <Row label="Start the Lead in plan mode"><Toggle label="Start the Lead in plan mode" checked={m.leadPlanMode} onChange={(v) => void patchSettings({ models: { leadPlanMode: v } })} /></Row>
        <Row label="Start new workspaces in plan mode" desc="For workspaces you start from New workspace. The Lead's hand-offs start without it, because the Lead already planned."><Toggle label="Start new workspaces in plan mode" checked={m.workspacePlanMode} onChange={(v) => void patchSettings({ models: { workspacePlanMode: v } })} /></Row>
        <Row label="Keep the Lead updated" desc="Kernel tells the Lead when a teammate finishes or a pull request changes, so it can hand out the next step. Each update uses a Lead turn."><Toggle label="Keep the Lead updated" checked={m.leadUpdates} onChange={(v) => void patchSettings({ models: { leadUpdates: v } })} /></Row>
        <Row label="Agents working at once" desc="More agents means more usage and more diffs for you to review. The Lead's chats don't count.">
          <Select label="Agents working at once" value={String(m.agentLimit)} options={[...[...new Set([1, 2, 3, 4, 5, 6, 8, m.agentLimit])].filter((n) => n > 0).sort((a, b) => a - b).map((n) => ({ value: String(n), label: String(n) })), { value: '0', label: 'No limit' }]} onChange={(e) => void patchSettings({ models: { agentLimit: Number(e.target.value) } })} />
        </Row>
        <Row label="Use agent teams" desc="Experimental in Claude Code. The Lead coordinates teammates through a shared task list."><Toggle label="Use agent teams" checked={m.agentTeams} onChange={(v) => void patchSettings({ models: { agentTeams: v } })} /></Row>
      </Section>
    </Page>
  )
}
