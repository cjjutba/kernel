import { EFFORTS, MODELS, type Effort, type ModelId } from '@shared/types'

// Each model remembers the effort you last used with it, the way Conductor's picker shows one per model (D-093).

const KEY = 'kernel.effortByModel'
export type EffortMemory = Partial<Record<ModelId, Effort>>

const isEffort = (v: unknown): v is Effort => EFFORTS.some((x) => x.id === v)
const isModel = (v: string): v is ModelId => MODELS.some((m) => m.id === v)

/** The effort `model` runs at when you pick it: the one you last used with it, else `fallback`. */
export const effortFor = (model: ModelId, memory: EffortMemory, fallback: Effort): Effort => memory[model] ?? fallback

/** The effort after `effort`, wrapping from Extra high back to Low (⌘⇧/). */
export const nextEffort = (effort: Effort): Effort => EFFORTS[(EFFORTS.findIndex((x) => x.id === effort) + 1) % EFFORTS.length].id

export const effortLabel = (effort: Effort) => EFFORTS.find((x) => x.id === effort)?.label ?? effort

/** Only known models and efforts survive, so a stale or hand-edited entry can't pick a level that doesn't exist. */
export function parseEffortMemory(raw: string | null): EffortMemory {
  try {
    const out: EffortMemory = {}
    for (const [k, v] of Object.entries(JSON.parse(raw ?? '{}') as Record<string, unknown>)) if (isModel(k) && isEffort(v)) out[k] = v
    return out
  } catch { return {} }
}

export function readEffortMemory(): EffortMemory {
  try { return parseEffortMemory(localStorage.getItem(KEY)) } catch { return {} }
}

export function rememberEffort(model: ModelId, effort: Effort) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readEffortMemory(), [model]: effort })) } catch { /* private mode: nothing to keep */ }
}
