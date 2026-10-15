import { useEffect, useMemo, useRef, useState } from 'react'
import type { Approval, Provider } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, go, useStore } from '../../store'
import { isLeadWorkspace, leadOf, openLead, openNewChat, openProject } from '../../lead'
import { currentThread } from '../../nav'
import { openRow, openThreads } from '../../components/sidebar/slots'
import { selectedPreset, useTerminalPresets } from '../../terminalPresets'
import { focusComposerWhenOpen } from '../workspace/composer/bus'
import { Icon, Kbd, Modal } from '../../ui'
import { FileIcon } from '../../components/FileIcon'
import { ProjectIcon } from '../../components/ProjectIcon'
import { restoreArchived } from '../history/restore'
import { SCOPES, buildItems, matchRanges, projectInView, scopeLabel, stepScope, visibleItems, type PaletteItem, type Scope } from './model'
import './search.css'

const close = () => actions.ui.closeModal()
const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })

/** Allow the one tool request, the same call the Inbox makes. */
const approve = (a: Approval) => void call('approvals.decide', { id: a.id, decision: { behavior: 'allow' } }).then(actions.approvals.upsert).catch(fail('Could not send your answer'))

/** Cmd+K, "Switch Claude Code to Personal": the account runs the provider's next turns, as Switch to does in Settings (KERNEL-561). */
const switchAccount = (provider: Provider, accountId: string) => void actions.accounts.requestSwitch(provider, accountId).catch(fail('Could not switch accounts'))

