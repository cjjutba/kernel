import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { EFFORT_LABELS, EFFORTS, type AgentDef, type AppSettings, type Effort, type RoleModel } from '@shared/types'
import type { EffortMemory } from '@shared/effort'
import { rolePick } from '@shared/rolePick'
import { call } from '../../../api'
import { useStore } from '../../../store'
import { patchSettings } from '../../settings/useSettings'
import { loadPicks, onPicksChange, savePicks, type DraftPicks } from './draftStore'
import { fitEffort } from './providerModels'

// Each model remembers the effort you last used with it, the way Conductor's picker shows one per model (D-093).
// The memory is `models.effortByModel` in app settings, so main starts the chats you open at it too (D-130).

const NONE: EffortMemory = {}

/** The effort you last picked for each model. */
export const useEffortMemory = (): EffortMemory => useStore((s) => s.settings?.models.effortByModel ?? NONE)

/**
 * What a model you never picked an effort for runs at in an engineer's workspace: the agent's effort, else the Frontend and Backend
 * row of Settings, Models. Never the open chat's. The boxes that start a Lead chat fall back to the Lead's (`useLeadBox`).
 */
export const useDefaultEffort = (agentEffort?: Effort): Effort => useStore((s) => agentEffort ?? s.settings?.models.roles.engineers.effort ?? 'high')

export const rememberEffort = (model: string, effort: Effort) => void patchSettings({ models: { effortByModel: { [model]: effort } } })

/** The effort after `effort` among the model's levels, Claude's four by default, wrapping back to the first (⌘⇧/). */
export const nextEffort = (effort: Effort, efforts: Effort[] = EFFORTS.map((x) => x.id)): Effort => efforts[(efforts.indexOf(effort) + 1) % efforts.length] ?? effort

export const effortLabel = (effort: Effort) => EFFORT_LABELS[effort] ?? effort

/** The Lead row of a fresh install, for a box opened before Settings has loaded, and Claude Code's default when Codex can't run. */
const CLAUDE_DEFAULT: RoleModel = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }

export interface LeadStart extends RoleModel { plan: boolean }

/**
 * What a box that starts a Lead chat opens on while nothing is picked in it (KERNEL-544): Rowan's agent file pin if it has one, else
 * the Lead row of Settings, Models and effort, with the Lead's plan mode. A Lead on Codex while Codex can't run starts on Claude
 * Code's default model, at the Lead's effort or the nearest one that model takes.
 */
export function leadStart(lead: Pick<AgentDef, 'model' | 'provider' | 'effort'> | undefined, settings: Pick<AppSettings, 'models'> | null | undefined, codexUp: boolean): LeadStart {
  const plan = settings?.models.leadPlanMode ?? false
  const pick = rolePick(lead ?? {}, settings?.models.roles.lead ?? CLAUDE_DEFAULT)
  if (pick.provider !== 'codex' || codexUp) return { ...pick, plan }
  return { ...CLAUDE_DEFAULT, effort: fitEffort(pick.effort, CLAUDE_DEFAULT.model, []), plan }
}

/** What the box shows and sends: each field from the draft's picks when picked there, else from the Lead. */
export const boxPick = (start: LeadStart, picks: DraftPicks | undefined): { model: string; effort: Effort; plan: boolean } => ({
  model: picks?.model ?? start.model,
  effort: picks?.effort ?? start.effort,
  plan: picks?.plan ?? start.plan
})

/** Whether Codex answered its last read of models, kept across boxes so a box opened again starts from it. Unknown until one read ends. */
let codexRead: boolean | undefined

/**
 * Whether Codex can run a chat, from its model list. It is true until a read says otherwise, so a Lead on Codex is not moved off
 * it while the list is still on its way. Only reads when `needed`.
 */
function useCodexUp(needed: boolean): boolean {
  const [up, setUp] = useState(codexRead ?? true)
  useEffect(() => {
    if (!needed) return
    let live = true
    call('models.list', { provider: 'codex' }).then((m) => m.length > 0, () => false).then((ok) => {
      codexRead = ok
      if (live) setUp(ok)
    })
    return () => { live = false }
  }, [needed])
  return up
}

/**
 * The model, effort and plan mode of a box that starts a Lead chat, and what picking in it does (KERNEL-544). They are worked out on
 * every render as the draft's picks over the Lead's, so a box nobody touched follows Settings as it changes, and a pick stays with
 * the draft under `key`. Nothing here writes the Lead row: a pick applies to that chat. `seed` is picks to put in the draft when the
 * box opens, for the issue warning handing a box back. `fallback` is the effort a model you never picked an effort for runs at.
 */
export function useLeadBox(key: string, lead: AgentDef | undefined, seed?: DraftPicks) {
  const settings = useStore((s) => s.settings)
  const picks = useSyncExternalStore(onPicksChange, () => loadPicks(key))
  const codexUp = useCodexUp(leadStart(lead, settings, true).provider === 'codex')
  const start = leadStart(lead, settings, codexUp)
  const now = boxPick(start, picks)
  useLayoutEffect(() => { if (seed) savePicks(key, seed) }, [])
  return {
    ...now,
    fallback: start.effort,
    /** A model picked in the model list, at the effort that list shows for it (D-130). */
    pickModel: (model: string, effort: Effort) => savePicks(key, { model, effort }),
    /** An effort picked for the model on show. The model stays with it, and the effort goes in the model's memory (D-130). */
    pickEffort: (effort: Effort) => { rememberEffort(now.model, effort); savePicks(key, { model: now.model, effort }) },
    togglePlan: () => savePicks(key, { plan: !now.plan })
  }
}
