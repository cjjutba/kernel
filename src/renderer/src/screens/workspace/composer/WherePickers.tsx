import { useRef, useState } from 'react'
import type { Room, WorkspaceMode } from '@shared/types'
import { RoomIcon } from '../../../components/RoomIcon'
import { Button, Icon } from '../../../ui'
import { PopSearch, WherePop } from './WherePop'

/** A where-row button: the picker's label, drawn muted with the chevron after it. */
function WhereButton({ label, open, disabled, onClick, children }: { label: string; open: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant="ghost" className="cmp-model cmp-where-btn" disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={onClick}>
      {children}<Icon name="chevron" size={12} />
    </Button>
  )
}

/** The room New chat starts in. Search, the rooms with a check on the current one, then New room. There is no "No project" row. */
export function RoomPicker({ rooms, room, open, disabled, onToggle, onClose, onPick, onNewRoom }: {
  rooms: Room[]; room: Room | undefined; open: boolean; disabled?: boolean
  onToggle: () => void; onClose: () => void; onPick: (id: string) => void; onNewRoom: () => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [text, setText] = useState('')
  const close = (refocus?: boolean) => { setText(''); onClose(); if (refocus) anchor.current?.querySelector('button')?.focus() }
  const needle = text.trim().toLowerCase()
  const shown = rooms.filter((r) => !needle || r.name.toLowerCase().includes(needle))
  const pick = (id: string) => { onPick(id); close(true) }
  return (
    <span ref={anchor} className="cmp-branch-anchor">
      <WhereButton label={`Room: ${room?.name ?? 'none'}`} open={open} disabled={disabled} onClick={onToggle}>
        <RoomIcon room={room} size={16} /><span className="ellipsis">{room?.name}</span>
      </WhereButton>
      {open && (
        <WherePop anchorRef={anchor} label="Room" width={248} onClose={close} focusFirst={false}
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

const MODES: { id: WorkspaceMode; label: string; hint: string; icon: 'fork' | 'computer' }[] = [
  { id: 'worktree', label: 'Worktree', hint: 'Its own branch and copy of the files', icon: 'fork' },
  { id: 'current', label: 'Local', hint: 'Works in your checkout, files and branch are shared', icon: 'computer' }
]

/**
 * Worktree or Local, two rows with a line under each. The Lead's own chat is always a worktree (KERNEL-405), so this tells Kernel how its
 * teammates should run. The default is Settings, Workspaces' mode.
 */
export function ModePicker({ mode, open, disabled, onToggle, onClose, onPick }: { mode: WorkspaceMode; open: boolean; disabled?: boolean; onToggle: () => void; onClose: () => void; onPick: (m: WorkspaceMode) => void }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const close = (refocus?: boolean) => { onClose(); if (refocus) anchor.current?.querySelector('button')?.focus() }
  const now = MODES.find((m) => m.id === mode) ?? MODES[0]
  return (
    <span ref={anchor} className="cmp-branch-anchor">
      <WhereButton label={`Work as: ${now.label}`} open={open} disabled={disabled} onClick={onToggle}>
        <Icon name={now.icon} size={14} />{now.label}
      </WhereButton>
      {open && (
        <WherePop anchorRef={anchor} label="Worktree or Local" width={340} onClose={close}>
          {MODES.map((m) => (
            <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === mode} className="menu-item where-row where-mode" onClick={() => { onPick(m.id); close(true) }}>
              <Icon name={m.icon} size={16} />
              <span className="where-tx"><span className="where-t">{m.label}</span><span className="where-d">{m.hint}</span></span>
              {m.id === mode && <Icon name="check" size={14} />}
            </button>
          ))}
        </WherePop>
      )}
    </span>
  )
}
