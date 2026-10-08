import { useEffect, useMemo, useRef, useState } from 'react'
import type { Approval } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { openLead } from '../../lead'
import { Icon, Kbd, Modal } from '../../ui'
import { buildItems, visibleItems, type PaletteItem } from './model'
import './search.css'

const close = () => actions.ui.closeModal()
const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: (e as Error).message })

/** Allow the one tool request, the same call the Inbox and the floor make. */
const approve = (a: Approval) => void call('approvals.decide', { id: a.id, decision: { behavior: 'allow' } }).then(actions.approvals.upsert).catch(fail('Could not send your answer'))

/** A chat tab opens in the workspace you are in, and takes focus. */
function newChat(workspaceId: string, kind?: 'terminal') {
  void call('chats.create', { workspaceId, kind }).then((chat) => {
    actions.chats.upsert(chat)
    go({ name: 'workspace', workspaceId })
    actions.ui.setWorkspaceView({ tab: chat.id })
  }).catch(fail('Could not open the tab'))
}

/** CommandPalette.png: search and run anything, from the keyboard (⌘K). */
export function CommandPalette() {
  const route = useStore((s) => s.ui.route)
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces)
  const approvals = useStore((s) => s.approvals)
  const agents = useStore((s) => s.agents)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const { items, more } = useMemo(() => buildItems({
    route, rooms, workspaces, approvals, agents,
    act: { go, newWorkspace: (roomId) => actions.ui.openModal({ name: 'newWorkspace', roomId }), newRoom: () => actions.ui.openModal({ name: 'newRoom' }), whatsNew: () => actions.ui.openModal({ name: 'whatsNew' }), approve, newChat, openLead: (roomId) => void openLead(roomId) }
  }), [route, rooms, workspaces, approvals, agents])
  const groups = useMemo(() => visibleItems(items, more, q), [items, more, q])
  const flat = groups.flatMap((g) => g.list)
  const cur = Math.min(at, Math.max(0, flat.length - 1))

  useEffect(() => { document.getElementById(`cp-${flat[cur]?.id}`)?.scrollIntoView({ block: 'nearest' }) }, [cur, flat])

  /** Run closes the palette first, so a modal an item opens (New workspace) is the one left standing. */
  const run = (it?: PaletteItem) => { if (!it) return; close(); it.run() }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAt((cur + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % Math.max(1, flat.length)) }
    else if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); run(flat.find((x) => x.id === 'approve')) }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[cur]) }
  }

  return (
    <Modal title="Search" onClose={close} bare width={640} top={97}>
      <div className="cp-input">
        <Icon name="search" size={16} />
        <input
          autoFocus role="combobox" aria-expanded="true" aria-controls="cp-list" aria-activedescendant={flat[cur] ? `cp-${flat[cur].id}` : undefined} aria-label="Type a command or search"
          placeholder="Type a command or search" value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} onKeyDown={onKey}
        />
        <Kbd>esc</Kbd>
      </div>
      <div id="cp-list" ref={list} role="listbox" aria-label="Results" className="cp-list">
        {groups.map((g) => (
          <div key={g.section} role="group" aria-label={g.section}>
            <div className="cp-sec" aria-hidden="true">{g.section}</div>
            {g.list.map((it) => (
              <div key={it.id} id={`cp-${it.id}`} role="option" aria-selected={flat[cur]?.id === it.id} className="cp-row" onMouseMove={() => setAt(flat.indexOf(it))} onClick={() => run(it)}>
                <span className="cp-glyph" aria-hidden="true">{it.glyph}</span>
                <span className="grow ellipsis">{it.label}</span>
                {it.keys && <span className="cp-keys" aria-label={`Shortcut ${it.keys.join(' ')}`}>{it.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>}
              </div>
            ))}
          </div>
        ))}
        {!groups.length && <div className="cp-none">Nothing matches "{q}".</div>}
      </div>
      <div className="cp-foot" aria-hidden="true"><span>↑↓ to move</span><span>↵ to run</span></div>
    </Modal>
  )
}
