import { useEffect, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import { call } from '../../api'
import { actions, getState, loadWorkspace, useStore } from '../../store'
import { chatGlyph } from '../../components/sidebar/workspaceGlyph'
import { Icon, IconButton, Menu } from '../../ui'
import { closeChats } from './ConfirmCloseChats'
import { attempt } from './MessageActions'

export const fileTab = (path: string) => `file:${path}`
/** An empty path is the diff of every changed file. */
export const diffTab = (path: string) => `diff:${path}`
const base = (path: string) => path.split('/').pop() ?? path

/**
 * The row of chat, terminal, file, diff, image and text tabs, with the new tab menu, the chat tab menu on right-click (rename, fork, close, close others),
 * a close button on hover and the Checkpoints button.
 * The drawer it opens is `checkpoints/Checkpoints.tsx`.
 */
export function ChatTabs({ workspaceId, chats, files, diffs, images, texts, active, onSelect, onCloseFile, onCloseDiff, onCloseImage, onCloseText }: {
  workspaceId: string; chats: Chat[]; files: string[]; diffs: string[]; images: { id: string; name: string }[]; texts: { id: string; name: string }[]; active?: string
  onSelect: (tab: string) => void; onCloseFile: (path: string) => void; onCloseDiff: (path: string) => void; onCloseImage: (id: string) => void; onCloseText: (id: string) => void
}) {
  const menu = useStore((s) => s.ui.menu)
  const newAnchor = useRef<HTMLSpanElement>(null)
  const tabAnchor = useRef<HTMLSpanElement>(null)
  const checkpoints = useStore((s) => s.ui.workspace.checkpoints)
  const approvals = useStore((s) => s.approvals)
  const running = useStore((s) => s.running)
  const [renaming, setRenaming] = useState<string | null>(null)
  const closeMenu = () => actions.ui.closeMenu()

  const create = (kind: 'chat' | 'terminal') => attempt('Could not open a tab', async () => {
    closeMenu()
    const c = await call('chats.create', { workspaceId, kind })
    await loadWorkspace(workspaceId)
    onSelect(c.id)
  })
  // Closing stops the chat's session, so a chat that is still running asks first (ConfirmCloseChats.tsx).
  const close = (ids: string[]) => {
    closeMenu()
    if (ids.some((id) => getState().running[id])) return actions.ui.openModal({ name: 'confirm', kind: 'closeChats', workspaceId, chatIds: ids })
    return attempt(ids.length > 1 ? 'Could not close the other tabs' : 'Could not close the tab', () => closeChats(workspaceId, ids, active, onSelect))
  }
  // The menu belongs to the open tab, so right-clicking another chat opens it first.
  const openTabMenu = (id: string) => {
    if (id !== active) onSelect(id)
    if (menu !== 'tab') actions.ui.toggleMenu('tab')
  }
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
  const latest = useRef({ create, close, onCloseFile, onCloseDiff, onCloseImage, onCloseText, active, chats })
  latest.current = { create, close, onCloseFile, onCloseDiff, onCloseImage, onCloseText, active, chats }
  useEffect(() => {
    const closeActive = () => {
      const { active: a, chats: cs, close: c, onCloseFile: f, onCloseDiff: dif, onCloseImage: img, onCloseText: txt } = latest.current
      if (!a) return
      if (a.startsWith('file:')) f(a.slice(5))
      else if (a.startsWith('diff:')) dif(a.slice(5))
      else if (a.startsWith('image:')) img(a)
      else if (a.startsWith('text:')) txt(a)
      else if (cs.some((x) => x.id === a)) void c([a])
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
  const tabs: { id: string; title: string; kind: 'chat' | 'file' | 'diff' | 'image' | 'text' | 'terminal'; path?: string }[] = [
    ...chats.map((c) => ({ id: c.id, title: c.title, kind: c.kind === 'terminal' ? 'terminal' as const : 'chat' as const })),
    ...files.map((p) => ({ id: fileTab(p), title: base(p), kind: 'file' as const, path: p })),
    ...diffs.map((p) => ({ id: diffTab(p), title: p ? base(p) : 'All changes', kind: 'diff' as const, path: p })),
    ...images.map((i) => ({ id: i.id, title: i.name, kind: 'image' as const })),
    ...texts.map((t) => ({ id: t.id, title: t.name, kind: 'text' as const }))
  ]
  return (
    <div className="ws-tabs">
      <div role="tablist" aria-label="Chats and files" className="row" style={{ gap: 2, alignItems: 'flex-end', minWidth: 0 }}>
        {tabs.map((t) => {
          const on = t.id === active
          const editing = renaming === t.id
          // A chat tab's icon shows the chat's state, like its sidebar row. The other kinds keep their own icon.
          const g = t.kind === 'chat' ? chatGlyph({ waiting: approvals.filter((a) => a.chatId === t.id && a.status === 'pending'), running: !!running[t.id] }) : undefined
          return (
            <span key={t.id} ref={on ? tabAnchor : undefined} className="tab-group" data-on={on || undefined}>
              {editing ? (
                <input className="tab-rename" aria-label="Tab name" autoFocus defaultValue={t.title} maxLength={60}
                  onFocus={(e) => e.currentTarget.select()} onBlur={(e) => rename(t.id, e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(t.id, e.currentTarget.value); else if (e.key === 'Escape') setRenaming(null) }} />
              ) : (
                <button type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} id={`ws-tab-${t.id}`} className="ws-tab" data-tip={t.title} onClick={() => onSelect(t.id)}
                  aria-label={g?.label ? `${t.title}, ${g.label}` : undefined} aria-haspopup={t.kind === 'chat' ? 'menu' : undefined} aria-expanded={t.kind === 'chat' && on ? menu === 'tab' : undefined}
                  onKeyDown={(e) => { if (t.kind === 'chat' && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) { e.preventDefault(); openTabMenu(t.id) } else arrow(e, t.id) }}
                  onContextMenu={(e) => { if (t.kind !== 'chat') return; e.preventDefault(); openTabMenu(t.id) }}
                  onDoubleClick={() => (t.kind === 'chat' || t.kind === 'terminal') && setRenaming(t.id)}>
                  {/* A fixed slot, so a truncated title can't shrink the icon and every tab lines up. */}
                  <span className="tab-glyph" data-tone={g?.tone} data-tip={g?.label || undefined} aria-hidden="true">
                    {g?.icon === 'spin' ? <span className="spin" /> : <Icon name={g?.icon ?? (t.kind === 'terminal' ? 'term' : t.kind === 'file' || t.kind === 'diff' || t.kind === 'text' ? 'doc' : t.kind === 'image' ? 'image' : 'chat')} size={14} />}
                  </span>
                  <span className="ellipsis">{t.title}</span>
                </button>
              )}
              {/* One slot after the title: the open chat shows a pen at rest, and hover or keyboard focus swaps it for the close button (D-088). */}
              {!editing && (
                <span className="tab-end">
                  {t.kind === 'chat' && on && <span className="tab-pen"><Icon name="pen" size={12} /></span>}
                  <IconButton className="tab-caret more" icon="close" size={11} label={`Close ${t.title}`} data-tip-kbd={on ? '⌘W' : undefined}
                    onClick={() => (t.kind === 'file' && t.path ? onCloseFile(t.path) : t.kind === 'diff' ? onCloseDiff(t.path ?? '') : t.kind === 'image' ? onCloseImage(t.id) : t.kind === 'text' ? onCloseText(t.id) : void close([t.id]))} />
                </span>
              )}
              {t.kind === 'chat' && on && menu === 'tab' && (
                <Menu label="Tab options" anchorRef={tabAnchor} onClose={closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 220 }} items={[
                  { id: 'rename', label: 'Rename', onSelect: () => { closeMenu(); setRenaming(t.id) } },
                  { id: 'fork', label: 'Fork into new chat', onSelect: () => void fork(t.id) },
                  { id: 'close', label: 'Close tab', shortcut: '⌘W', onSelect: () => void close([t.id]) },
                  { id: 'others', label: 'Close other tabs', disabled: chats.length < 2, onSelect: () => void close(chats.filter((c) => c.id !== t.id).map((c) => c.id)) }
                ]} />
              )}
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
        <Icon name="history" size={14} /><span className="cp-label">Checkpoints</span>
      </button>
    </div>
  )
}
