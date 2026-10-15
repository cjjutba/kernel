import './reviews.css'
import './projects.css'
import { useEffect, useRef, useState } from 'react'
import { REVIEW_KINDS, type AgentDef, type AppSettings, type MergeMethod, type PrInstructions, type ReviewKind, type ReviewKindConfig } from '@shared/types'
import { providerOf } from '@shared/providers'
import { loadProject, useStore } from '../../../store'
import { Button, IconButton, SegmentedControl, Select, Toggle } from '../../../ui'
import { modelLabelOf, useProviderModels } from '../../workspace/composer/providerModels'
import { isOverride, NoProject, Row, ProjectPage, projectValue, Section, TagList, useProjectPage, useSaveNote, SaveNote } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { INSTRUCTIONS, InstructionSheet } from './InstructionSheet'
import { NO_REVIEW, patchAlwaysReview, patchReview } from './reviewSettings'

const NO_AGENTS: AgentDef[] = []
const NO_PATHS: string[] = []
const KERNEL = ''
const DEFAULT_MODEL = ''
const USE_DEFAULT = ''
const ROUNDS = [1, 2, 3, 5]
const METHOD: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' }

const DESC: Record<ReviewKind, string> = {
  code: 'Bugs, missing tests and unclear code.',
  security: 'Leaked secrets, access checks and unsafe input.',
  ux: 'Changed screens: layout, copy and missing states.'
}

