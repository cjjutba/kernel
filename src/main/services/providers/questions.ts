import type { AskedQuestion } from '@shared/types'

// A question card's options, the same for every provider (KERNEL-415, KERNEL-406).

/** "(Recommended)" at the end of a label, in any case. */
const RECOMMENDED = /\s*\(recommended\)$/i

/**
 * One option of an agent's question. Claude Code's habit is "Postgres (Recommended)", and a Codex model can write the
 * same: the card shows a tag instead, so the label loses it and the option is marked recommended.
 */
export function askedOption(label: unknown, description?: unknown): AskedQuestion['options'][number] {
  const given = String(label).trim()
  const plain = given.replace(RECOMMENDED, '') || given
  return {
    label: plain,
    ...(typeof description === 'string' && description ? { description } : {}),
    ...(plain !== given ? { recommended: true } : {})
  }
}
