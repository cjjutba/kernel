import { useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import { call } from '../../api'
import { actions, loadWorkspace, useStore } from '../../store'
import { Icon, IconButton, Menu } from '../../ui'
import { attempt } from './MessageActions'

export const fileTab = (path: string) => `file:${path}`
const base = (path: string) => path.split('/').pop() ?? path

/**
 * The row of chat and file tabs, with the new tab menu and the Checkpoints button.
 * KERNEL-12 replaces this file with rename, close, fork and the terminal tab. KERNEL-13 draws the drawer the Checkpoints button opens.
 */
export function ChatTabs({ workspaceId, chats, files, active, onSelect, onCloseFile }: {
  workspaceId: string; chats: Chat[]; files: string[]; active?: string; onSelect: (tab: string) => void; onCloseFile: (path: string) => void
}) {
  const [menu, setMenu] = useState<null | 'new' | 'tab'>(null)
  const newAnchor = useRef<HTMLSpanElement>(null)
  const tabAnchor = useRef<HTMLSpanElement>(null)
  const checkpoints = useStore((s) => s.ui.workspace.checkpoints)
  const create = (kind: 'chat' | 'terminal') => attempt('Could not open a tab', async () => {
    const c = await call('chats.create', { workspaceId, kind })
    await loadWorkspace(workspaceId)
    onSelect(c.id)
  })
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
          return (
            <span key={t.id} className="tab-group hv">
              <button type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} id={`ws-tab-${t.id}`} className="ws-tab" onClick={() => onSelect(t.id)} onKeyDown={(e) => arrow(e, t.id)}>
                <Icon name={t.kind === 'terminal' ? 'term' : t.kind === 'file' ? 'doc' : 'chat'} size={14} />
                <span className="ellipsis">{t.title}</span>
              </button>
              {t.kind === 'chat' && on && (
                <span ref={tabAnchor} style={{ position: 'relative', alignSelf: 'center', marginLeft: -8 }}>
                  <IconButton className="tab-caret" icon="chevron" size={11} label="Tab options" aria-haspopup="menu" aria-expanded={menu === 'tab'} onClick={() => setMenu(menu === 'tab' ? null : 'tab')} />
                  {menu === 'tab' && (
                    <Menu label="Tab options" anchorRef={tabAnchor} onClose={() => setMenu(null)} style={{ left: 0, top: 'calc(100% + 6px)', width: 220 }}
                      items={[{ id: 'close', label: 'Close tab', onSelect: () => void attempt('Could not close the tab', async () => { await call('chats.close', { chatId: t.id }); await loadWorkspace(workspaceId) }) }]} />
                  )}
                </span>
              )}
              {t.path && <IconButton className="tab-caret more" icon="close" size={11} label={`Close ${t.title}`} style={{ alignSelf: 'center', marginLeft: -8 }} onClick={() => onCloseFile(t.path!)} />}
            </span>
          )
        })}
      </div>
      <span ref={newAnchor} style={{ position: 'relative', alignSelf: 'center', marginLeft: 4 }}>
        <IconButton icon="plus" size={14} label="New tab" aria-haspopup="menu" aria-expanded={menu === 'new'} onClick={() => setMenu(menu === 'new' ? null : 'new')} />
        {menu === 'new' && (
          <Menu label="New tab" anchorRef={newAnchor} onClose={() => setMenu(null)} style={{ left: 0, top: 'calc(100% + 6px)', width: 220 }} items={[
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
