import { useRef, type ReactNode } from 'react'
import { actions } from '../../store'
import { ResizeHandle } from '../ResizeHandle'
import { AppSidebar } from './AppSidebar'
import { SIDEBAR_HIDE_BELOW, SIDEBAR_KEY, SIDEBAR_MIN, sidebarDefault, sidebarLimit, useSidebarWidth } from './useSidebarWidth'
import './sidebar.css'

/**
 * The one column on the left of the window, in the app and in Settings (KERNEL-509). The frame owns the `<nav>`, its width, padding and resize edge; only
 * the list inside changes. In Settings, App passes `settingsList` and the frame shows it in place of the app's list. There the column can't be hidden, so a
 * drag stops at the minimum width instead, and the region is named Settings so a screen reader can tell it from the app's sidebar.
 */
export function Sidebar({ settingsList }: { settingsList?: ReactNode }) {
  const nav = useRef<HTMLElement>(null)
  const { width, onCommit } = useSidebarWidth()
  const inSettings = settingsList !== undefined
  return (
    <nav ref={nav} aria-label={inSettings ? 'Settings' : 'Sidebar'} className="sidebar" style={{ width }}>
      {inSettings ? settingsList : <AppSidebar />}
      <ResizeHandle
        targetRef={nav} edge="right" label="Resize sidebar" size={width} min={SIDEBAR_MIN} limit={sidebarLimit} defaultSize={sidebarDefault}
        storageKey={SIDEBAR_KEY} hideBelow={inSettings ? undefined : SIDEBAR_HIDE_BELOW} onHide={inSettings ? undefined : () => actions.ui.setSidebar(false)} onCommit={onCommit}
      />
    </nav>
  )
}
