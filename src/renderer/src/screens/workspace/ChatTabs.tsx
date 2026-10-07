import { useEffect, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import { call } from '../../api'
import { actions, getState, loadWorkspace, useStore } from '../../store'
import { Icon, IconButton, Menu } from '../../ui'
import { attempt } from './MessageActions'

export const fileTab = (path: string) => `file:${path}`
const base = (path: string) => path.split('/').pop() ?? path

/**
 * The row of chat, terminal and file tabs, with the new tab menu, the tab menu (rename, fork, close, close others) and the Checkpoints button.
 * KERNEL-13 draws the drawer the Checkpoints button opens.
 */
export function ChatTabs({ workspaceId, chats, files, active, onSelect, onCloseFile }: {
  workspaceId: string; chats: Chat[]; files: string[]; active?: string; onSelect: (tab: string) => void; onCloseFile: (path: string) => void
}) {
  const menu = useStore((s) => s.ui.menu)
  const newAnchor = useRef<HTMLSpanElement>(null)
  const tabAnchor = useRef<HTMLSpanElement>(null)
  const checkpoints = useStore((s) => s.ui.workspace.checkpoints)
  const [renaming, setRenaming] = useState<string | null>(null)
  const closeMenu = () => actions.ui.closeMenu()

  const create = (kind: 'chat' | 'terminal') => attempt('Could not open a tab', async () => {
    closeMenu()
    const c = await call('chats.create', { workspaceId, kind })
    await loadWorkspace(workspaceId)
    onSelect(c.id)
  })
  const close = (id: string) => attempt('Could not close the tab', async () => {
    closeMenu()
    await call('chats.close', { chatId: id })
    await loadWorkspace(workspaceId)
    if (active === id) {
      const left = getState().chats[workspaceId] ?? []
      const was = chats.findIndex((c) => c.id === id)
      const next = left[Math.min(Math.max(was - 1, 0), left.length - 1)]
      if (next) onSelect(next.id)
    }
  })
  const closeOthers = (id: string) => attempt('Could not close the other tabs', async () => {
    closeMenu()
    for (const c of chats) if (c.id !== id) await call('chats.close', { chatId: c.id })
    await loadWorkspace(workspaceId)
    onSelect(id)
  })
  const fork = (id: string) => attempt('Could not fork the chat', async () => {
    closeMenu()
    const c = await call('chats.fork', { chatId: id })
    await loadWorkspace(workspaceId)
    onSelect(c.id)
  })
  const rename = (id: string, title: string) => {
    setRenaming(null)
    const was = chats.find((c) => c.id === id)?.title
    if (!title.trim() || title.trim() === was) return
    void attempt('Could not rename the tab', async () => { await call('chats.rename', { chatId: id, title: title.trim() }); await loadWorkspace(workspaceId) })
  }

  // Cmd+T new chat, Cmd+Shift+T big terminal, Cmd+W close the open tab. The main process hands Cmd+W over as a window event,
  // because the default menu would close the window first.
  const latest = useRef({ create, close, onCloseFile, active, chats })
  latest.current = { create, close, onCloseFile, active, chats }
  useEffect(() => {
    const closeActive = () => {
      const { active: a, chats: cs, close: c, onCloseFile: f } = latest.current
      if (!a) return
      if (a.startsWith('file:')) f(a.slice(5))
      else if (cs.some((x) => x.id === a)) void c(a)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return
      const k = e.key.toLowerCase()
      if (k === 't') { e.preventDefault(); void latest.current.create(e.shiftKey ? 'terminal' : 'chat') }
      else if (k === 'w' && !e.shiftKey) { e.preventDefault(); closeActive() }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('kernel:close-tab', closeActive)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('kernel:close-tab', closeActive) }
  }, [])

  // Arrow keys move between tabs, like Tabs in ui/controls.tsx. Only the selected tab is in the tab order.
  const arrow = (e: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = tabs.findIndex((t) => t.id === id)
    const next = tabs[(i + step + tabs.length) % tabs.length]
    onSelect(next.id)
    requestAnimationFrame(() => document.getElementById(`ws-tab-${next.id}`)?.focus())
  }
  const tabs: { id: string; title: string; kind: 'chat' | 'file' | 'terminal'; path?: string }[] = [
    ...chats.map((c) => ({ id: c.id, title: c.title, kind: c.kind === 'terminal' ? 'terminal' as const : 'chat' as const })),
    ...files.map((p) => ({ id: fileTab(p), title: base(p), kind: 'file' as const, path: p }))
  ]
  return (
    <div className="ws-tabs">
      <div role="tablist" aria-label="Chats and files" className="row" style={{ gap: 2, alignItems: 'flex-end', minWidth: 0 }}>
        {tabs.map((t) => {
          const on = t.id === active
          const editing = renaming === t.id
          return (
            <span key={t.id} className="tab-group hv">
              {editing ? (
                <input className="tab-rename" aria-label="Tab name" autoFocus defaultValue={t.title} maxLength={60}
                  onFocus={(e) => e.currentTarget.select()} onBlur={(e) => rename(t.id, e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(t.id, e.currentTarget.value); else if (e.key === 'Escape') setRenaming(null) }} />
              ) : (
                <button type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} id={`ws-tab-${t.id}`} className="ws-tab" onClick={() => onSelect(t.id)} onKeyDown={(e) => arrow(e, t.id)}
                  onDoubleClick={() => t.kind !== 'file' && setRenaming(t.id)}>
                  <Icon name={t.kind === 'terminal' ? 'term' : t.kind === 'file' ? 'doc' : 'chat'} size={14} />
                  <span className="ellipsis">{t.title}</span>
                </button>
              )}
              {t.kind === 'chat' && on && !editing && (
                <span ref={tabAnchor} style={{ position: 'relative', alignSelf: 'center', marginLeft: -8 }}>
                  <IconButton className="tab-caret" icon="chevron" size={11} label="Tab options" aria-haspopup="menu" aria-expanded={menu === 'tab'} onClick={() => actions.ui.toggleMenu('tab')} />
                  {menu === 'tab' && (
                    <Menu label="Tab options" anchorRef={tabAnchor} onClose={closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 220 }} items={[
                      { id: 'rename', label: 'Rename', onSelect: () => { closeMenu(); setRenaming(t.id) } },
                      { id: 'fork', label: 'Fork into new chat', onSelect: () => void fork(t.id) },
                      { id: 'close', label: 'Close tab', shortcut: '⌘W', onSelect: () => void close(t.id) },
                      { id: 'others', label: 'Close other tabs', disabled: chats.length < 2, onSelect: () => void closeOthers(t.id) }
                    ]} />
                  )}
                </span>
              )}
              {t.kind === 'terminal' && <IconButton className="tab-caret more" icon="close" size={11} label={`Close ${t.title}`} style={{ alignSelf: 'center', marginLeft: -8 }} onClick={() => void close(t.id)} />}
              {t.path && <IconButton className="tab-caret more" icon="close" size={11} label={`Close ${t.title}`} style={{ alignSelf: 'center', marginLeft: -8 }} onClick={() => onCloseFile(t.path!)} />}
            </span>
          )
        })}
      </div>
      <span ref={newAnchor} style={{ position: 'relative', alignSelf: 'center', marginLeft: 4 }}>
        <IconButton icon="plus" size={14} label="New tab" aria-haspopup="menu" aria-expanded={menu === 'newTab'} onClick={() => actions.ui.toggleMenu('newTab')} />
        {menu === 'newTab' && (
          <Menu label="New tab" anchorRef={newAnchor} onClose={closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 220 }} items={[
            { id: 'chat', label: 'New chat', shortcut: '⌘T', onSelect: () => void create('chat') },
            { id: 'term', label: 'Big terminal', shortcut: '⌘⇧T', onSelect: () => void create('terminal') }
          ]} />
        )}
      </span>
      <span className="grow" />
      <button type="button" className="cp-btn" aria-expanded={checkpoints} aria-label="Checkpoints" onClick={() => actions.ui.setWorkspaceView({ checkpoints: !checkpoints })}>
        <Icon name="history" size={14} />Checkpoints
      </button>
    </div>
  )
}
