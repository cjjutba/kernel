import type { RefObject } from 'react'
import type { LeadWhere } from '@shared/types'
import { Icon, Menu, MENU_SEPARATOR, type MenuEntry } from '../../../ui'
import type { IconName } from '../../../icons'
import { ageOf } from './branchRows'

/** A worktree an earlier chat holds open, which a new chat can join: its chat's title, its branch and when the chat started. */
export interface PreviousWorktree { id: string; title: string; branch: string; at: number }

/** The icon each choice has, in the menu and on the chip. */
export const WHERE_ICON: Record<LeadWhere['kind'], IconName> = { current: 'folder', worktree: 'fork', previous: 'history' }

/** A row of two lines: the choice, and a muted line under it. `end` is a check or the arrow of a submenu. */
function Row({ icon, title, sub, end }: { icon: IconName; title: string; sub: string; end?: 'check' | 'more' }) {
  return (
    <>
      <Icon name={icon} size={16} />
      <span className="where-tx"><span className="where-t ellipsis">{title}</span><span className="where-d ellipsis">{sub}</span></span>
      {end === 'check' && <Icon name="check" size={14} />}
      {end === 'more' && <Icon name="right" size={12} />}
    </>
  )
}

/**
 * Where New chat's chat works, opened from the chip beside + (docs/decisions/workspace-picker.md): Current checkout, New worktree and
 * Previous worktree, each with a line under it. The checkout is disabled, with the chat that holds it named, while "One current-branch
 * workspace per project" keeps a second chat off it. New worktree has the branch it starts from under it. Previous worktree names the most
 * recent chat's worktree, and with several, opens a list of up to five, newest first.
 */
export function WorkspaceMenu({ anchorRef, style, pick, taken, previous, base, onPick, onBase, onClose }: {
  anchorRef: RefObject<HTMLElement | null>; style: React.CSSProperties; pick: LeadWhere
  /** The chat or workspace that holds the checkout, when it can't be shared. */
  taken?: string
  /** The reusable worktrees, newest chat first. */
  previous: PreviousWorktree[]
  /** The branch a new worktree starts from, as the branch menu names it. */
  base: string
  onPick: (w: LeadWhere) => void; onBase: () => void; onClose: () => void
}) {
  const chosen = pick.kind === 'previous' ? previous.find((p) => p.id === pick.workspaceId) : undefined
  const items: (MenuEntry | typeof MENU_SEPARATOR)[] = [
    {
      id: 'current', checked: pick.kind === 'current', disabled: !!taken,
      ariaLabel: taken ? `Current checkout, unavailable. ${taken} is working there. Pick New worktree.` : 'Current checkout. Works in your project folder on its current branch.',
      content: <Row icon={WHERE_ICON.current} title="Current checkout" sub={taken ? `${taken} is working there` : 'Your project folder, on its current branch'} end={pick.kind === 'current' ? 'check' : undefined} />,
      label: 'Current checkout', onSelect: () => onPick({ kind: 'current' })
    },
    {
      id: 'worktree', checked: pick.kind === 'worktree',
      ariaLabel: 'New worktree. Its own branch and copy of the files.',
      content: <Row icon={WHERE_ICON.worktree} title="New worktree" sub="Its own branch and copy of the files" end={pick.kind === 'worktree' ? 'check' : undefined} />,
      label: 'New worktree', onSelect: () => onPick({ kind: 'worktree' })
    },
    ...(pick.kind === 'worktree' ? [{ id: 'base', label: 'Branch from', icon: 'branch' as const, note: base, ariaLabel: `Branch from ${base}, change`, onSelect: onBase }] : []),
    previous.length === 0
      ? {
        id: 'previous', disabled: true, ariaLabel: 'Previous worktree, unavailable. No other chat has a worktree open.', label: 'Previous worktree',
        content: <Row icon={WHERE_ICON.previous} title="Previous worktree" sub="No other chat has one open" />
      }
      : previous.length === 1
        ? {
          id: 'previous', checked: pick.kind === 'previous', ariaLabel: `Previous worktree: ${previous[0].title}`, label: 'Previous worktree',
          content: <Row icon={WHERE_ICON.previous} title="Previous worktree" sub={previous[0].title} end={pick.kind === 'previous' ? 'check' : undefined} />,
          onSelect: () => onPick({ kind: 'previous', workspaceId: previous[0].id })
        }
        : {
          id: 'previous', ariaLabel: `Previous worktree: ${(chosen ?? previous[0]).title}, ${previous.length} to pick from`, label: 'Previous worktree',
          content: <Row icon={WHERE_ICON.previous} title="Previous worktree" sub={(chosen ?? previous[0]).title} end="more" />,
          children: previous.map((p): MenuEntry => ({
            id: p.id, checked: pick.kind === 'previous' && pick.workspaceId === p.id, label: p.title,
            ariaLabel: `${p.title}, ${p.branch}, ${ageOf(p.at)}`,
            content: <Row icon="branch" title={p.title} sub={`${p.branch} · ${ageOf(p.at)}`} end={pick.kind === 'previous' && pick.workspaceId === p.id ? 'check' : undefined} />,
            onSelect: () => onPick({ kind: 'previous', workspaceId: p.id })
          }))
        }
  ]
  return <Menu label="Workspace" heading="Workspace" anchorRef={anchorRef} onClose={onClose} style={style} items={items} />
}
