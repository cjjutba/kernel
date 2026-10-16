import { useEffect, useState } from 'react'
import { readWidth } from '../ResizeHandle'

export const SIDEBAR_DEFAULT = 236
export const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480
export const SIDEBAR_KEY = 'kernel.sidebarWidth'
/** Letting go below this hides the sidebar. The saved width stays. Settings has no hide, so it clamps to the minimum instead. */
export const SIDEBAR_HIDE_BELOW = 160
/** The panel keeps at least this much of the window, however wide the sidebar was saved. */
const PANEL_MIN = 520

/** The widest the sidebar can be in this window. It never drops below the minimum, since narrow windows fold the sidebar anyway (D-080). */
export const sidebarLimit = () => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - PANEL_MIN))
export const sidebarDefault = () => SIDEBAR_DEFAULT
const readSaved = () => readWidth(SIDEBAR_KEY, SIDEBAR_MIN, SIDEBAR_MAX) ?? SIDEBAR_DEFAULT

/**
 * The width of the sidebar frame, in the app and in Settings (KERNEL-419, KERNEL-509). It is read from `kernel.sidebarWidth` once, when the frame mounts, and
 * the frame stays mounted as the list inside it changes. The window's space for it is state only so a resize that changes the limit re-renders; one that doesn't bails out.
 */
export function useSidebarWidth() {
  const [saved, setSaved] = useState(readSaved)
  const [limit, setLimit] = useState(sidebarLimit)
  useEffect(() => {
    const onResize = () => setLimit(sidebarLimit())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return { width: Math.min(saved, limit), onCommit: (w: number | null) => setSaved(w ?? SIDEBAR_DEFAULT) }
}
