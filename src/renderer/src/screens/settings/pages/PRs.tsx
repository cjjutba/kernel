import type { AppSettings } from '@shared/types'
import { ALWAYS_REVIEW } from '@shared/merge'
import { SegmentedControl, Toggle } from '../../../ui'
import { LinesField, Page, Row, Section, TextField } from '../kit'
import { patchSettings } from '../useSettings'
import { NumberField, Pills } from './fields'

type Pr = AppSettings['pr']
const set = (patch: Partial<Pr>) => void patchSettings({ pr: patch })
const setAuto = (patch: Partial<Pr['autoMerge']>) => void patchSettings({ pr: { autoMerge: patch } })

/** The paths Kernel always sends to the user, in words. A path this doesn't know shows as written. Files show in mono. */
const BUILT_IN: Record<string, { text: string; mono?: boolean }> = {
  '.kernel/**': { text: 'Kernel settings' },
  '**/.claude/agents/**': { text: 'Agent files' },
  '**/CLAUDE.md': { text: 'CLAUDE.md', mono: true },
  '**/AGENTS.md': { text: 'AGENTS.md', mono: true },
  '.github/workflows/**': { text: 'CI workflows' }
}

/**
 * Settings > Pull requests (SettingsPRs.png). Merge automatically comes first: it is only this Mac's, off by default (KERNEL-557).
 * Then how PRs merge, and the default instructions each PR button sends to the agent. A room can replace any of them on its Instructions page.
 */
export function PRs({ s }: { s: AppSettings }) {
  const p = s.pr
  const auto = p.autoMerge
  const dim = auto.on ? undefined : 'rv-dim'
  return (
    <Page title="Pull requests" intro="How pull requests are merged, and the default instructions agents get. Each room can override the instructions on its own Instructions page.">
      <Section title="Merge automatically" action={<span className="set-tag">Only on this Mac</span>} note="This applies only on this Mac. A repo can add paths you always review, but it can’t turn on automatic merging for you.">
        <Row label="Merge without asking me" desc="Kernel merges a pull request when every review passes, checks are green and the change is under the size below.">
          <Toggle label="Merge without asking me" checked={auto.on} onChange={(on) => setAuto({ on })} />
        </Row>
        <Row className={dim} label="Size limit" desc="A change with more added and removed lines than this comes to you.">
          <NumberField label="Size limit" value={auto.maxLines} unit="lines" onSave={(maxLines) => setAuto({ maxLines })} />
        </Row>
        <Row className={dim} label="Always review yourself" desc="Paths you check yourself, on top of each room’s list. One path per line." full={<LinesField label="Always review yourself" value={auto.alwaysReview} onSave={(alwaysReview) => setAuto({ alwaysReview })} />} />
        <Row label="Built-in paths" desc="Changes to these always come to you. You can’t turn this off." full={<Pills label="Built-in paths" items={ALWAYS_REVIEW.map((path) => BUILT_IN[path] ?? { text: path, mono: true })} />} />
      </Section>
      <Section title="Merging">
        <Row label="Merge method">
          <SegmentedControl label="Merge method" value={p.mergeMethod} onChange={(v) => set({ mergeMethod: v as Pr['mergeMethod'] })} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }]} />
        </Row>
        <Row label="Open as draft"><Toggle label="Open as draft" checked={p.draft} onChange={(v) => set({ draft: v })} /></Row>
        <Row label="Require green checks to merge"><Toggle label="Require green checks to merge" checked={p.requireGreen} onChange={(v) => set({ requireGreen: v })} /></Row>
        <Row label="Review every pull request automatically" desc="Kernel starts each room’s reviews when a pull request passes checks. Off saves usage, and you can still ask for a review.">
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
