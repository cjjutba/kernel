import { useRef } from 'react'
import type { ChatPart } from '@shared/types'
import { IconButton, Menu } from '../../../ui'
import { IssuePicker, WorkspacePicker } from './LinkPicker'

/** What the + button has open: its menu, or one of the two link pickers it leads to. */
export type PlusPanel = 'plus' | 'linkIssue' | 'linkWorkspaces' | null

const ABOVE = { right: 0, bottom: 'calc(100% + 8px)' } as const

/**
 * The + button and its menu, as in Conductor (D-093): Link issue (⌘I), Link workspaces, plan mode (⇧Tab) and Add attachment
 * (⌘U). Both composers use it. `anchorRef` is the wrapper around this component, so a press on + toggles instead of reopening.
 */
export function PlusMenu({ panel, onPanel, anchorRef, roomId, workspaceId, plan, onPlan, onAttach, onInsert }: {
  panel: PlusPanel; onPanel: (p: PlusPanel) => void; anchorRef: React.RefObject<HTMLElement | null>
  /** The room to search issues and workspaces in. Without one the link items are off. */
  roomId?: string
  /** This composer's own workspace, left out of Link workspaces. */
  workspaceId?: string
  plan: boolean; onPlan: () => void; onAttach: () => void; onInsert: (parts: ChatPart[]) => void
}) {
  // Menu calls onSelect, then onClose. A pick that opens a picker leaves it here so the close that follows opens it.
  const next = useRef<PlusPanel>(null)
  const close = () => { onPanel(next.current); next.current = null }
  const insert = (parts: ChatPart[]) => { onPanel(null); onInsert(parts) }
  return (
    <>
      <IconButton icon="plus" label="Add context" aria-haspopup="menu" aria-expanded={panel !== null} onClick={() => onPanel(panel ? null : 'plus')} />
      {panel === 'plus' && (
        <Menu label="Add" anchorRef={anchorRef} onClose={close} style={{ ...ABOVE, width: 248 }} items={[
          { id: 'issue', label: 'Link issue', icon: 'link', shortcut: '⌘I', disabled: !roomId, onSelect: () => { next.current = 'linkIssue' } },
          { id: 'workspaces', label: 'Link workspaces', icon: 'branch', disabled: !roomId, onSelect: () => { next.current = 'linkWorkspaces' } },
          { id: 'plan', label: plan ? 'Exit plan mode' : 'Enter plan mode', icon: 'book', shortcut: '⇧Tab', onSelect: onPlan },
          { id: 'attach', label: 'Add attachment', icon: 'clip', shortcut: '⌘U', onSelect: onAttach }
        ]} />
      )}
      {panel === 'linkIssue' && roomId && <IssuePicker roomId={roomId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={(p) => insert([p])} />}
      {panel === 'linkWorkspaces' && roomId && <WorkspacePicker roomId={roomId} exclude={workspaceId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={insert} />}
    </>
  )
}
