import { useEffect, useMemo, useRef, useState } from 'react'
import type { Approval, Provider } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, go, useStore } from '../../store'
import { isLeadWorkspace, leadOf, openLead, openRoom } from '../../lead'
import { currentThread } from '../../nav'
import { openRow, openThreads } from '../../components/sidebar/slots'
import { selectedPreset, useTerminalPresets } from '../../terminalPresets'
import { focusComposerWhenOpen } from '../workspace/composer/bus'
import { Icon, Kbd, Modal } from '../../ui'
import { buildItems, roomInView, visibleItems, type PaletteItem } from './model'
import './search.css'

const close = () => actions.ui.closeModal()
const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })

/** Allow the one tool request, the same call the Inbox makes. */
const approve = (a: Approval) => void call('approvals.decide', { id: a.id, decision: { behavior: 'allow' } }).then(actions.approvals.upsert).catch(fail('Could not send your answer'))

/** Cmd+K, "Switch Claude Code to Personal": the account runs the provider's next turns, as Switch to does in Settings (KERNEL-561). */
const switchAccount = (provider: Provider, accountId: string) => void call('accounts.switch', { provider, accountId }).then(actions.accounts.set).catch(fail('Could not switch accounts'))

/** A tab opens in the workspace you are in, and takes focus. In the Lead's workspace a chat tab joins the chat on screen (KERNEL-339), as + does. */
function newChat(workspaceId: string, kind?: 'terminal') {
  const s = getState()
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  const threadId = kind !== 'terminal' && ws && isLeadWorkspace(ws, ws.roomId, leadOf(s.agents, ws.roomId)?.id) ? currentThread(s, workspaceId) : undefined
  void call('chats.create', { workspaceId, kind, ...(threadId ? { threadId } : {}) }).then((chat) => {
    actions.chats.upsert(chat)
    go({ name: 'workspace', workspaceId })
    if (chat.kind !== 'terminal') focusComposerWhenOpen(chat.id)
    actions.ui.openTab(workspaceId, chat.id)
  }).catch(fail('Could not open the tab'))
}

/** A shared file opens in the workspace the model picked, and that workspace comes on screen. */
function openShared(workspaceId: string, sharedId: string) {
  go({ name: 'workspace', workspaceId })
  actions.ui.openShared(workspaceId, sharedId)
}

/** The room has no open chat with Rowan: open the newest, then the file's tab, now that it is on screen. With none open there is nowhere to show it. */
async function openSharedInLead(roomId: string, sharedId: string) {
  const ws = await openLead(roomId)
  if (ws) actions.ui.openShared(ws.id, sharedId)
}

/** CommandPalette.png: search and run anything, from the keyboard (⌘K). */
export function CommandPalette() {
  const route = useStore((s) => s.ui.route)
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces)
  const approvals = useStore((s) => s.approvals)
  const agents = useStore((s) => s.agents)
  const shared = useStore((s) => s.shared)
  const chats = useStore((s) => s.chats)
  const accounts = useStore((s) => s.accounts)
  const threads = useStore((s) => s.threads)
  const terminalSettings = useStore((s) => s.settings?.terminal)
  const presets = useTerminalPresets()
  const terminal = useMemo(() => terminalSettings && { enabled: terminalSettings.enabled, preset: presets ? selectedPreset(presets, terminalSettings)?.name : undefined }, [terminalSettings, presets])
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  // The open chats of the room in view, in the sidebar's order.
  const roomChats = useMemo(() => {
    const room = roomInView(route, rooms, workspaces)
    return room ? openThreads(room, workspaces, chats, threads) : []
  }, [route, rooms, workspaces, chats, threads])
  const { items, more } = useMemo(() => buildItems({
    route, rooms, workspaces, approvals, agents, terminal, accounts, chats: roomChats, shared: Object.values(shared),
    act: { go, newWorkspace: (roomId) => actions.ui.openModal({ name: 'newWorkspace', roomId }), newRoom: () => actions.ui.openModal({ name: 'newRoom' }), whatsNew: () => actions.ui.openModal({ name: 'whatsNew' }), approve, newChat, openChat: (roomId, thread, tabs, ws) => openRow(roomId, { kind: 'chat', thread, ws, tabs, owned: [], folded: false }), openLead: (roomId) => void openLead(roomId), openRoom: (roomId) => void openRoom(roomId), openShared, openSharedInLead: (roomId, sharedId) => void openSharedInLead(roomId, sharedId), toast: (title) => actions.ui.toast({ title }), switchAccount }
  }), [route, rooms, workspaces, approvals, agents, terminal, accounts, roomChats, shared])
  const groups = useMemo(() => visibleItems(items, more, q), [items, more, q])
  const flat = groups.flatMap((g) => g.list)
  const cur = Math.min(at, Math.max(0, flat.length - 1))

  useEffect(() => { document.getElementById(`cp-${flat[cur]?.id}`)?.scrollIntoView({ block: 'nearest' }) }, [cur, flat])

  /** Run closes the palette first, so a modal an item opens (New chat) is the one left standing. */
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
          <div key={g.section} role="group" aria-label={g.title}>
            <div className="cp-sec" aria-hidden="true">{g.title}</div>
            {g.list.map((it) => (
              <div key={it.id} id={`cp-${it.id}`} role="option" aria-selected={flat[cur]?.id === it.id} className="cp-row" onMouseMove={() => setAt(flat.indexOf(it))} onClick={() => run(it)}>
                <span className="cp-glyph" aria-hidden="true">{it.glyph}</span>
                <span className="grow ellipsis">{it.label}</span>
                {it.meta && <span className="cp-meta ellipsis">{it.meta}</span>}
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
