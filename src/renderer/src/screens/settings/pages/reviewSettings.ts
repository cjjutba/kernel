import type { ReviewConfig, ReviewKind, ReviewPatch } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, getState } from '../../../store'

/** `[review]` before the room's file says anything: the code review on and required, the others off, two rounds (main's `reviewOf`). */
export const NO_REVIEW: ReviewConfig = {
  rounds: 2,
  kinds: {
    code: { enabled: true, paths: [], required: true },
    security: { enabled: false, paths: [], required: true },
    ux: { enabled: false, paths: [], required: true }
  }
}

/**
 * `[review]` after a patch, the way main writes it: a `null` takes the key back to its default, so an agent, model or provider
 * is gone and the paths are every pull request again.
 */
export function applyReviewPatch(review: ReviewConfig, patch: ReviewPatch): ReviewConfig {
  const next = structuredClone(review)
  if (patch.rounds !== undefined) next.rounds = patch.rounds ?? NO_REVIEW.rounds
  for (const [kind, own] of Object.entries(patch.kinds ?? {}) as [ReviewKind, NonNullable<ReviewPatch['kinds']>[ReviewKind]][]) {
    const c = next.kinds[kind]
    for (const [key, v] of Object.entries(own ?? {})) {
      if (v === undefined) continue
      if (v === null) { if (key === 'agent' || key === 'model' || key === 'provider') delete c[key]; else (c as unknown as Record<string, unknown>)[key] = (NO_REVIEW.kinds[kind] as unknown as Record<string, unknown>)[key]; continue }
      ;(c as unknown as Record<string, unknown>)[key] = v
    }
  }
  return next
}

/**
 * Save a change to a room's `[review]`, in the shared settings.toml. The screen updates at once and main's answer replaces it.
 * A failure puts the old settings back and says why, so a control never shows a value that wasn't saved.
 */
export async function patchReview(roomId: string, patch: ReviewPatch) {
  const before = getState().roomSettings[roomId]
  if (before) actions.settings.setRoom(roomId, { ...before, review: applyReviewPatch(before.review ?? NO_REVIEW, patch) })
  try {
    actions.settings.setRoom(roomId, await call('settings.setReview', { roomId, review: patch }))
  } catch (e) {
    if (before) actions.settings.setRoom(roomId, before)
    actions.ui.toast({ title: 'Could not save the review settings', sub: cleanError(e) })
  }
}
