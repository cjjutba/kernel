import { useRef, useState } from 'react'
import type { Room, WorkspaceMode } from '@shared/types'
import { RoomIcon } from '../../../components/RoomIcon'
import { Button, Icon } from '../../../ui'
import { PopSearch, WherePop } from './WherePop'

/**
 * The room New chat starts in, opened from the title: the room's name, underlined, in "What's next for Kernel?", or a Pick a room button
 * when the page has no room. Search, the rooms with a check on the current one, then New room. There is no "No project" row.
 */
export function RoomPicker({ variant, rooms, room, open, disabled, onToggle, onClose, onPick, onNewRoom }: {
  variant: 'title' | 'button'; rooms: Room[]; room: Room | undefined; open: boolean; disabled?: boolean
  onToggle: () => void; onClose: () => void; onPick: (id: string) => void; onNewRoom: () => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [text, setText] = useState('')
  const close = (refocus?: boolean) => { setText(''); onClose(); if (refocus) anchor.current?.querySelector('button')?.focus() }
  const needle = text.trim().toLowerCase()
  const shown = rooms.filter((r) => !needle || r.name.toLowerCase().includes(needle))
  const pick = (id: string) => { onPick(id); close(true) }
  return (
    <span ref={anchor} className={variant === 'title' ? 'lead-room-anchor' : 'cmp-branch-anchor'}>
      {variant === 'title'
        ? <button type="button" className="lead-room" disabled={disabled} aria-label={`Room: ${room?.name ?? 'none'}, change room`} aria-haspopup="menu" aria-expanded={open} data-tip={(room?.name.length ?? 0) > 24 ? room?.name : undefined} onClick={onToggle}><span className="ellipsis">{room?.name}</span></button>
        : <Button disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>Pick a room<Icon name="chevron" size={12} /></Button>}
      {open && (
        <WherePop anchorRef={anchor} label="Room" width={248} drop="down" onClose={close} focusFirst={false}
          onKey={(e) => { if (e.key === 'Enter' && e.target instanceof HTMLInputElement && shown[0]) { e.preventDefault(); pick(shown[0].id) } }}>
          <PopSearch label="Search rooms…" value={text} onChange={setText} />
          <div className="where-list" role="group" aria-label="Rooms">
            {shown.map((r) => (
              <button key={r.id} type="button" role="menuitemradio" aria-checked={r.id === room?.id} className="menu-item where-row" onClick={() => pick(r.id)}>
                <RoomIcon room={r} size={16} /><span className="grow ellipsis">{r.name}</span>{r.id === room?.id && <Icon name="check" size={14} />}
              </button>
            ))}
            {!shown.length && <p className="where-note">No room matches</p>}
          </div>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item where-row" onClick={() => { close(); onNewRoom() }}>
            <Icon name="plus" size={16} /><span className="grow">New room</span>
          </button>
        </WherePop>
      )}
    </span>
  )
}

export const RUN_IN: { id: WorkspaceMode; label: string; hint: string; icon: 'fork' | 'computer' }[] = [
  { id: 'worktree', label: 'Worktree', hint: 'Its own branch and copy of the files', icon: 'fork' },
  { id: 'current', label: 'Local', hint: 'Works in your checkout, files and branch are shared', icon: 'computer' }
]

/**
 * Worktree or Local, two rows with a line under each, opened from the + menu's Run in row or the chip beside + (KERNEL-786). The Lead's own chat
 * is always a worktree (KERNEL-405), so this tells Kernel how its teammates should run. The default is Settings, Workspaces' mode.
 */
export function RunInMenu({ anchorRef, mode, onPick, onClose }: { anchorRef: React.RefObject<HTMLElement | null>; mode: WorkspaceMode; onPick: (m: WorkspaceMode) => void; onClose: (refocus?: boolean) => void }) {
  return (
    <WherePop anchorRef={anchorRef} label="Worktree or Local" width={340} align="end" onClose={onClose}>
      {RUN_IN.map((m) => (
        <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === mode} className="menu-item where-row where-mode" onClick={() => onPick(m.id)}>
          <Icon name={m.icon} size={16} />
          <span className="where-tx"><span className="where-t">{m.label}</span><span className="where-d">{m.hint}</span></span>
          {m.id === mode && <Icon name="check" size={14} />}
        </button>
      ))}
    </WherePop>
  )
}