/** A tab opens in the workspace you are in, and takes focus. In the Lead's workspace a chat tab joins the chat on screen (KERNEL-339), as + does. */
function newChat(workspaceId: string, kind?: 'terminal') {
  const s = getState()
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  const current = kind !== 'terminal' && ws && isLeadWorkspace(ws, ws.projectId, leadOf(s.agents, ws.projectId)?.id) ? currentThread(s, workspaceId) : undefined
  // currentThread falls back to a tab's own id, which is no thread: send only an id some tab really has as its threadId (KERNEL-364).
  const threadId = current && s.chats[workspaceId]?.some((c) => c.threadId === current) ? current : undefined
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

/** The project has no open Lead chat: open the newest, then the file's tab, now that it is on screen. With none open there is nowhere to show it. */
async function openSharedInLead(projectId: string, sharedId: string) {
  const ws = await openLead(projectId)
  if (ws) actions.ui.openShared(ws.id, sharedId)
}

/** A chord is one chip: "⌘⇧T" for a modified key, "G I" for keys pressed in turn. */
const chord = (keys: string[]) => keys.join(keys.some((k) => /[⌘⇧⌥⌃]/.test(k)) ? '' : ' ')

function RowIcon({ item }: { item: PaletteItem }) {
  if (item.file) return <FileIcon path={item.file} size={16} />
  if (item.project) return <ProjectIcon project={item.project} size={16} />
  return <Icon name={item.icon} size={16} />
}

/** The label with the characters the search matched in full ink and the rest quiet. */
function Hit({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(query, text)
  if (!ranges.length) return <>{text}</>
  const parts: React.ReactNode[] = []
  let at = 0
  ranges.forEach(([from, to], n) => {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(<mark key={n} className="cp-hit">{text.slice(from, to)}</mark>)
    at = to
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/** CommandPalette.png: search and run anything, from the keyboard (⌘K). */
export function CommandPalette() {
  const route = useStore((s) => s.ui.route)
  const projects = useStore((s) => s.projects)
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

  // The open chats of the project in view, in the sidebar's order.
  const projectChats = useMemo(() => {
    const project = projectInView(route, projects, workspaces)
    return project ? openThreads(project, workspaces, chats, threads) : []
  }, [route, projects, workspaces, chats, threads])
  const { items, more } = useMemo(() => buildItems({
    route, projects, workspaces, approvals, agents, terminal, accounts, threads, chats: projectChats, shared: Object.values(shared),
    act: { go, openNewChat, newProject: () => actions.ui.openModal({ name: 'newProject' }), whatsNew: () => actions.ui.openModal({ name: 'whatsNew' }), approve, newChat, openChat: (projectId, thread, tabs, ws) => openRow(projectId, { kind: 'chat', thread, ws, tabs, owned: [], folded: false }), openLead: (projectId) => void openLead(projectId), openProject: (projectId) => void openProject(projectId), openShared, openSharedInLead: (projectId, sharedId) => void openSharedInLead(projectId, sharedId), toast: (title) => actions.ui.toast({ title }), restore: (w, name) => void restoreArchived(w, name), switchAccount }
  }), [route, projects, workspaces, approvals, agents, terminal, accounts, threads, projectChats, shared])
  const [scope, setScope] = useState<Scope>('all')
  const groups = useMemo(() => visibleItems(items, more, q, scope), [items, more, q, scope])
  const flat = groups.flatMap((g) => g.list)
  const cur = Math.min(at, Math.max(0, flat.length - 1))

  useEffect(() => { document.getElementById(`cp-${flat[cur]?.id}`)?.scrollIntoView({ block: 'nearest' }) }, [cur, flat])

  /** Run closes the palette first, so a modal an item opens (New chat) is the one left standing. */
  const run = (it?: PaletteItem) => { if (!it) return; close(); it.run() }
  const pick = (next: Scope) => { setScope(next); setAt(0) }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const { selectionStart: from, selectionEnd: to, value } = e.currentTarget
    const caretFree = from === to
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(stepScope(scope, e.shiftKey ? -1 : 1)) }
    else if (e.key === 'ArrowRight' && caretFree && from === value.length) { e.preventDefault(); pick(stepScope(scope, 1)) }
    else if (e.key === 'ArrowLeft' && caretFree && from === 0) { e.preventDefault(); pick(stepScope(scope, -1)) }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAt((cur + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % Math.max(1, flat.length)) }
    else if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); run(items.find((x) => x.id === 'approve')) }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[cur]) }
  }

  return (
    <Modal title="Search" onClose={close} bare width={640} top={97}>
      <div className="cp-input">
        <Icon name="search" size={16} />
        <input
          autoFocus role="combobox" aria-expanded={flat.length > 0} aria-controls="cp-list" aria-activedescendant={flat[cur] ? `cp-${flat[cur].id}` : undefined} aria-label="Type a command or search"
          placeholder="Type a command or search" value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} onKeyDown={onKey}
        />
        <Kbd>esc</Kbd>
      </div>
      <div className="cp-scopes" role="tablist" aria-label="Search in">
        {SCOPES.map((t) => (
          <button key={t.id} type="button" role="tab" className="cp-tab" aria-selected={t.id === scope} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(t.id)}>{t.label}</button>
        ))}
      </div>
      <div id="cp-list" ref={list} role="listbox" aria-label="Results" className="cp-list">
        {groups.map((g) => (
          <div key={g.section} role="group" aria-label={g.title} className="cp-group">
            <div className="cp-sec" aria-hidden="true">{g.title}</div>
            {g.list.map((it) => (
              <div key={it.id} id={`cp-${it.id}`} role="option" aria-selected={flat[cur] === it} className="cp-row" onMouseMove={() => setAt(flat.indexOf(it))} onClick={() => run(it)}>
                <span className="cp-icon" aria-hidden="true"><RowIcon item={it} /></span>
                <span className="cp-label grow ellipsis"><Hit text={it.label} query={q} /></span>
                {it.meta && <span className="cp-meta ellipsis">{it.meta}</span>}
                {it.keys && <kbd className="cp-keys" aria-label={`Shortcut ${it.keys.join(' ')}`}>{chord(it.keys)}</kbd>}
              </div>
            ))}
          </div>
        ))}
        {!groups.length && <div className="cp-none">{q.trim() ? `No results for "${q.trim()}" in ${scopeLabel(scope)}` : `Nothing in ${scopeLabel(scope)} yet`}</div>}
      </div>
      <div className="cp-foot">
        <span className="cp-hint" aria-hidden="true"><Kbd>↑↓</Kbd>Navigate</span>
        <span className="cp-hint" aria-hidden="true"><Kbd>↵</Kbd>Open</span>
        <span className="cp-hint" aria-hidden="true"><Kbd>←→</Kbd>Scope</span>
        <span className="cp-hint" aria-hidden="true"><Kbd>Esc</Kbd>Close</span>
        <span className="cp-count" aria-live="polite">{flat.length} {flat.length === 1 ? 'result' : 'results'}</span>
      </div>
    </Modal>
  )
}
