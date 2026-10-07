import type { AppSettings } from '@shared/types'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { LinesField, ListField, Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

const TIMEOUTS = [{ value: '120', label: '2 min' }, { value: '300', label: '5 min' }, { value: '600', label: '10 min' }, { value: '1800', label: '30 min' }]

/** Settings > Permissions (SettingsPermissions.png). Running sessions read these on their next tool call. */
export function Permissions({ s }: { s: AppSettings }) {
  const p = s.permissions
  return (
    <Page title="Permissions">
      <Section title="Mode">
        <Row label="Permission mode" desc="Bypass only applies inside isolated worktrees, never on your current branch">
          <SegmentedControl label="Permission mode" value={p.mode} onChange={(v) => void patchSettings({ permissions: { mode: v as AppSettings['permissions']['mode'] } })} options={[{ value: 'ask', label: 'Ask' }, { value: 'acceptEdits', label: 'Accept edits' }, { value: 'bypassInWorktrees', label: 'Bypass in worktrees' }]} />
        </Row>
        <Row label="Allow network access"><Toggle label="Allow network access" checked={p.network} onChange={(v) => void patchSettings({ permissions: { network: v } })} /></Row>
      </Section>
      <Section title="Commands">
        <Row label="Always ask before" full={<LinesField label="Always ask before" value={p.alwaysAsk} onSave={(alwaysAsk) => void patchSettings({ permissions: { alwaysAsk } })} />} />
        <Row label="Never allow" full={<LinesField label="Never allow" value={p.neverAllow} onSave={(neverAllow) => void patchSettings({ permissions: { neverAllow } })} />} />
        <Row label="Protected branches">
          <ListField label="Protected branches" value={p.protectedBranches} onSave={(protectedBranches) => void patchSettings({ permissions: { protectedBranches } })} />
        </Row>
        <Row label="Approval timeout" desc="After this, the request falls back to the normal prompt in Claude Code">
          <Select label="Approval timeout" value={String(p.approvalTimeoutSec)} options={TIMEOUTS.some((t) => t.value === String(p.approvalTimeoutSec)) ? TIMEOUTS : [...TIMEOUTS, { value: String(p.approvalTimeoutSec), label: `${p.approvalTimeoutSec} sec` }]} onChange={(e) => void patchSettings({ permissions: { approvalTimeoutSec: Number(e.target.value) } })} />
        </Row>
      </Section>
    </Page>
  )
}
