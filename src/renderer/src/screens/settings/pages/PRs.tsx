import type { AppSettings } from '@shared/types'
import { SegmentedControl, Toggle } from '../../../ui'
import { Page, Row, Section, TextField } from '../kit'
import { patchSettings } from '../useSettings'

type Pr = AppSettings['pr']
const set = (patch: Partial<Pr>) => void patchSettings({ pr: patch })

/** Settings > Pull requests (SettingsPRs.png). How PRs merge, and the default instructions each PR button sends to the agent. A room can replace any of them on its Instructions page. */
export function PRs({ s }: { s: AppSettings }) {
  const p = s.pr
  return (
    <Page title="Pull requests" intro="How pull requests are merged, and the default instructions agents get. Each room can override the instructions on its own Instructions page.">
      <Section title="Merging">
        <Row label="Merge method">
          <SegmentedControl label="Merge method" value={p.mergeMethod} onChange={(v) => set({ mergeMethod: v as Pr['mergeMethod'] })} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }]} />
        </Row>
        <Row label="Open as draft"><Toggle label="Open as draft" checked={p.draft} onChange={(v) => set({ draft: v })} /></Row>
        <Row label="Require green checks to merge"><Toggle label="Require green checks to merge" checked={p.requireGreen} onChange={(v) => set({ requireGreen: v })} /></Row>
        <Row label="Review every pull request automatically" desc="The Lead hands each PR that passes checks to the reviewer. Off saves usage, and you can still ask for a review.">
          <Toggle label="Review every pull request automatically" checked={p.autoReview} onChange={(v) => set({ autoReview: v })} />
        </Row>
        <Row label="Wait for the reviewer's approval to merge, when a review ran"><Toggle label="Wait for the reviewer's approval to merge, when a review ran" checked={p.requireReviewer} onChange={(v) => set({ requireReviewer: v })} /></Row>
        <Row label="Let the Lead merge when you ask" desc="The Lead merges only when your own message asks. Each merge still needs passing checks and any reviewer's approval.">
          <Toggle label="Let the Lead merge when you ask" checked={p.leadMerge} onChange={(v) => set({ leadMerge: v })} />
        </Row>
      </Section>
      <Section title="Instructions">
        <Row label="Create PR" desc="Sent to the agent when you press Create PR" full={<TextField label="create-pr.md" value={p.createInstructions} onSave={(createInstructions) => set({ createInstructions })} />} />
        <Row label="Resolve conflicts" desc="Sent when you press Resolve conflicts" full={<TextField label="resolve-conflicts.md" value={p.resolveInstructions} onSave={(resolveInstructions) => set({ resolveInstructions })} />} />
        <Row label="Fix checks" desc="Sent when you press Fix checks" full={<TextField label="fix-checks.md" value={p.fixChecksInstructions} onSave={(fixChecksInstructions) => set({ fixChecksInstructions })} />} />
        <Row label="Address review" desc="Sent when you press Address review" full={<TextField label="address-review.md" value={p.addressReviewInstructions} onSave={(addressReviewInstructions) => set({ addressReviewInstructions })} />} />
      </Section>
    </Page>
  )
}
