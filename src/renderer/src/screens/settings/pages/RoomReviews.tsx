import './reviews.css'
import { useEffect, useRef } from 'react'
import { REVIEW_KINDS, type AgentDef, type ReviewKind, type ReviewKindConfig } from '@shared/types'
import { providerOf } from '@shared/providers'
import { loadRoom, useStore } from '../../../store'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { modelLabelOf, useProviderModels } from '../../workspace/composer/providerModels'
import { LinesField, NoRoom, Row, RoomPage, Section, useRoomPage } from '../kit'
import { NumberField } from './fields'
import { NO_REVIEW, patchAlwaysReview, patchReview } from './reviewSettings'

const NO_AGENTS: AgentDef[] = []
const NO_PATHS: string[] = []
const KERNEL = ''
const DEFAULT_MODEL = ''

const DESC: Record<ReviewKind, string> = {
  code: 'Reads the diff for bugs, missing tests and unclear code.',
  security: 'Looks for leaked secrets, missing access checks and unsafe input.',
  ux: 'Checks the changed screens for layout, copy and missing states.'
}

/** A kind's paths as one line, and back: comma separated, as the canvas draws them. */
const pathsText = (paths: string[]) => paths.join(', ')
const pathsOf = (text: string) => text.split(',').map((p) => p.trim()).filter(Boolean)

/** The files that trigger a review. Empty is every pull request, and the field says "All files". Saved when the field loses focus. */
function PathsField({ label, value, disabled, onSave }: { label: string; value: string[]; disabled: boolean; onSave: (paths: string[]) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  // The saved list replaces what was typed, so a save that fails puts the old paths back.
  useEffect(() => { if (ref.current) ref.current.value = pathsText(value) }, [value.join('\n')])
  const commit = () => {
    const next = pathsOf(ref.current?.value ?? '')
    if (next.join('\n') !== value.join('\n')) onSave(next)
    else if (ref.current) ref.current.value = pathsText(value)
  }
  return <input ref={ref} className="rv-paths" aria-label={label} placeholder="All files" spellCheck={false} disabled={disabled} defaultValue={pathsText(value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

/**
 * Settings > a room > Reviews (SettingsRoomReviews.png, KERNEL-557): what runs on each pull request once its checks pass, and when
 * it comes to the user. It reads and writes `[review]` in the shared settings.toml through `settings.setReview`, and the repo's
 * always-review paths, `[merge] always_review`, through `settings.setAlwaysReview` (KERNEL-594), so the whole team shares it. A review that is off keeps its settings in view and can't be edited, since saving one would turn it on.
 */
export function RoomReviews({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const agents = useStore((x) => (roomId ? x.agents[roomId] ?? NO_AGENTS : NO_AGENTS))
  const claude = useProviderModels('claude')
  const codex = useProviderModels('codex')
  useEffect(() => { if (roomId) void loadRoom(roomId) }, [roomId])
  if (!room || !roomId) return <NoRoom />
  const review = rs?.review ?? NO_REVIEW
  const always = rs?.merge?.alwaysReview ?? NO_PATHS
  // The agents a review can run as: the room's own files, as the engine's pool is. Kernel's prompt runs a review with none picked.
  const pool = agents.filter((a) => !a.lead && !a.retired && !a.builtIn)
  // The code review runs as the room's reviewer when it names no agent, so Kernel is not a choice there while the room has one.
  const reviewer = pool.find((a) => a.reviewer)
  const models = [...claude, ...codex]
  const save = (kind: ReviewKind, own: { [K in keyof ReviewKindConfig]?: ReviewKindConfig[K] | null }) => void patchReview(roomId, { kinds: { [kind]: own } })
  return (
    <RoomPage room={room} rs={rs} shared title="Reviews" intro={`What runs on each pull request in ${room.name} once its checks pass. The whole team shares this page.`}>
      <Section title="On each pull request">
        {REVIEW_KINDS.map(({ id, label }) => {
          const c = review.kinds[id]
          const runBy = c.agent ?? (id === 'code' ? reviewer?.id : undefined) ?? KERNEL
          const byOptions = [
            ...(id === 'code' && reviewer ? [] : [{ value: KERNEL, label: 'Kernel' }]),
            ...pool.map((a) => ({ value: a.id, label: a.name })),
            ...(runBy !== KERNEL && !pool.some((a) => a.id === runBy) ? [{ value: runBy, label: runBy }] : [])
          ]
          const modelOptions = [
            { value: DEFAULT_MODEL, label: 'Default' },
            ...models.map((m) => ({ value: m.id, label: m.label })),
            ...(c.model && !models.some((m) => m.id === c.model) ? [{ value: c.model, label: modelLabelOf(c.model, models) }] : [])
          ]
          return (
            <Row key={id} className={c.enabled ? undefined : 'rv-off'} label={`${label} review`} desc={DESC[id]}
              full={(
                <div className="rv-line">
                  <span className="rv-line-label" aria-hidden="true">Runs on</span>
                  <PathsField label={`${label} review runs on`} value={c.paths} disabled={!c.enabled} onSave={(paths) => save(id, { paths })} />
                  <Select label={`${label} review run by`} className="rv-by" value={runBy} disabled={!c.enabled} options={byOptions} onChange={(e) => save(id, { agent: e.target.value || null })} />
                  <Select label={`${label} review model`} className="rv-model" value={c.model ?? DEFAULT_MODEL} disabled={!c.enabled} options={modelOptions}
                    onChange={(e) => save(id, e.target.value ? { model: e.target.value, provider: providerOf(e.target.value) } : { model: null, provider: null })} />
                </div>
              )}>
              <div className="rv-ctl">
                <div className="rv-seg" inert={!c.enabled || undefined}>
                  <SegmentedControl label={`${label} review is`} value={c.required ? 'required' : 'optional'} onChange={(v) => save(id, { required: v === 'required' })} options={[{ value: 'required', label: 'Required' }, { value: 'optional', label: 'Optional' }]} />
                </div>
                <Toggle label={`${label} review`} checked={c.enabled} onChange={(on) => save(id, { enabled: on })} />
              </div>
            </Row>
          )
        })}
      </Section>
      <Section title="When it comes to you" note="A change is saved in settings.toml, so everyone on the repo gets it.">
        <Row label="Stop after" desc="After this many, the pull request comes to you.">
          <NumberField label="Review rounds" value={review.rounds} unit="review rounds" onSave={(rounds) => void patchReview(roomId, { rounds })} />
        </Row>
        <Row label="Always review yourself" desc="Changes to these paths never merge automatically, on anyone’s Mac. One path per line."
          full={(
            <>
              <LinesField label="Always review yourself" value={always} onSave={(paths) => void patchAlwaysReview(roomId, paths)} />
              <p className="set-hint">Kernel’s built-in paths, like agent files and CI workflows, always apply too. These only add to them.</p>
            </>
          )} />
      </Section>
    </RoomPage>
  )
}
