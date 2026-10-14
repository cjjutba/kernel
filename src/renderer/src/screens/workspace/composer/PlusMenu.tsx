import { useRef } from 'react'
import type { ChatPart } from '@shared/types'
import { IconButton, Menu, MENU_SEPARATOR } from '../../../ui'
import { IssuePicker, PrPicker, WorkspacePicker } from './LinkPicker'

/** What the + button has open: its menu, or one of the three link pickers it leads to. */
export type PlusPanel = 'plus' | 'linkIssue' | 'linkPr' | 'linkWorkspaces' | null

const ABOVE = { right: 0, bottom: 'calc(100% + 8px)' } as const

/**
 * The + button and its menu, as in Conductor (D-093): Link issue (⌘I), Link pull request, Link workspaces, Permission mode or plan mode (⇧Tab) and Add
 * attachment (⌘U). Both composers use it. `anchorRef` is the wrapper around this component, so a press on + toggles instead of reopening.
 * A chat's composer passes `onMode`, which opens its mode menu from the Permission mode row (KERNEL-456). The boxes that start a chat have
 * no mode menu, so they pass `plan` and `onPlan` and get the plan toggle.
 */
export function PlusMenu({ panel, onPanel, anchorRef, roomId, workspaceId, plan, onPlan, onMode, onAttach, onInsert }: {
  panel: PlusPanel; onPanel: (p: PlusPanel) => void; anchorRef: React.RefObject<HTMLElement | null>
  /** The room to search issues and workspaces in. Without one the link items are off. */
  roomId?: string
  /** This composer's own workspace, left out of Link workspaces. */
  workspaceId?: string
  plan?: boolean; onPlan?: () => void; onMode?: () => void; onAttach: () => void; onInsert: (parts: ChatPart[]) => void
}) {
  // Menu calls onSelect, then onClose. A pick that opens a picker leaves it here so the close that follows opens it.
  const next = useRef<PlusPanel | 'mode'>(null)
  const close = () => {
    const to = next.current
    next.current = null
    if (to === 'mode') onMode?.()
    else onPanel(to)
  }
  const insert = (parts: ChatPart[]) => { onPanel(null); onInsert(parts) }
  return (
    <>
      <IconButton icon="plus" label="Add context" aria-haspopup="menu" aria-expanded={panel !== null} onClick={() => onPanel(panel ? null : 'plus')} />
      {panel === 'plus' && (
        <Menu label="Add" anchorRef={anchorRef} onClose={close} style={{ ...ABOVE, width: 248 }} items={[
          { id: 'issue', label: 'Link issue', icon: 'link', shortcut: '⌘I', disabled: !roomId, onSelect: () => { next.current = 'linkIssue' } },
          { id: 'pr', label: 'Link pull request', icon: 'pr', disabled: !roomId, onSelect: () => { next.current = 'linkPr' } },
          { id: 'workspaces', label: 'Link workspaces', icon: 'branch', disabled: !roomId, onSelect: () => { next.current = 'linkWorkspaces' } },
          ...(onMode
            ? [{ id: 'mode', label: 'Permission mode', icon: 'shield' as const, shortcut: '⇧Tab', onSelect: () => { next.current = 'mode' } }]
            : onPlan ? [{ id: 'plan', label: plan ? 'Exit plan mode' : 'Enter plan mode', icon: 'book' as const, shortcut: '⇧Tab', onSelect: onPlan }] : []),
          MENU_SEPARATOR,
          { id: 'attach', label: 'Add attachment', icon: 'clip', shortcut: '⌘U', onSelect: onAttach }
        ]} />
      )}
      {panel === 'linkIssue' && roomId && <IssuePicker roomId={roomId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={(p) => insert([p])} />}
      {panel === 'linkPr' && roomId && <PrPicker roomId={roomId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={(p) => insert([p])} />}
      {panel === 'linkWorkspaces' && roomId && <WorkspacePicker roomId={roomId} exclude={workspaceId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={insert} />}
    </>
  )
}
