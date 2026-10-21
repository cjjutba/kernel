import { useRef } from 'react'
import type { ChatPart, LeadWhere } from '@shared/types'
import { Button, Icon, IconButton, Menu, MENU_SEPARATOR } from '../../../ui'
import { BranchPanel } from './BranchPicker'
import { IssuePicker, PrPicker, WorkspacePicker } from './LinkPicker'
import { WHERE_ICON, WorkspaceMenu, type PreviousWorktree } from './WorkspaceMenu'

/** What the + button has open: its menu, one of the three link pickers it leads to, or New chat's Workspace menu and its branch list from the chip. */
export type PlusPanel = 'plus' | 'linkIssue' | 'linkPr' | 'linkWorkspaces' | 'workspace' | 'branch' | null

/**
 * What New chat decides beside the + button: where the chat works and, for a new worktree, the branch it starts from
 * (docs/decisions/workspace-picker.md). A chat that has started has neither. `pick` is the choice on show. `taken` names the chat
 * that holds the checkout while it can't be shared. `previous` are the worktrees a chat can join, newest first. `picked` is the
 * branch picked, empty for the default, and `branch` the one the worktree starts from.
 */
export interface PlusWhere {
  pick: LeadWhere; taken?: string; previous: PreviousWorktree[]; picked: string; branch: string
  onPick: (w: LeadWhere) => void; onBranch: (ref: string) => void
}

/** The chip's words: the choice, and for a new worktree the branch when it isn't the default. */
export function whereChip(w: PlusWhere): { text: string; label: string } {
  if (w.pick.kind === 'current') return { text: 'Current checkout', label: 'Workspace: Current checkout, change' }
  if (w.pick.kind === 'previous') {
    const id = w.pick.workspaceId
    const title = w.previous.find((p) => p.id === id)?.title ?? 'Previous worktree'
    return { text: title, label: `Workspace: previous worktree, ${title}, change` }
  }
  return w.picked ? { text: `New worktree from ${w.branch}`, label: `Workspace: New worktree from ${w.branch}, change` } : { text: 'New worktree', label: 'Workspace: New worktree, change' }
}

const ABOVE = { right: 0, bottom: 'calc(100% + 8px)' } as const

/**
 * The + button and its menu (D-093): Link issue (⌘I), Link pull request, Link workspaces, Permission mode or plan mode (⇧Tab) and Add
 * attachment (⌘U). Both composers use it. New chat passes `where` and gets the Workspace chip beside +,
 * which opens the Workspace menu (docs/decisions/workspace-picker.md). `anchorRef` is the wrapper around this component, so a press on + toggles instead of reopening.
 * A chat's composer passes `onMode`, which opens its mode menu from the Permission mode row (KERNEL-456). The boxes that start a chat have
 * no mode menu, so they pass `plan` and `onPlan` and get the plan toggle.
 */
export function PlusMenu({ panel, onPanel, anchorRef, projectId, workspaceId, plan, onPlan, onMode, where, disabled, onAttach, onInsert }: {
  panel: PlusPanel; onPanel: (p: PlusPanel) => void; anchorRef: React.RefObject<HTMLElement | null>
  /** The project to search issues and workspaces in. Without one the link items are off. */
  projectId?: string
  /** This composer's own workspace, left out of Link workspaces. */
  workspaceId?: string
  plan?: boolean; onPlan?: () => void; onMode?: () => void; where?: PlusWhere; disabled?: boolean; onAttach: () => void; onInsert: (parts: ChatPart[]) => void
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
  // New chat always says where the chat will work, beside +.
  const chip = where && whereChip(where)
  const open = panel === 'workspace' || panel === 'branch'
  return (
    <>
      {where && chip && (
        <Button variant="ghost" className="cmp-model cmp-where-chip" disabled={disabled} aria-label={chip.label} aria-haspopup="menu" aria-expanded={open} onClick={() => onPanel(open ? null : 'workspace')}>
          <Icon name={WHERE_ICON[where.pick.kind]} size={14} /><span className="cmp-where-text ellipsis">{chip.text}</span>
        </Button>
      )}
      <IconButton icon="plus" box="sm" label="Add context" disabled={disabled && !!where} aria-haspopup="menu" aria-expanded={panel !== null} onClick={() => onPanel(panel ? null : 'plus')} />
      {panel === 'plus' && (
        <Menu label="Add" anchorRef={anchorRef} onClose={close} style={{ ...ABOVE, width: 248 }} items={[
          { id: 'issue', label: 'Link issue', icon: 'link', shortcut: '⌘I', disabled: !projectId, onSelect: () => { next.current = 'linkIssue' } },
          { id: 'pr', label: 'Link pull request', icon: 'pr', disabled: !projectId, onSelect: () => { next.current = 'linkPr' } },
          { id: 'workspaces', label: 'Link workspaces', icon: 'branch', disabled: !projectId, onSelect: () => { next.current = 'linkWorkspaces' } },
          ...(onMode
            ? [{ id: 'mode', label: 'Permission mode', icon: 'shield' as const, shortcut: '⇧Tab', onSelect: () => { next.current = 'mode' } }]
            : onPlan ? [{ id: 'plan', label: plan ? 'Exit plan mode' : 'Enter plan mode', icon: 'book' as const, shortcut: '⇧Tab', onSelect: onPlan }] : []),
          MENU_SEPARATOR,
          { id: 'attach', label: 'Add attachment', icon: 'clip', shortcut: '⌘U', onSelect: onAttach }
        ]} />
      )}
      {panel === 'workspace' && where && (
        <WorkspaceMenu anchorRef={anchorRef} style={{ ...ABOVE, width: 320 }} pick={where.pick} taken={where.taken} previous={where.previous} base={where.branch}
          onPick={where.onPick} onBase={() => { next.current = 'branch' }} onClose={() => { const going = next.current; close(); if (!going) anchorRef.current?.querySelector<HTMLElement>('.cmp-where-chip')?.focus() }} />
      )}
      {panel === 'branch' && where && projectId && <BranchPanel projectId={projectId} picked={where.picked} anchorRef={anchorRef} onClose={(refocus) => { onPanel(null); if (refocus) anchorRef.current?.querySelector<HTMLElement>('.cmp-where-chip')?.focus() }} onPick={(ref) => { where.onBranch(ref); onPanel(null); anchorRef.current?.querySelector<HTMLElement>('.cmp-where-chip')?.focus() }} />}
      {panel === 'linkIssue' && projectId && <IssuePicker projectId={projectId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={(p) => insert([p])} />}
      {panel === 'linkPr' && projectId && <PrPicker projectId={projectId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={(p) => insert([p])} />}
      {panel === 'linkWorkspaces' && projectId && <WorkspacePicker projectId={projectId} exclude={workspaceId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={insert} />}
    </>
  )
}
