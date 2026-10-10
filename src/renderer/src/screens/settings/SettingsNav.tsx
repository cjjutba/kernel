import './settings.css'
import { useEffect, useState } from 'react'
import type { SettingsPage } from '@shared/types'
import { actions, getState, go, useStore } from '../../store'
import { roomLetter } from '../rooms/roomInfo'
import { Icon } from '../../ui'

export const GROUPS: { title: string; items: { page: SettingsPage; label: string; icon: string }[] }[] = [
  { title: 'Personal', items: [
    { page: 'general', label: 'General', icon: 'sliders' }, { page: 'appearance', label: 'Appearance', icon: 'half' },
    { page: 'notifications', label: 'Notifications', icon: 'bell' }, { page: 'account', label: 'Account and usage', icon: 'user' },
    { page: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' }
  ] },
  { title: 'Agents', items: [
    { page: 'models', label: 'Models and effort', icon: 'chip' }, { page: 'agents', label: 'Agents', icon: 'team' },
    { page: 'permissions', label: 'Permissions', icon: 'shield' }, { page: 'skills', label: 'Skills and MCP', icon: 'sparkle' }
  ] },
  { title: 'Workspaces', items: [
    { page: 'git', label: 'Git and worktrees', icon: 'branch' }, { page: 'scripts', label: 'Scripts', icon: 'term' },
    { page: 'prs', label: 'Pull requests', icon: 'pr' }, { page: 'files', label: 'Files to copy', icon: 'copy' }
  ] },
  { title: 'System', items: [
    { page: 'hooks', label: 'Hooks', icon: 'plug' }, { page: 'integrations', label: 'Integrations', icon: 'link' },
    { page: 'experimental', label: 'Experimental', icon: 'flask' }, { page: 'about', label: 'About', icon: 'info' }
  ] }
]

/** A field you type into: Escape belongs to it, not to the page. */
const isTextField = (el: HTMLElement) =>
  el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|range|color|file)$/.test(el.type))

/** The left column of Settings: back to the app, search, and every page. Search filters the list by name. */
export function SettingsNav({ page, roomId }: { page: SettingsPage; roomId?: string }) {
  const [q, setQ] = useState('')
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
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => match(i.label)) })).filter((g) => g.items.length)
  const shownRooms = rooms.filter((r) => match(r.name))
  return (
    <nav aria-label="Settings" className="set-nav">
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
          {shownRooms.map((r) => (
            <button key={r.id} type="button" className="nav-item set-item" aria-current={page === 'room' && roomId === r.id ? 'page' : undefined} onClick={() => go({ name: 'settings', page: 'room', roomId: r.id })}>
              <span className="set-letter" aria-hidden="true">{roomLetter(r.name)}</span>{r.name}
            </button>
          ))}
        </div>
      )}
      {!groups.length && !shownRooms.length && <p className="set-group">No settings match</p>}
    </nav>
  )
}
