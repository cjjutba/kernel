import type { Theme } from '@shared/types'

/** The setting: a theme, or follow the system ("match system" in Settings, Appearance). */
export type ThemePref = Theme | 'system'

/** Resolve a preference to the theme to draw. `systemDark` is what `prefers-color-scheme: dark` says now. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

/**
 * Put the resolved theme on <html data-theme>. With 'system' it follows the OS until called again.
 * Returns a function that stops following. Settings (KERNEL-25) calls this when `appearance.theme` changes.
 */
export function applyTheme(pref: ThemePref): () => void {
  const mq = query()
  const set = () => { document.documentElement.dataset.theme = resolveTheme(pref, mq?.matches ?? true) }
  set()
  if (pref !== 'system' || !mq) return () => undefined
  mq.addEventListener('change', set)
  return () => mq.removeEventListener('change', set)
}
