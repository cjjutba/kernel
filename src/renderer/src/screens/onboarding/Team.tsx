import { type Effort, type PermissionMode, type Provider, type Role } from '@shared/types'
import { KERNEL_REVIEWER, NO_REVIEWER } from '@shared/team'
import { roleSide } from '@shared/rolePick'
import { useState } from 'react'
import { actions, getState, go, useStore } from '../../store'
import { MODE_INFO, pickMode } from '../../permissionModes'
import { AgentAvatar, Checkbox, Icon, Select } from '../../ui'
import { ModelField } from '../workspace/composer/ModelField'
import { patchSettings, useSettings } from '../settings/useSettings'
import { Card } from './parts'
import type { StepFrame } from './Onboarding'

/** The starter team, in the order the project seats them. Each one's model and effort is its role's in Settings, Models and effort. */
const TEAM: { id: string; name: string; role: string; does: string; key: Role; lead?: true }[] = [
  { id: 'kernel-lead', name: 'Kernel', role: 'Lead', does: 'Plans with you, then hands out the tasks.', key: 'lead', lead: true },
  { id: 'christian', name: 'Christian', role: 'Frontend', does: 'Builds UI and follows DESIGN.md.', key: 'frontend' },
  { id: 'sean', name: 'Sean', role: 'Backend', does: 'APIs, data models and integrations.', key: 'engineers' },
  { id: 'teng', name: 'Teng', role: 'QA', does: 'Tests, bug repros and acceptance checks.', key: 'qa' },
  { id: 'artkin', name: 'Artkin', role: 'Reviewer', does: 'Reviews every pull request. Can’t edit.', key: 'reviewer' }
]
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions']

/** Your team (KERNEL-1088): who joins every new project, each one's model and effort, who reviews and how much they do before asking. Saved as you go, and applied when a project is created. */
export function useTeam(): StepFrame {
  const s = useSettings()
  const codexReady = useStore((st) => st.accounts.some((a) => a.provider === 'codex' && a.signedIn))
  const forced = useState(() => getState().ui.menu)[0]
  const [reviewerOpen, setReviewerOpen] = useState(forced === 'obReviewer')
  const [modeOpen, setModeOpen] = useState(forced === 'obMode')
  const out = s?.onboarding.out ?? []
  const reviewer = s?.onboarding.reviewer ?? 'artkin'
  const setOut = (id: string, on: boolean) => {
    const next = on ? out.filter((x) => x !== id) : [...out, id]
    // A reviewer who leaves the team can't review: Kernel's own code review takes over.
    void patchSettings({ onboarding: { out: next, ...(!on && reviewer === id ? { reviewer: KERNEL_REVIEWER } : {}) } })
  }
  const choose = (role: Role, model: string, effort: Effort, provider: Provider) => void patchSettings({ models: { roles: { [role]: { prefer: provider, [provider]: { model, effort } } } } })
  const row = (a: (typeof TEAM)[number]) => {
    const choice = s?.models.roles[a.key]
    const side = choice && roleSide(choice)
    const off = !a.lead && out.includes(a.id)
    return (
      <div key={a.id} className="ob-row ob-member" role="listitem" data-off={off || undefined}>
        <span className="ob-pick">
          {a.lead ? <span className="ob-lock" role="img" aria-label="Kernel is always on the team"><Icon name="lock" size={12} /></span>
            : <Checkbox checked={!off} onChange={(on) => setOut(a.id, on)} aria-label={`${a.name} joins the team`}>{null}</Checkbox>}
        </span>
        <AgentAvatar name={a.name} size={28} />
        <span className="ob-body">
          <span className="ob-name">{a.name}<span className="ob-role">{a.role}</span></span>
          <span className="ob-detail">{a.does}</span>
        </span>
        {side && <ModelField startOpen={forced === 'obModel' && a.key === 'frontend'} label={`${a.name}'s model and effort`} provider={side.provider} both grouped={codexReady} model={side.model} effort={side.effort} fallback={side.effort}
          onChange={(m, e, p) => choose(a.key, m, e, p)} onEffort={(e) => choose(a.key, side.model, e, side.provider)} />}
      </div>
    )
  }
  const reviewers = [
    ...TEAM.filter((a) => a.key === 'reviewer' && !out.includes(a.id)).map((a) => ({ value: a.id, label: a.name, description: a.role, leading: <AgentAvatar name={a.name} size={16} /> })),
    { value: KERNEL_REVIEWER, label: 'Kernel', description: 'Reviews with its code checklist', leading: <AgentAvatar name="Kernel" size={16} /> },
    { value: NO_REVIEWER, label: 'Nobody', description: 'Merge without review' }
  ]
  const mode = s?.permissions.mode ?? 'auto'
  return {
    title: 'Your team',
    sub: 'Kernel leads every project. Pick who joins the team, and each agent’s model and effort. You can change this later in Settings, Agents.',
    canContinue: !!s,
    onContinue: () => go({ name: 'onboarding', step: 'loop' }, { history: 'replace' }),
    body: (
      <>
        <Card label="Team">
          {TEAM.map(row)}
          <button type="button" className="ob-row ob-create" role="listitem" onClick={() => actions.ui.openModal({ name: 'newAgent', step: 'describe' })}>
            <span className="ob-pick" />
            <span className="ob-plus" aria-hidden="true"><Icon name="plus" size={14} /></span>
            <span className="ob-body"><span className="ob-name">Create an agent</span><span className="ob-detail">Describe it and Kernel drafts the file.</span></span>
          </button>
        </Card>
        <Card label="Team settings" className="ob-settings">
          <div className="ob-row">
            <span className="ob-body"><span id="ob-reviewer" className="ob-name">Who reviews pull requests</span><span className="ob-detail">Reviews start on their own when an agent opens one.</span></span>
            <Select label="Who reviews pull requests" labelledBy="ob-reviewer" align="right" open={reviewerOpen} onOpenChange={setReviewerOpen} value={reviewer} onChange={(v) => void patchSettings({ onboarding: { reviewer: v } })} options={reviewers} />
          </div>
          <div className="ob-row">
            <span className="ob-body"><span id="ob-mode" className="ob-name">Permission mode</span><span className="ob-detail">How much agents do before they ask you.</span></span>
            <Select label="Permission mode" labelledBy="ob-mode" align="right" open={modeOpen} onOpenChange={setModeOpen} leading={<Icon name="shield" size={14} />} value={mode} onChange={(v) => void pickMode(v as PermissionMode)}
              options={MODES.map((m) => ({ value: m, label: MODE_INFO[m].label, description: `${m === 'auto' ? 'Recommended. ' : ''}${MODE_INFO[m].desc}` }))} />
          </div>
        </Card>
      </>
    )
  }
}
