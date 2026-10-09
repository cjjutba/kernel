import { EFFORTS, type Effort, type ModelId } from '@shared/types'
import { effortFor, effortMemory, type EffortMemory } from '@shared/effort'

// Each model remembers the effort you last used with it, the way Conductor's picker shows one per model (D-093).

const KEY = 'kernel.effortByModel'
export { effortFor, type EffortMemory }

/** The effort after `effort`, wrapping from Extra high back to Low (⌘⇧/). */
export const nextEffort = (effort: Effort): Effort => EFFORTS[(EFFORTS.findIndex((x) => x.id === effort) + 1) % EFFORTS.length].id

export const effortLabel = (effort: Effort) => EFFORTS.find((x) => x.id === effort)?.label ?? effort

export function parseEffortMemory(raw: string | null): EffortMemory {
  try { return effortMemory(JSON.parse(raw ?? '{}')) } catch { return {} }
}

export function readEffortMemory(): EffortMemory {
  try { return parseEffortMemory(localStorage.getItem(KEY)) } catch { return {} }
}

export function rememberEffort(model: ModelId, effort: Effort) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readEffortMemory(), [model]: effort })) } catch { /* private mode: nothing to keep */ }
}
