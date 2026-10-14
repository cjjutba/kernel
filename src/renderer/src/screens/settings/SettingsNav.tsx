import './settings.css'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyEvent } from 'react'
import type { RoomSettingsSection, SettingsPage } from '@shared/types'
import { actions, getState, go, useStore } from '../../store'
import { RoomIcon } from '../../components/RoomIcon'
import { Icon } from '../../ui'
import { NAV, ROOM_PAGES, keywordHits, navMatch, type Keyword } from './nav'

/** The groups the sidebar lists. They live in nav.ts so search and the command palette read the same list (KERNEL-680). */
export const GROUPS = NAV

/** A field you type into: Escape belongs to it, not to the page. */
const isTextField = (el: HTMLElement) =>
  el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|range|color|file)$/.test(el.type))

/**
 * What the sidebar frame holds in Settings (KERNEL-509): back to the app, search, the app pages, and each room with its own pages under it.
 * Search filters the list by name. The top stays put; the list under it scrolls, and the open page scrolls into view there. The frame
 * (components/sidebar/Sidebar.tsx) owns the `<nav>` named Settings, the width and the resize edge, so these are its direct flex children.
 */
export function SettingsNav({ page, roomId, section }: { page: SettingsPage; roomId?: string; section?: RoomSettingsSection }) {
  const [q, setQ] = useState('')
  const [folded, setFolded] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const rooms = useStore((s) => s.rooms.filter((r) => !r.hidden && !r.archived))
  const match = (label: string, keywords?: Keyword[], terms?: string[]) => navMatch(q, label, keywords, terms)
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
  // A room's pages run past the bottom of the window, so a room page brings the end of its room and the next room's row into view, then the open page.
  useEffect(() => {
    if (page !== 'room') return
    const end = list.current?.querySelector('[data-room-end]')
    ;(end?.parentElement?.nextElementSibling?.firstElementChild ?? end)?.scrollIntoView({ block: 'nearest' })
    list.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [page, roomId, section])
  useEffect(() => setFolded(null), [page, roomId])
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => match(i.label, i.keywords, i.terms)) })).filter((g) => g.items.length)
  // Only the room whose page is open is expanded. On an app page every room is folded.
  const open = page === 'room' ? rooms.find((r) => r.id === roomId)?.id : undefined
  const searching = !!q.trim()
  // A search that matches a room's name shows all its pages, and one that matches a page name shows that page.
  const shownRooms = rooms.map((r) => ({ room: r, pages: match(r.name) ? ROOM_PAGES : ROOM_PAGES.filter((p) => match(p.label, p.keywords, p.terms)) })).filter((r) => r.pages.length)
  // A result opens its page and names the row, which Settings scrolls to, highlights and focuses (KERNEL-727).
  const found = (keywords: Keyword[], to: (row: string) => Parameters<typeof go>[0]) => keywordHits(q, keywords).map((k) => (
    <button key={k.rowId} type="button" className="nav-item set-item set-sub set-hit-item" onClick={() => go(to(k.rowId))}>{k.label}</button>
  ))
  // Arrow keys walk the results from the search box: Down enters the list, Up from the first result returns to the box.
  const walk = (e: ReactKeyEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const input = document.getElementById('set-q')
    const items = [...(list.current?.querySelectorAll<HTMLElement>('button.set-item') ?? [])]
    const from = e.target === input ? -1 : items.indexOf(e.target as HTMLElement)
    if (e.target !== input && from < 0) return
    const to = e.key === 'ArrowDown' ? items[from + 1] : from === 0 ? input : items[from - 1]
    if (!to) return
    e.preventDefault()
    to.focus()
  }
  const here = (id: string, s: RoomSettingsSection) => page === 'room' && roomId === id && (section ?? 'general') === s
  return (
    <>
      <div className="drag" style={{ height: 53, flexShrink: 0 }} />
      <button type="button" className="set-back" onClick={() => actions.ui.leaveSettings()}><Icon name="left" size={14} />Back to app</button>
      <div className="set-search">
        <label htmlFor="set-q" className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Search settings</label>
        <Icon name="search" size={14} />
        <input id="set-q" type="text" autoComplete="off" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && searching) { e.preventDefault(); list.current?.querySelector<HTMLElement>('button.set-item')?.click() } else walk(e)
        }} />
      </div>
      <div ref={list} className="set-list sb-scroll" onKeyDown={walk}>
        {groups.map((g) => (
          <div key={g.title}>
            <p className="set-group">{g.title}</p>
            {g.items.map((i) => (
              <div key={i.page}>
                <button type="button" className="nav-item set-item" aria-current={page === i.page ? 'page' : undefined} onClick={() => go({ name: 'settings', page: i.page })}>
                  <Icon name={i.icon} size={16} />{i.label}
                </button>
                {found(i.keywords, (row) => ({ name: 'settings', page: i.page, row }))}
              </div>
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
                    if (open === r.id) setFolded(expanded ? r.id : null)
                    else { setFolded(null); go({ name: 'settings', page: 'room', roomId: r.id }) }
                  }}>
                    <RoomIcon room={r} className="set-letter" /><span className="grow">{r.name}</span>
                  </button>
                  {expanded && (
                    <div className="set-pages" data-room-end={open === r.id ? '' : undefined}>
                      {pages.map((p) => (
                        <div key={p.section}>
                          <button type="button" className="nav-item set-item set-sub" aria-current={here(r.id, p.section) ? 'page' : undefined} onClick={() => go({ name: 'settings', page: 'room', roomId: r.id, section: p.section })}>
                            <Icon name={p.icon} size={16} />{p.label}
                          </button>
                          {found(p.keywords, (row) => ({ name: 'settings', page: 'room', roomId: r.id, section: p.section, row }))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {!groups.length && !shownRooms.length && <p className="set-group">No settings match</p>}
      </div>
    </>
  )
}