/** The files that trigger a review, comma separated. Empty is every pull request, and the field says "All files". Saved when the field loses focus. */
function PathsField({ label, value, disabled, onSave }: { label: string; value: string[]; disabled: boolean; onSave: (paths: string[]) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  // The saved list replaces what was typed, so a save that fails puts the old paths back.
  useEffect(() => { if (ref.current) ref.current.value = value.join(', ') }, [value.join('\n')])
  const commit = () => {
    const next = (ref.current?.value ?? '').split(',').map((p) => p.trim()).filter(Boolean)
    if (next.join('\n') !== value.join('\n')) onSave(next)
    else if (ref.current) ref.current.value = value.join(', ')
  }
  return <input ref={ref} className="rv-paths" aria-label={label} placeholder="All files" spellCheck={false} disabled={disabled} defaultValue={value.join(', ')} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

/**
 * Settings > a project > Pull requests (MorePage projectPrs, KERNEL-680; KERNEL-557 reviews). Reviews, the rules for when a pull request comes
 * to you, and the instructions each PR button sends. Reviews and rules read and write `[review]` and `[merge]` in the shared settings.toml,
 * the rest the project's personal file. A review's agent is the project's Reviewer for the code review, and its ⋯ details hold the rest.
 */
export function ProjectPrs({ projectId, s }: { projectId?: string; s: AppSettings }) {
  const { project, rs } = useProjectPage(projectId)
  const agents = useStore((x) => (projectId ? x.agents[projectId] ?? NO_AGENTS : NO_AGENTS))
  const claude = useProviderModels('claude')
  const codex = useProviderModels('codex')
  const [details, setDetails] = useState<ReviewKind | null>(null)
  const [editing, setEditing] = useState<keyof PrInstructions | null>(null)
  useEffect(() => { if (projectId) void loadProject(projectId) }, [projectId])
  if (!project || !projectId) return <NoProject />
  const review = rs?.review ?? NO_REVIEW
  const always = rs?.merge?.alwaysReview ?? NO_PATHS
  const optional = rs?.pr?.optionalChecks ?? NO_PATHS
  // The agents a review can run as: the project's own files, as the engine's pool is. Kernel's prompt runs a review with none picked.
  const pool = agents.filter((a) => !a.lead && !a.retired && !a.builtIn)
  const reviewer = pool.find((a) => a.reviewer)
  const models = [...claude, ...codex]
  const save = (kind: ReviewKind, own: { [K in keyof ReviewKindConfig]?: ReviewKindConfig[K] | null }) => void shared.track(patchReview(projectId, { kinds: { [kind]: own } }))
  // An empty list is saved as one when settings.toml has a list, so the field can be cleared; else the key goes (KERNEL-401).
  const saveOptional = (lines: string[]) => patchProjectSettings(projectId, { pr: { optionalChecks: lines.length || rs?.sources['pr.optionalChecks'] === 'shared' || rs?.sources['pr.optionalChecks'] === 'override' ? lines : null } })
  const rounds = [...new Set([...ROUNDS, review.rounds])].sort((a, b) => a - b)
  const method = rs?.pr?.mergeMethod
  const shared = useSaveNote()
  const sheet = INSTRUCTIONS.find((i) => i.key === editing)
  return (
    <ProjectPage project={project} rs={rs} shared title="Pull requests" note={<SaveNote state={shared.state} shared />}>
      <Section title="Reviews">
        {REVIEW_KINDS.map(({ id, label }) => {
          const c = review.kinds[id]
          const runBy = c.agent ?? (id === 'code' ? reviewer?.id : undefined) ?? KERNEL
          const byOptions = [
            { value: KERNEL, label: 'Kernel' },
            ...pool.map((a) => ({ value: a.id, label: a.name })),
            ...(runBy !== KERNEL && !pool.some((a) => a.id === runBy) ? [{ value: runBy, label: runBy }] : [])
          ]
          const modelOptions = [
            { value: DEFAULT_MODEL, label: 'Default' },
            ...models.map((m) => ({ value: m.id, label: m.label })),
            ...(c.model && !models.some((m) => m.id === c.model) ? [{ value: c.model, label: modelLabelOf(c.model, models) }] : [])
          ]
          const by = id === 'code' && reviewer ? ` Run by ${reviewer.name}.` : ''
          return (
            <Row key={id} id={`review-${id}`} className={c.enabled ? undefined : 'rv-off'} label={`${label} review`} labelId={`rp-${id}`} desc={`${DESC[id]}${by}`}
              full={details === id && (
                <div className="rv-line">
                  <span className="rv-line-label" aria-hidden="true">Runs on</span>
                  <PathsField label={`${label} review runs on`} value={c.paths} disabled={!c.enabled} onSave={(paths) => save(id, { paths })} />
                  {!(id === 'code' && reviewer) && <Select label={`${label} review run by`} prefix="Run by" className="rv-by" value={runBy} disabled={!c.enabled} options={byOptions} onChange={(v) => save(id, { agent: v || null })} />}
                  <Select label={`${label} review model`} prefix="Model" className="rv-model" value={c.model ?? DEFAULT_MODEL} disabled={!c.enabled} options={modelOptions}
                    onChange={(v) => save(id, v ? { model: v, provider: providerOf(v) } : { model: null, provider: null })} />
                </div>
              )}>
              <IconButton icon="more" label={`${details === id ? 'Hide' : 'Show'} details of the ${label.toLowerCase()} review`} aria-expanded={details === id} onClick={() => setDetails(details === id ? null : id)} />
              <Toggle label={`${label} review`} checked={c.enabled} onChange={(on) => save(id, { enabled: on })} />
              <Select label={`${label} review is`} align="right" className="rv-req" value={c.required ? 'required' : 'optional'} disabled={!c.enabled} onChange={(v) => save(id, { required: v === 'required' })} options={[{ value: 'required', label: 'Required' }, { value: 'optional', label: 'Optional' }]} />
            </Row>
          )
        })}
      </Section>
      <Section title="Rules">
        <Row id="stop-after" label="Stop after" desc="Then the pull request comes to you.">
          <Select label="Stop after" align="right" value={String(review.rounds)} onChange={(v) => void shared.track(patchReview(projectId, { rounds: Number(v) }))} options={rounds.map((n) => ({ value: String(n), label: `${n} ${n === 1 ? 'round' : 'rounds'}` }))} />
        </Row>
        <Row id="always-review" shared label="Paths you always review" desc="Never merge automatically, on anyone’s Mac. Built-in paths apply too." full={<TagList label="Paths you always review" value={always} addLabel="Add path" onChange={(paths) => patchAlwaysReview(projectId, paths)} />} />
        <Row id="optional-checks" label="Optional checks" desc="A failing one doesn’t block, unless GitHub requires it." {...projectValue(rs, 'pr.optionalChecks', () => void patchProjectSettings(projectId, { pr: { optionalChecks: null } }))} full={<TagList label="Optional checks" value={optional} addLabel="Add check" mono={false} onChange={saveOptional} />} />
        <Row id="merge-method" label="Merge method" {...projectValue(rs, 'pr.mergeMethod', () => void patchProjectSettings(projectId, { pr: { mergeMethod: null } }), { to: { page: 'prs' }, label: 'Settings, Pull requests' })}>
          <SegmentedControl label="Merge method" value={method ?? s.pr.mergeMethod} onChange={(v) => void patchProjectSettings(projectId, { pr: { mergeMethod: v as MergeMethod } })} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }]} />
        </Row>
      </Section>
      <Section title="Instructions" scope="mac">
        {INSTRUCTIONS.map(({ key, label }) => {
          const custom = isOverride(rs, `pr.${key}`)
          return (
            <Row key={key} id={`instructions-${key.replace(/Instructions$/, '')}`} label={label}>
              {custom ? <span className="rm-custom">Custom for this project</span> : <span className="set-desc">App default</span>}
              <Button aria-label={`${custom ? 'Edit' : 'Customize'} the ${label} instructions`} onClick={() => setEditing(key)}>{custom ? 'Edit' : 'Customize'}</Button>
            </Row>
          )
        })}
      </Section>
      {editing && sheet && (
        <InstructionSheet
          title={sheet.label} value={rs?.pr?.[editing] ?? s.pr[editing]} fallback={s.pr[editing]} fallbackLabel="Use app default"
          onSave={(text) => patchProjectSettings(projectId, { pr: { [editing]: text } })} onClose={() => setEditing(null)}
        />
      )}
    </ProjectPage>
  )
}
