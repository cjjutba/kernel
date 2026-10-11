import { EFFORT_LABELS, EFFORTS, MODELS, type Effort } from './types'

// Each model remembers the effort you last used with it (D-093, D-130). The memory is `models.effortByModel` in app settings.
// It holds Codex models too, by their own ids, which never start with `claude-` (KERNEL-406).

export type EffortMemory = Partial<Record<string, Effort>>

const isClaudeEffort = (v: unknown): v is Effort => EFFORTS.some((x) => x.id === v)
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && v in EFFORT_LABELS

/** The effort `model` runs at when you pick it: the one you last used with it, else `fallback`. */
export const effortFor = (model: string, memory: EffortMemory, fallback: Effort): Effort => memory[model] ?? fallback

/**
 * Only known models and efforts survive, so a stale or hand-edited entry can't pick a level that doesn't exist. A Claude
 * entry needs one of Claude's models and efforts. Codex lists its models at run time, so any other id keeps any effort.
 */
export function effortMemory(v: unknown): EffortMemory {
  const out: EffortMemory = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, e] of Object.entries(v)) {
    const claude = k.startsWith('claude-')
    if (claude ? MODELS.some((m) => m.id === k) && isClaudeEffort(e) : k.trim() !== '' && isEffort(e)) out[k] = e
  }
  return out
}
