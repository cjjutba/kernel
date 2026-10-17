import { useRef } from 'react'
import type { ChatPart, LeadMode, WorkspaceMode } from '@shared/types'
import { Button, Icon, IconButton, Menu, MENU_SEPARATOR } from '../../../ui'
import { BranchPanel } from './BranchPicker'
import { IssuePicker, PrPicker, WorkspacePicker } from './LinkPicker'
import { RunInMenu } from './WherePickers'

/** What the + button has open: its menu, or one of the three link pickers it leads to. */
export type PlusPanel = 'plus' | 'linkIssue' | 'linkPr' | 'linkWorkspaces' | 'runIn' | 'branch' | null

/**
 * What New chat decides in the + menu: where the chat runs and the branch it starts from (KERNEL-786). A chat that has started has neither.
 * `branch` is the branch the chat starts from, and `local` the checkout's own, which Local works on and which is read only.
 */
export interface PlusWhere {
  place: WorkspaceMode; picked: string; branch: string; local: string
  /** The chat's mode. In Hand off the chat reads the latest main on the shared folder, so there is no branch to pick until Build here (KERNEL-1052). */
  lead?: LeadMode
  onPlace: (m: WorkspaceMode) => void; onBranch: (ref: string) => void
}

const readsLine = (place: WorkspaceMode) => `Hand off reads the latest main. Build here ${place === 'current' ? 'uses your current branch' : 'makes a worktree'}`

const ABOVE = { right: 0, bottom: 'calc(100% + 8px)' } as const

/**
 * The + button and its menu (D-093): Link issue (⌘I), Link pull request, Link workspaces, Permission mode or plan mode (⇧Tab) and Add
 * attachment (⌘U). Both composers use it. New chat passes `where` for the two rows that start a chat, Run in and Branch, and gets a quiet chip beside +
 * while either differs from the default, which opens the same picker. `anchorRef` is the wrapper around this component, so a press on + toggles instead of reopening.
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
  const reset = (refocus?: boolean) => {
    onPanel(null)
    if (refocus) anchorRef.current?.querySelector<HTMLElement>('[aria-label="Add context"]')?.focus()
  }
  // Local or a branch other than the default is worth saying beside +. The default, a worktree from the default branch, says nothing.
  const reads = where?.lead === 'handoff'
  const chip = where && !reads && (where.place === 'current'
    ? { icon: 'computer' as const, text: 'Local', label: 'Run in Local, change', to: 'runIn' as const }
    : where.picked ? { icon: 'branch' as const, text: `from ${where.branch}`, label: `New branch from ${where.branch}, change`, to: 'branch' as const } : undefined)
  return (
    <>
      {chip && (
        <Button variant="ghost" className="cmp-model cmp-where-chip" disabled={disabled} aria-label={chip.label} aria-haspopup="menu" aria-expanded={panel === chip.to} onClick={() => onPanel(panel === chip.to ? null : chip.to)}>
          <Icon name={chip.icon} size={14} /><span className="cmp-where-text ellipsis">{chip.text}</span>
        </Button>
      )}
      <IconButton icon="plus" label="Add context" disabled={disabled && !!where} aria-haspopup="menu" aria-expanded={panel !== null} onClick={() => onPanel(panel ? null : 'plus')} />
      {panel === 'plus' && (
        <Menu label="Add" anchorRef={anchorRef} onClose={close} style={{ ...ABOVE, width: where ? 296 : 248 }} items={[
          { id: 'issue', label: 'Link issue', icon: 'link', shortcut: '⌘I', disabled: !projectId, onSelect: () => { next.current = 'linkIssue' } },
          { id: 'pr', label: 'Link pull request', icon: 'pr', disabled: !projectId, onSelect: () => { next.current = 'linkPr' } },
          { id: 'workspaces', label: 'Link workspaces', icon: 'branch', disabled: !projectId, onSelect: () => { next.current = 'linkWorkspaces' } },
          ...(onMode
            ? [{ id: 'mode', label: 'Permission mode', icon: 'shield' as const, shortcut: '⇧Tab', onSelect: () => { next.current = 'mode' } }]
            : onPlan ? [{ id: 'plan', label: plan ? 'Exit plan mode' : 'Enter plan mode', icon: 'book' as const, shortcut: '⇧Tab', onSelect: onPlan }] : []),
          ...(where
            ? [
              MENU_SEPARATOR,
              { id: 'runIn', label: 'Run in', icon: where.place === 'current' ? 'computer' as const : 'fork' as const, note: where.place === 'current' ? 'Local' : 'Worktree', onSelect: () => { next.current = 'runIn' } },
              // Local works on the checkout's branch and never cuts one, so the row only says which.
              reads
                ? { id: 'branch', label: 'Branch', icon: 'branch' as const, disabled: true, ariaLabel: `Branch: latest main. ${readsLine(where!.place)}`, content: <><Icon name="branch" /><span className="where-tx"><span className="where-t">Latest main</span><span className="where-d">{readsLine(where!.place)}</span></span></> }
                : { id: 'branch', label: 'Branch', icon: 'branch' as const, note: where.place === 'current' ? where.local : `New from ${where.branch}`, disabled: where.place === 'current', ariaLabel: where.place === 'current' ? `Branch: ${where.local}. Local works on your checkout's current branch` : undefined, onSelect: () => { next.current = 'branch' } }
            ]
            : []),
          MENU_SEPARATOR,
          { id: 'attach', label: 'Add attachment', icon: 'clip', shortcut: '⌘U', onSelect: onAttach }
        ]} />
      )}
      {panel === 'runIn' && where && <RunInMenu anchorRef={anchorRef} mode={where.place} onClose={reset} onPick={(m) => { where.onPlace(m); reset(true) }} />}
      {panel === 'branch' && where && projectId && <BranchPanel projectId={projectId} picked={where.picked} anchorRef={anchorRef} onClose={reset} onPick={(ref) => { where.onBranch(ref); reset(true) }} />}
      {panel === 'linkIssue' && projectId && <IssuePicker projectId={projectId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={(p) => insert([p])} />}
      {panel === 'linkPr' && projectId && <PrPicker projectId={projectId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={(p) => insert([p])} />}
      {panel === 'linkWorkspaces' && projectId && <WorkspacePicker projectId={projectId} exclude={workspaceId} anchorRef={anchorRef} style={ABOVE} onClose={() => onPanel(null)} onPick={insert} />}
    </>
  )
}
