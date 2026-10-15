import type { ProjectSettings, TrackerKind } from '@shared/types'
import { Select } from '../../../ui'
import { Row, projectValue } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { useMenuOpen } from './projectMenu'

type Kind = TrackerKind | 'none'

/** The trackers a project can pick, in list order. */
const CHOICES: Kind[] = ['linear', 'github', 'none']
const LABEL: Record<Kind, string> = { linear: 'Linear', github: 'GitHub Issues', none: 'None' }
/** What the row says when the project has no `[tracker] kind` and detection decided. */
const DETECTED: Partial<Record<Kind, string>> = {
  linear: 'Detected from your Linear connection.',
  github: 'Detected from the github.com remote.',
  none: 'None detected. Choose one to list issues for this project.'
}

/**
 * Settings > a project > General > Issue tracker (MorePage projectGeneral, KERNEL-680): the project's tracker. `detected` is what Kernel finds
 * without a `[tracker] kind`, and the list marks it. A pick writes the key to the project's personal file, and Reset drops it again.
 */
export function ProjectTrackerRow({ projectId, rs, detected }: { projectId: string; rs: ProjectSettings; detected: Kind }) {
  const menu = useMenuOpen('projectTracker')
  const chosen = rs.tracker?.kind
  const current = chosen ?? detected
  return (
    <Row
      id="tracker"
      label="Issue tracker"
      desc={chosen ? undefined : DETECTED[detected]}
      {...projectValue(rs, 'tracker.kind', () => void patchProjectSettings(projectId, { tracker: { kind: null } }))}
    >
      <Select
        label="Issue tracker" value={current} align="right" {...menu}
        options={CHOICES.map((kind) => ({ value: kind, label: LABEL[kind], description: kind === detected ? 'Detected' : undefined }))}
        onChange={(v) => { if (v !== current) void patchProjectSettings(projectId, { tracker: { kind: v as Kind } }) }}
      />
    </Row>
  )
}
