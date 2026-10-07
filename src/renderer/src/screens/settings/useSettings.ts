import type { AppSettings, DeepPartial } from '@shared/types'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'

/** The app settings, read from the store. Null until the first load. */
export function useSettings(): AppSettings | null {
  return useStore((s) => s.settings)
}

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over) || base === null || typeof base !== 'object') return over as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)[k], v)
  return out as T
}

/**
 * Save a change. The screen updates at once and main's answer replaces it (main clamps numbers).
 * A failure puts the old settings back and says so, so a control never shows a value that was not saved.
 */
export async function patchSettings(patch: DeepPartial<AppSettings>) {
  const before = getState().settings
  if (!before) return
  actions.settings.set(merge(before, patch))
  try {
    actions.settings.set(await call('settings.set', { patch }))
  } catch (e) {
    actions.settings.set(before)
    actions.ui.toast({ title: 'Could not save the setting', sub: (e as Error).message })
  }
}
