import { useEffect, useState } from 'react'
import type { ChangedFile } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadWorkspace, useStore } from '../../store'
import { Icon, IconButton } from '../../ui'
import { roomLetter } from '../rooms/roomInfo'
import { ChatTabs, fileTab } from './ChatTabs'
import { Composer } from './composer/Composer'
import { DiffView, FileView } from './FileView'
import { BottomPanel, RightPanel } from './Panels'
import { PrHeader } from './PrHeader'
import { Transcript, TranscriptSkeleton } from './Transcript'
import './workspace.css'

const EMPTY_CHATS: never[] = []
/** The workspace the stored tab and diff belong to. */
let viewOwner: string | undefined

/** Header, tabs, transcript, composer, and the right and bottom panels (Workspace.png). */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const room = useStore((s) => s.rooms.find((r) => r.id === ws?.roomId))
  const agent = useStore((s) => (ws ? s.agents[ws.roomId]?.find((a) => a.id === ws.agentId) : undefined))
  const chats = useStore((s) => s.chats[workspaceId] ?? EMPTY_CHATS)
  const view = useStore((s) => s.ui.workspace)
  const [changes, setChanges] = useState<ChangedFile[]>([])
  const [openFiles, setOpenFiles] = useState<string[]>([])
  const [lastChat, setLastChat] = useState<string | undefined>()
  const [prefill, setPrefill] = useState<{ text: string; n: number }>()

  const tab = view.tab ?? lastChat ?? chats[0]?.id
  const filePath = tab?.startsWith('file:') ? tab.slice(5) : undefined
  const chat = filePath ? chats.find((c) => c.id === lastChat) ?? chats[0] : chats.find((c) => c.id === tab) ?? chats[0]
  const files = filePath && !openFiles.includes(filePath) ? [...openFiles, filePath] : openFiles
  const running = useStore((s) => (chat ? !!s.running[chat.id] : false))

  // The open tab and diff live in the store, so they outlast this screen. Whenever the screen shows a different workspace
  // than the one they belong to, clear them. The very first mount keeps what a fixture or a restored view set.
  useEffect(() => {
    if (viewOwner !== undefined && viewOwner !== workspaceId) {
      setOpenFiles([]); setLastChat(undefined)
      actions.ui.setWorkspaceView({ tab: undefined, diff: undefined })
    }
    viewOwner = workspaceId
  }, [workspaceId])

  useEffect(() => { void loadWorkspace(workspaceId) }, [workspaceId])
  const refresh = () => call('workspaces.changes', { workspaceId }).then(setChanges).catch(() => setChanges([]))
  useEffect(() => { void refresh() }, [workspaceId])
  useEffect(() => { if (!running) void refresh() }, [running])

  if (!ws) return <div className="panel" />
  const setup = ws.status === 'setup'
  const blocked = setup || ws.status === 'failed'

  const select = (id: string) => {
    if (!id.startsWith('file:')) setLastChat(id)
    actions.ui.setWorkspaceView({ tab: id, diff: undefined })
  }
  const openFile = (path: string) => {
    setOpenFiles((f) => (f.includes(path) ? f : [...f, path]))
    select(fileTab(path))
  }
  const closeFile = (path: string) => {
    setOpenFiles((f) => f.filter((x) => x !== path))
    if (tab === fileTab(path)) select(chat?.id ?? '')
  }
  const changed = filePath ? changes.some((c) => c.path === filePath) : false

  return (
    <div className="panel">
      <header className="header">
        {view.focus && <IconButton icon="sidebar" size={15} label="Show sidebar" onClick={() => actions.ui.setWorkspaceView({ focus: false })} />}
        <span className="crumb-avatar" aria-hidden="true">{room ? roomLetter(room.name) : ''}</span>
        <button type="button" className="crumb" onClick={() => room && go({ name: 'floor', roomId: room.id })}>{room?.name}</button>
        <span className="muted"><Icon name="right" size={12} /></span>
        <h1>{ws.name}</h1>
        <span className="mono muted" style={{ fontSize: 12 }}>{ws.mode === 'current' ? `current branch · ${ws.branch}` : ws.branch}</span>
        <IconButton icon="code" size={15} label="Open in editor" onClick={() => void call('system.openInEditor', { path: ws.path })} />
        <span className="grow" />
        <PrHeader ws={ws} />
      </header>
      <div className="ws-body">
        <section aria-label="Agent" className="ws-main">
          <ChatTabs workspaceId={workspaceId} chats={chats} files={files} active={tab} onSelect={select} onCloseFile={closeFile} />
          <div className="col grow" style={{ minHeight: 0 }}>
            {view.diff !== undefined
              ? <DiffView ws={ws} path={view.diff} changes={changes} onClose={() => actions.ui.setWorkspaceView({ diff: undefined })} />
              : filePath
                ? <FileView ws={ws} path={filePath} changed={changed} editedBy={agent?.name} />
                : setup
                  ? <TranscriptSkeleton branch={ws.branch} />
                  : chat
                    ? <Transcript chat={chat} workspaceId={workspaceId} changes={changes} onEdit={(text) => setPrefill({ text, n: Date.now() })} onForked={select} />
                    : <div className="grow" />}
          </div>
          {chat && <Composer chat={chat} agent={agent} blocked={blocked} running={running} prefill={prefill} />}
        </section>
        {!view.focus && (
          <aside aria-label="Workspace panels" className="ws-aside">
            <RightPanel ws={ws} changes={changes} onOpenFile={openFile} onOpenDiff={(path) => actions.ui.setWorkspaceView({ diff: path })} />
            <BottomPanel ws={ws} />
          </aside>
        )}
      </div>
    </div>
  )
}
