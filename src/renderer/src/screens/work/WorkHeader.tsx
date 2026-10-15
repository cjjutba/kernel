import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { go } from '../../store'
import { Button, Icon, IconButton, Menu, isTyping } from '../../ui'
import { RoomIcon } from '../../components/RoomIcon'
import { SidebarToggleSlot } from '../../components/PanelToggles'
import type { RoomHead } from '../issues/parts'
import { WORK_TABS, useWorkTab, type WorkTab } from './tab'
import './work.css'

const labels: Record<WorkTab, string> = { issues: 'Issues', prs: 'Pull requests' }

/** `onRoom('')` on the Pull requests tab means every room. */
export const ALL_ROOMS = ''

interface Props {
  tab: WorkTab
  head: RoomHead
  /** Pull requests only: adds "All rooms" to the picker, which is selected while `head.room` is empty. */
  allRooms?: boolean
  /** How many each tab lists, when the page knows. */
  counts?: Partial<Record<WorkTab, string | number>>
  /** Where the list comes from: "Linear · cj-jutba". */
  where?: ReactNode
  /** Reads the list again. The button is left out without it. */
  onRefresh?: () => void
  refreshing?: boolean
}

/** The other tab's route. Issues keeps the room picked on it, and Pull requests lists every room unless one was picked. */
const routeFor = (tab: WorkTab, roomId?: string) => (tab === 'issues' ? { name: 'issues' as const, roomId } : { name: 'prs' as const })

/**
 * The header of the Work page (KERNEL-874): the title, the Issues and Pull requests tabs, the room picker and, on the right, where
 * the list comes from with Refresh. Keys 1 and 2 switch the tab while focus is not in a text field.
 */
export function WorkHeader({ tab, head, allRooms, counts, where, onRefresh, refreshing }: Props) {
  const [, remember] = useWorkTab()
  // The tab is the route's name. Saving it here is what makes the sidebar's Work open on it.
  useEffect(() => remember(tab), [tab])
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const { rooms, room, onRoom } = head
  const to = (next: WorkTab) => { if (next !== tab) go(routeFor(next, room?.id)) }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e.target)) return
      if (e.key === '1' || e.key === '2') { e.preventDefault(); to(WORK_TABS[Number(e.key) - 1]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + WORK_TABS.length) % WORK_TABS.length
    to(WORK_TABS[next])
    refs.current[next]?.focus()
  }

  const pick = room ?? (allRooms ? { name: 'All rooms' } : undefined)
  return (
    <header className="header wk-head">
      <SidebarToggleSlot />
      <Icon name="issues" />
      <h1>Work</h1>
      <div className="wk-tabs" role="tablist" aria-label="Work">
        {WORK_TABS.map((t, i) => (
          <button key={t} ref={(el) => { refs.current[i] = el }} type="button" role="tab" aria-selected={t === tab} tabIndex={t === tab ? 0 : -1} data-tip-kbd={String(i + 1)} onClick={() => to(t)} onKeyDown={(e) => onTabKey(e, i)}>
            {labels[t]}{counts?.[t] !== undefined && <span className="wk-n">{counts[t]}</span>}
          </button>
        ))}
      </div>
      {pick && (
        <>
          <span className="wk-vr" aria-hidden="true" />
          <span ref={anchor} className="wk-room">
            <Button variant="ghost" className="wk-pick" aria-label={`Room: ${pick.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
              {room ? <RoomIcon room={room} className="wk-letter" fallback="?" /> : <span className="wk-letter" aria-hidden="true">A</span>}{pick.name}<Icon name="chevron" size={12} />
            </Button>
            {open && (
              <Menu label="Room" anchorRef={anchor} onClose={() => setOpen(false)} style={{ left: 0, top: 'calc(100% + 4px)' }}
                items={[
                  ...(allRooms ? [{ id: 'all', label: 'All rooms', checked: !room, onSelect: () => onRoom(ALL_ROOMS) }] : []),
                  ...rooms.map((r) => ({ id: r.id, label: r.name, checked: r.id === room?.id, onSelect: () => onRoom(r.id) }))
                ]} />
            )}
          </span>
        </>
      )}
      <span className="grow" />
      {where && <span className="wk-where">{where}</span>}
      {onRefresh && <IconButton icon="refresh" size={16} label="Refresh" busy={refreshing} busyPattern="rotate" busyLabel="Refreshing" onClick={onRefresh} />}
    </header>
  )
}
