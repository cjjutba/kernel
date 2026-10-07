import { useEffect } from 'react'
import { actions, useStore } from '../../store'
import { resolveTheme } from '../../ui'

/**
 * Applies Settings > Appearance to the window as it changes: theme (dark, light, or follow the system),
 * font size, density, pointer cursors and reduced motion. Called once from App.
 */
export function useAppearance() {
  const a = useStore((s) => s.settings?.appearance)
  const theme = a?.theme
  useEffect(() => {
    if (!theme) return
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const apply = () => actions.ui.setTheme(resolveTheme(theme, mq?.matches ?? true))
    apply()
    if (theme !== 'system' || !mq) return
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => {
    if (!a) return
    const d = document.documentElement.dataset
    d.font = a.fontSize
    d.density = a.density
    d.pointer = String(a.pointerCursors)
    d.reduceMotion = String(a.reduceMotion)
  }, [a?.fontSize, a?.density, a?.pointerCursors, a?.reduceMotion])
}
