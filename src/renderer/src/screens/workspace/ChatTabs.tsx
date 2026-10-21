import { useEffect, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import { call } from '../../api'
import { actions, getState, loadWorkspace, useStore } from '../../store'
import { FileIcon } from '../../components/FileIcon'
import { isUnread } from '../../components/sidebar/unread'
import { chatGlyph } from '../../components/sidebar/workspaceGlyph'
import { Icon, IconButton, Menu, MENU_SEPARATOR, Spinner, type IconName } from '../../ui'
import { closeChats, closesThread } from './ConfirmCloseChats'
import { archiveChatFromSidebar } from './archiveChat'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { kindFile, sharedTab } from './shared/shared'
import { attempt } from './MessageActions'
import { focusComposerIn, focusComposerWhenOpen } from './composer/bus'
import { newChatTab, tabAfterKey, tabStop } from './leadNoChat'

export const fileTab = (path: string) => `file:${path}`
/** An empty path is the diff of every changed file. */
export const diffTab = (path: string) => `diff:${path}`
const base = (path: string) => path.split('/').pop() ?? path

/**
 * The row of chat, terminal, file, diff, shared file, image and text tabs, with the new tab menu, the chat tab menu on right-click (rename, fork, close, close others),
 * a close button on hover. The new tab menu lists Chat and Terminal, which runs the preset chosen in Settings, Big terminal.
 * In the Lead's workspace `chats` are the tabs of the chat on screen (`threadId`), and a new tab joins that chat (KERNEL-338).
 */
export function ChatTabs({ inline, note, branch, tip, workspaceId, threadId, noChat, onNewChat, chats, files, diffs, shared, images, texts, active, onSelect, onCloseFile, onCloseDiff, onCloseShared, onCloseImage, onCloseText }: {
  /** The tabs sit in the header row, after the project, and not in a row of their own. */ inline?: boolean; /** What the workspace follows ("latest main", "current branch · main"), said in a chat tab's hover card. */ note?: string; /** The branch a Build here chat works on, shown beside the open chat tab's title. */ branch?: string; /** A teammate's branch: the open chat tab's hover card names it (Pen 9.15, HeaderBranchTooltip). */ tip?: string; workspaceId: string; /** The Lead chat on screen. A new chat tab joins it. Unset outside the Lead's workspace. */ threadId?: string
  /** The Lead's workspace shows New chat, so a new tab is that box and starts no chat (KERNEL-366). */ noChat?: boolean; /** Switches the screen to that box when another tab is showing. */ onNewChat?: () => void; chats: Chat[]; files: string[]; diffs: string[]; shared: string[]; images: { id: string; name: string }[]; texts: { id: string; name: string }[]; active?: string
  onSelect: (tab: string) => void; onCloseFile: (path: string) => void; onCloseDiff: (path: string) => void; onCloseShared: (sharedId: string) => void; onCloseImage: (id: string) => void; onCloseText: (id: string) => void
}) {
  const menu = useStore((s) => s.ui.menu)
  const newAnchor = useRef<HTMLSpanElement>(null)
  const tabAnchor = useRef<HTMLSpanElement>(null)
  const approvals = useStore((s) => s.approvals)
  const sharedFiles = useStore((s) => s.shared)
  // Only this workspace's tabs: another chat starting or stopping leaves the strip alone.
  const running = useStore((s) => Object.fromEntries(chats.filter((c) => s.running[c.id]).map((c) => [c.id, true])))
  const [renaming, setRenaming] = useState<string | null>(null)
  const terminal = useStore((s) => s.settings?.terminal)
  // Main refuses a terminal tab while the big terminal is off, so neither the menu nor ⌘⇧T offers one then.
  const terminalOn = terminal?.enabled === true
  const closeMenu = () => actions.ui.closeMenu()

  /** With no chat open, + and ⌘T put the caret in the New chat box, whichever tab is showing (a terminal, file, diff or shared tab gives way to it). */
  const newTab = () => {
    closeMenu()
    return newChatTab(!!noChat, () => { onNewChat?.(); focusComposerIn(workspaceId) }, () => create('chat'))
  }

  /** A terminal tab sends no preset, so main opens the one chosen in Settings, Big terminal, or Claude when that one is gone. */
  const create = (kind: 'chat' | 'terminal') => attempt('Could not open a tab', async () => {
    closeMenu()
    const c = await call('chats.create', { workspaceId, kind, ...(kind === 'chat' && threadId ? { threadId } : {}) })
    await loadWorkspace(workspaceId)
    if (kind === 'chat') focusComposerWhenOpen(c.id)
    onSelect(c.id)
  })
  // Closing stops the chat's session, so a chat that is still running asks first (ConfirmCloseChats.tsx). In a Lead chat only closing its last tab asks,
  // since that closes the chat (KERNEL-338); another tab closes at once.
  const close = (ids: string[]) => {
    closeMenu()
    // Closing a Lead chat's last tab archives the chat, the way its row's Archive does, and asks first when that would stop something (KERNEL-405).
    const whole = closesThread(getState(), workspaceId, ids)
    const ws = getState().workspaces.find((w) => w.id === workspaceId)
    if (whole && ws && isLeadChatWorkspace(ws)) return attempt('Could not archive the chat', () => archiveChatFromSidebar(whole))
    const asks = !threadId || !!whole
    if (asks && ids.some((id) => getState().running[id])) return actions.ui.openModal({ name: 'confirm', kind: 'closeChats', workspaceId, chatIds: ids })
    return attempt(ids.length > 1 ? 'Could not close the other tabs' : 'Could not close the tab', () => closeChats(workspaceId, ids, active, onSelect, tabs.map((t) => t.id)))
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
    focusComposerWhenOpen(c.id)
    onSelect(c.id)
  })
  const rename = (id: string, title: string) => {
    setRenaming(null)
    const was = chats.find((c) => c.id === id)?.title
    if (!title.trim() || title.trim() === was) return
    void attempt('Could not rename the tab', async () => { await call('chats.rename', { chatId: id, title: title.trim() }); await loadWorkspace(workspaceId) })
  }

  // Cmd+T new tab, Cmd+Shift+T big terminal, Cmd+W close the open tab. The main process hands Cmd+W over as a window event,
  // because the default menu would close the window first.
  const latest = useRef({ create, newTab, close, onCloseFile, onCloseDiff, onCloseShared, onCloseImage, onCloseText, active, chats, terminalOn })
  latest.current = { create, newTab, close, onCloseFile, onCloseDiff, onCloseShared, onCloseImage, onCloseText, active, chats, terminalOn }
  useEffect(() => {
    const closeActive = () => {
      const { active: a, chats: cs, close: c, onCloseFile: f, onCloseDiff: dif, onCloseShared: shr, onCloseImage: img, onCloseText: txt } = latest.current
      if (!a) return
      if (a.startsWith('file:')) f(a.slice(5))
      else if (a.startsWith('diff:')) dif(a.slice(5))
      else if (a.startsWith('shared:')) shr(a.slice(7))
      else if (a.startsWith('image:')) img(a)
      else if (a.startsWith('text:')) txt(a)
      else if (cs.some((x) => x.id === a)) void c([a])
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return
      const k = e.key.toLowerCase()
      if (k === 't') {
        e.preventDefault()
        if (!e.shiftKey) void latest.current.newTab()
        else if (latest.current.terminalOn) void latest.current.create('terminal')
      }
      else if (k === 'w' && !e.shiftKey) { e.preventDefault(); closeActive() }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('kernel:close-tab', closeActive)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('kernel:close-tab', closeActive) }
  }, [])

  // Arrow keys move between tabs, like Tabs in ui/controls.tsx. Only the selected tab is in the tab order.
  const arrow = (e: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const next = tabAfterKey(tabs.map((t) => t.id), id, e.key)
    if (!next) return
    e.preventDefault()
    onSelect(next)
    requestAnimationFrame(() => document.getElementById(`ws-tab-${next}`)?.focus())
  }
  const tabs: { id: string; title: string; kind: 'chat' | 'file' | 'diff' | 'shared' | 'image' | 'text' | 'terminal'; path?: string; icon?: IconName; file?: string; unread?: boolean }[] = [
    ...chats.map((c, i) => ({ id: c.id, title: i === 0 && c.autoTitle && c.title === 'New tab' ? 'New chat' : c.title, kind: c.kind === 'terminal' ? 'terminal' as const : 'chat' as const, unread: c.kind === 'chat' && isUnread(c) })),
    ...files.map((p) => ({ id: fileTab(p), title: base(p), kind: 'file' as const, path: p, file: p })),
    ...diffs.map((p) => ({ id: diffTab(p), title: p ? base(p) : 'All changes', kind: 'diff' as const, path: p, file: p || undefined })),
    ...shared.map((id) => ({ id: sharedTab(id), title: sharedFiles[id]?.title ?? 'Shared file', kind: 'shared' as const, file: kindFile[sharedFiles[id]?.kind ?? 'markdown'] })),
    ...images.map((i) => ({ id: i.id, title: i.name, kind: 'image' as const })),
    ...texts.map((t) => ({ id: t.id, title: t.name, kind: 'text' as const }))
  ]
  const stop = tabStop(tabs.map((t) => t.id), active)
  return (
    <div className="ws-tabs" data-inline={inline || undefined}>
      <div role="tablist" aria-label="Chats and files" className="row gap-2" style={{ alignItems: 'flex-end', minWidth: 0 }}>
        {tabs.map((t) => {
          const on = t.id === active
          const editing = renaming === t.id
          // A chat tab's icon shows the chat's state, like its sidebar row. The other kinds keep their own icon.
          const g = t.kind === 'chat' ? chatGlyph({ waiting: approvals.filter((a) => a.chatId === t.id && a.status === 'pending'), running: !!running[t.id] }) : undefined
          // A reply you haven't seen bolds the title. The tab on screen is read, and the chat view is asking main to say so (KERNEL-508).
          const unread = !!t.unread && !on
          const name = [t.title, g?.label || undefined, unread ? 'Unread' : undefined].filter(Boolean).join(', ')
          return (
            <span key={t.id} ref={on ? tabAnchor : undefined} className="tab-group" data-on={on || undefined}>
              {editing ? (
                <input className="tab-rename" aria-label="Tab name" autoFocus defaultValue={t.title} maxLength={60}
                  onFocus={(e) => e.currentTarget.select()} onBlur={(e) => rename(t.id, e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(t.id, e.currentTarget.value); else if (e.key === 'Escape') setRenaming(null) }} />
              ) : (
                <button type="button" role="tab" aria-selected={on} tabIndex={t.id === stop ? 0 : -1} id={`ws-tab-${t.id}`} className="ws-tab" data-tip={tip && on && t.kind === 'chat' ? tip : t.title} data-tip-hint={t.kind === 'chat' ? (tip && on ? t.title : note) : undefined} data-tip-align={tip && on && t.kind === 'chat' ? 'start' : undefined} data-unread={unread || undefined} onClick={() => onSelect(t.id)}
                  aria-label={g?.label || unread ? name : undefined} aria-haspopup={t.kind === 'chat' ? 'menu' : undefined} aria-expanded={t.kind === 'chat' && on ? menu === 'tab' : undefined}
                  onKeyDown={(e) => { if (t.kind === 'chat' && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) { e.preventDefault(); openTabMenu(t.id) } else arrow(e, t.id) }}
                  onContextMenu={(e) => { if (t.kind !== 'chat') return; e.preventDefault(); openTabMenu(t.id) }}
                  onDoubleClick={() => (t.kind === 'chat' || t.kind === 'terminal') && setRenaming(t.id)}>
                  {/* A fixed slot, so a truncated title can't shrink the icon and every tab lines up. */}
                  <span className="tab-glyph" data-tone={g?.tone} data-tip={g?.label || undefined} aria-hidden="true">
                    {g?.icon === 'spin' ? <Spinner label={null} pattern="twinkle" /> : !g && t.file ? <FileIcon path={t.file} size={14} /> : <Icon name={g?.icon ?? t.icon ?? (t.kind === 'terminal' ? 'term' : t.kind === 'file' || t.kind === 'diff' || t.kind === 'text' ? 'doc' : t.kind === 'image' ? 'image' : 'chat')} size={14} />}
                  </span>
                  <span className="ellipsis">{t.title}</span>
                  {branch && on && t.kind === 'chat' && <span className="tab-branch mono ellipsis"><Icon name="branch" size={12} />{branch}</span>}
                </button>
              )}
              {/* One slot after the title: the open tab shows its close button, and another tab shows it on hover or keyboard focus. */}
              {!editing && (
                <span className="tab-end">
                  <IconButton className="tab-caret more" icon="close" size={12} label={`Close ${t.title}`} data-tip-kbd={on ? '⌘W' : undefined}
                    onClick={() => (t.kind === 'file' && t.path ? onCloseFile(t.path) : t.kind === 'diff' ? onCloseDiff(t.path ?? '') : t.kind === 'shared' ? onCloseShared(t.id.slice(7)) : t.kind === 'image' ? onCloseImage(t.id) : t.kind === 'text' ? onCloseText(t.id) : void close([t.id]))} />
                </span>
              )}
              {t.kind === 'chat' && on && menu === 'tab' && (
                <Menu label="Tab options" anchorRef={tabAnchor} onClose={closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 220 }} items={[
                  { id: 'rename', label: 'Rename', icon: 'pen', onSelect: () => { closeMenu(); setRenaming(t.id) } },
                  { id: 'fork', label: 'Fork into new tab', icon: 'fork', onSelect: () => void fork(t.id) },
                  MENU_SEPARATOR,
                  { id: 'close', label: 'Close tab', icon: 'close', shortcut: '⌘W', onSelect: () => void close([t.id]) },
                  { id: 'others', label: 'Close other tabs', icon: 'xCircle', disabled: chats.length < 2, onSelect: () => void close(chats.filter((c) => c.id !== t.id).map((c) => c.id)) },
                  { id: 'right', label: 'Close tabs to the right', icon: 'arrowRight', disabled: !chats.slice(chats.findIndex((c) => c.id === t.id) + 1).length, onSelect: () => void close(chats.slice(chats.findIndex((c) => c.id === t.id) + 1).map((c) => c.id)) }
                ]} />
              )}
            </span>
          )
        })}
      </div>
      <span ref={newAnchor} className="tab-new">
        <IconButton icon="plus" size={14} label="New tab" aria-haspopup="menu" aria-expanded={menu === 'newTab'} onClick={() => actions.ui.toggleMenu('newTab')} />
        {menu === 'newTab' && (
          <Menu label="New tab" anchorRef={newAnchor} onClose={closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 200 }} items={[
            { id: 'chat', label: 'Chat', icon: 'chat' as const, shortcut: '⌘T', onSelect: () => void newTab() },
            ...(terminalOn ? [{ id: 'terminal', label: 'Terminal', icon: 'term' as const, shortcut: '⌘⇧T', onSelect: () => void create('terminal') }] : [])
          ]} />
        )}
      </span>
    </div>
  )
}
