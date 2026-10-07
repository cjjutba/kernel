import type { AppSettings } from '@shared/types'
import { SegmentedControl, Toggle } from '../../../ui'
import { Page, Row, Section, TextField } from '../kit'
import { patchSettings } from '../useSettings'

type Pr = AppSettings['pr']
const set = (patch: Partial<Pr>) => void patchSettings({ pr: patch })

/** Settings > Pull requests (SettingsPRs.png). The two instruction files are what Create PR and Resolve conflicts send to the agent. */
export function PRs({ s }: { s: AppSettings }) {
  const p = s.pr
  return (
    <Page title="Pull requests">
      <Section title="Instructions">
        <Row label="Create PR" desc="Sent to the agent when you press Create PR" full={<TextField label="create-pr.md" value={p.createInstructions} onSave={(createInstructions) => set({ createInstructions })} />} />
        <Row label="Resolve conflicts" desc="Sent when you press Resolve conflicts" full={<TextField label="resolve-conflicts.md" value={p.resolveInstructions} onSave={(resolveInstructions) => set({ resolveInstructions })} />} />
      </Section>
      <Section title="Merging">
        <Row label="Merge method">
          <SegmentedControl label="Merge method" value={p.mergeMethod} onChange={(v) => set({ mergeMethod: v as Pr['mergeMethod'] })} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }]} />
        </Row>
        <Row label="Open as draft"><Toggle label="Open as draft" checked={p.draft} onChange={(v) => set({ draft: v })} /></Row>
        <Row label="Require green checks to merge"><Toggle label="Require green checks to merge" checked={p.requireGreen} onChange={(v) => set({ requireGreen: v })} /></Row>
        <Row label="Require Reviewer approval"><Toggle label="Require Reviewer approval" checked={p.requireReviewer} onChange={(v) => set({ requireReviewer: v })} /></Row>
      </Section>
    </Page>
  )
}
