import './settings.css'
import { useEffect, useRef, useState } from 'react'
import type { RoomSettingsSection, SettingsPage } from '@shared/types'
import { actions, getState, go, useStore } from '../../store'
import { RoomIcon } from '../../components/RoomIcon'
import { Icon } from '../../ui'
import { ROOM_PAGES } from './roomPages'

export const GROUPS: { title: string; items: { page: SettingsPage; label: string; icon: string }[] }[] = [
  { title: 'Personal', items: [
    { page: 'general', label: 'General', icon: 'sliders' }, { page: 'appearance', label: 'Appearance', icon: 'half' },
    { page: 'notifications', label: 'Notifications', icon: 'bell' }, { page: 'account', label: 'Account and usage', icon: 'user' },
    { page: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' }
  ] },
  { title: 'Agents', items: [
    { page: 'models', label: 'Models and effort', icon: 'chip' }, { page: 'permissions', label: 'Permissions', icon: 'shield' }, { page: 'env', label: 'Environment', icon: 'env' }
  ] },
  { title: 'Workspaces', items: [
    { page: 'git', label: 'Git and worktrees', icon: 'branch' }, { page: 'scripts', label: 'Scripts', icon: 'term' },
    { page: 'prs', label: 'Pull requests', icon: 'pr' }
  ] },
  { title: 'System', items: [
    { page: 'hooks', label: 'Hooks', icon: 'plug' }, { page: 'integrations', label: 'Integrations', icon: 'link' },
    { page: 'experimental', label: 'Experimental', icon: 'flask' }, { page: 'about', label: 'About', icon: 'info' }
  ] }
]

/** A field you type into: Escape belongs to it, not to the page. */
const isTextField = (el: HTMLElement) =>
  el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|range|color|file)$/.test(el.type))

/** The room whose pages were open last, so the room stays expanded when you move to an app page. */
let lastRoomId: string | undefined

/**
 * The left column of Settings: back to the app, search, the app pages, and each room with its own pages under it.
 * Search filters the list by name. The nav scrolls, and the open page scrolls into view.
 */
export function SettingsNav({ page, roomId, section }: { page: SettingsPage; roomId?: string; section?: RoomSettingsSection }) {
  const [q, setQ] = useState('')
  const [folded, setFolded] = useState<string | null>(null)
  const nav = useRef<HTMLElement>(null)
  if (page === 'room' && roomId) lastRoomId = roomId
  const rooms = useStore((s) => s.rooms.filter((r) => !r.hidden && !r.archived))
  const match = (label: string) => !q.trim() || label.toLowerCase().includes(q.trim().toLowerCase())
  // Escape: the search box clears first. Other text fields keep it for themselves, and elsewhere it leaves Settings.
  // Menus and modals take Escape before it gets here, so it only counts when none is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      const { modal, menu } = getState().ui
      if (modal || menu) return
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el?.id === 'set-q' && q) { e.preventDefault(); setQ(''); return }
      if (el && el.id !== 'set-q' && isTextField(el)) return
      e.preventDefault()
      actions.ui.leaveSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [q])
  // A room's pages run past the bottom of the window, so a room page brings the end of its room into view, then the open page.
  useEffect(() => {
    if (page !== 'room') return
    nav.current?.querySelector('[data-room-end]')?.scrollIntoView({ block: 'nearest' })
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [page, roomId, section])
  useEffect(() => setFolded(null), [page, roomId])
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => match(i.label)) })).filter((g) => g.items.length)
  // The room you are in is expanded. On an app page, it is the one you were in last, or the first.
  const open = rooms.find((r) => r.id === (page === 'room' ? roomId : lastRoomId))?.id ?? rooms[0]?.id
  const searching = !!q.trim()
  // A search that matches a room's name shows all its pages, and one that matches a page name shows that page.
  const shownRooms = rooms.map((r) => ({ room: r, pages: match(r.name) ? ROOM_PAGES : ROOM_PAGES.filter((p) => match(p.label)) })).filter((r) => r.pages.length)
  const here = (id: string, s: RoomSettingsSection) => page === 'room' && roomId === id && (section ?? 'general') === s
  return (
    <nav ref={nav} aria-label="Settings" className="set-nav">
      <div className="drag" style={{ height: 42, flexShrink: 0 }} />
      <button type="button" className="set-back" onClick={() => actions.ui.leaveSettings()}><Icon name="left" size={14} />Back to app</button>
      <div className="set-search">
        <label htmlFor="set-q" className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Search settings</label>
        <Icon name="search" size={14} />
        <input id="set-q" type="text" autoComplete="off" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.map((g) => (
        <div key={g.title}>
          <p className="set-group">{g.title}</p>
          {g.items.map((i) => (
            <button key={i.page} type="button" className="nav-item set-item" aria-current={page === i.page ? 'page' : undefined} onClick={() => go({ name: 'settings', page: i.page })}>
              <Icon name={i.icon} size={15} />{i.label}
            </button>
          ))}
        </div>
      ))}
      {shownRooms.length > 0 && (
        <div>
          <p className="set-group">Rooms</p>
          {shownRooms.map(({ room: r, pages }) => {
            const expanded = searching ? true : open === r.id && folded !== r.id
            return (
              <div key={r.id}>
                <button type="button" className="nav-item set-item set-room" aria-expanded={expanded} onClick={() => {
                  // Another room opens on its General page. Its own row folds and unfolds its pages.
                  if (open === r.id && page === 'room' && roomId === r.id) setFolded(expanded ? r.id : null)
                  else { setFolded(null); go({ name: 'settings', page: 'room', roomId: r.id }) }
                }}>
                  <RoomIcon room={r} className="set-letter" /><span className="grow">{r.name}</span><Icon name={expanded ? 'chevron' : 'right'} size={10} stroke={1.9} />
                </button>
                {expanded && pages.map((p, n) => (
                  <button key={p.section} data-room-end={n === pages.length - 1 && open === r.id ? '' : undefined} type="button" className="nav-item set-item set-sub" aria-current={here(r.id, p.section) ? 'page' : undefined} onClick={() => go({ name: 'settings', page: 'room', roomId: r.id, section: p.section })}>{p.label}</button>
                ))}
              </div>
            )
          })}
        </div>
      )}
      {!groups.length && !shownRooms.length && <p className="set-group">No settings match</p>}
    </nav>
  )
}
