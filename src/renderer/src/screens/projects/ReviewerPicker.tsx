import type { AgentDef } from '@shared/types'
import { KERNEL_REVIEWER, NO_REVIEWER } from '@shared/team'
import { Select } from '../../ui'

/**
 * The Reviewer picker on ProjectSetupTeam.png (KERNEL-551): the team's reviewer agents, then Kernel's code review, then No reviewer
 * under a rule. An agent shows its role under its name.
 */
export function ReviewerPicker({ value, agents, disabled, labelledBy, onChange }: { value: string; agents: AgentDef[]; disabled?: boolean; labelledBy: string; onChange: (id: string) => void }) {
  const choices = [
    ...agents.map((a) => ({ value: a.id, label: a.name, description: a.role || undefined })),
    { value: KERNEL_REVIEWER, label: 'Kernel’s code review', description: 'Kernel reviews each pull request' }
  ]
  const none = { value: NO_REVIEWER, label: 'No reviewer', description: 'No code review runs by itself' }
  const known = [...choices, none].some((c) => c.value === value)
  return (
    <Select
      label="Reviewer" labelledBy={labelledBy} disabled={disabled} align="right" value={known ? value : KERNEL_REVIEWER} onChange={onChange}
      options={[{ label: '', options: choices }, { label: '', options: [none] }]}
    />
  )
}
