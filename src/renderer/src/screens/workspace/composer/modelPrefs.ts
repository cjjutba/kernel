import { EFFORT_LABELS, EFFORTS, type Effort } from '@shared/types'
import type { EffortMemory } from '@shared/effort'
import { useStore } from '../../../store'
import { patchSettings } from '../../settings/useSettings'

// Each model remembers the effort you last used with it, the way Conductor's picker shows one per model (D-093).
// The memory is `models.effortByModel` in app settings, so main starts the chats you open at it too (D-130).

const NONE: EffortMemory = {}

/** The effort you last picked for each model. */
export const useEffortMemory = (): EffortMemory => useStore((s) => s.settings?.models.effortByModel ?? NONE)

/** What a model you never picked an effort for runs at: the agent's effort, else Settings, Models. Never the open chat's. */
export const useDefaultEffort = (agentEffort?: Effort): Effort => useStore((s) => agentEffort ?? s.settings?.models.roles.engineers.effort ?? 'high')

export const rememberEffort = (model: string, effort: Effort) => void patchSettings({ models: { effortByModel: { [model]: effort } } })

/** The effort after `effort`, wrapping from Extra high back to Low (⌘⇧/). */
export const nextEffort = (effort: Effort): Effort => EFFORTS[(EFFORTS.findIndex((x) => x.id === effort) + 1) % EFFORTS.length].id

export const effortLabel = (effort: Effort) => EFFORT_LABELS[effort] ?? effort
