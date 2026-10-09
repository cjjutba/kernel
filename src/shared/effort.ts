import { EFFORTS, MODELS, type Effort, type ModelId } from './types'

// Each model remembers the effort you last used with it (D-093, D-130). The memory is `models.effortByModel` in app settings.

export type EffortMemory = Partial<Record<ModelId, Effort>>

const isEffort = (v: unknown): v is Effort => EFFORTS.some((x) => x.id === v)
const isModel = (v: string): v is ModelId => MODELS.some((m) => m.id === v)

/** The effort `model` runs at when you pick it: the one you last used with it, else `fallback`. */
export const effortFor = (model: ModelId, memory: EffortMemory, fallback: Effort): Effort => memory[model] ?? fallback

/** Only known models and efforts survive, so a stale or hand-edited entry can't pick a level that doesn't exist. */
export function effortMemory(v: unknown): EffortMemory {
  const out: EffortMemory = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, e] of Object.entries(v)) if (isModel(k) && isEffort(e)) out[k] = e
  return out
}
