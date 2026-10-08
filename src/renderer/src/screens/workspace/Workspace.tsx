import { useEffect, useState } from 'react'
import type { ChangedFile } from '@shared/types'
import { call } from '../../api'
import { actions, go, loadWorkspace, useStore } from '../../store'
import { Icon, IconButton } from '../../ui'
import { RightPanelToggle, SidebarToggle } from '../../components/PanelToggles'
import { roomLetter } from '../rooms/roomInfo'
import { ChatTabs, fileTab } from './ChatTabs'
import { CheckpointsDrawer } from './checkpoints/Checkpoints'
import { OpenImage, type ImagePart } from './composer/Chip'
import { Composer } from './composer/Composer'
import { DiffView, FileView, ImageView } from './FileView'
import { BottomPanel, RightPanel } from './Panels'
import { PrHeader } from './pr/PrHeader'
import { TerminalView } from './terminal/Terminal'
import { Transcript, TranscriptSkeleton } from './Transcript'
import { useBanner, WorkspaceBanner } from './banners/Banners'
import { onRefreshChanges } from './changesBus'
import './workspace.css'

const EMPTY_CHATS: never[] = []
/** The workspace the stored tab and diff belong to. */
let viewOwner: string | undefined
let imageCount = 0

/** An attached image open in a tab. Its tab id is `image:<n>`. */
interface OpenedImage { id: string; part: ImagePart }

/** Header, tabs, transcript, composer, and the right and bottom panels (Workspace.png). */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const room = useStore((s) => s.rooms.find((r) => r.id === ws?.roomId))
  const agent = useStore((s) => (ws ? s.agents[ws.roomId]?.find((a) => a.id === ws.agentId) : undefined))
  const chats = useStore((s) => s.chats[workspaceId] ?? EMPTY_CHATS)
  const view = useStore((s) => s.ui.workspace)
  const panels = useStore((s) => s.ui.rightPanel)
  const [changes, setChanges] = useState<ChangedFile[]>([])
  const [openFiles, setOpenFiles] = useState<string[]>([])
  const [images, setImages] = useState<OpenedImage[]>([])
  const [lastChat, setLastChat] = useState<string | undefined>()
  const [prefill, setPrefill] = useState<{ text: string; n: number }>()

  const stored = view.tab ?? lastChat ?? chats[0]?.id
  // Images live only as long as this screen, so an image tab left in the store after it remounts falls back to the chat.
  const tab = stored?.startsWith('image:') && !images.some((i) => i.id === stored) ? lastChat ?? chats[0]?.id : stored
  const filePath = tab?.startsWith('file:') ? tab.slice(5) : undefined
  const image = images.find((i) => i.id === tab)?.part
  const chat = filePath || image ? chats.find((c) => c.id === lastChat) ?? chats[0] : chats.find((c) => c.id === tab) ?? chats[0]
  const files = filePath && !openFiles.includes(filePath) ? [...openFiles, filePath] : openFiles
  const running = useStore((s) => (chat ? !!s.running[chat.id] : false))
  const banner = useBanner(ws, chat, agent?.name ?? 'The agent', running)
  const empty = useStore((s) => (chat ? !s.items[chat.id]?.length : true))

  // The open tab and diff live in the store, so they outlast this screen. Whenever the screen shows a different workspace
  // than the one they belong to, clear them. The very first mount keeps what a fixture or a restored view set.
  useEffect(() => {
    if (viewOwner !== undefined && viewOwner !== workspaceId) {
      setOpenFiles([]); setImages([]); setLastChat(undefined)
      actions.ui.setWorkspaceView({ tab: undefined, diff: undefined })
    }
    viewOwner = workspaceId
  }, [workspaceId])

  useEffect(() => { void loadWorkspace(workspaceId) }, [workspaceId])
  const refresh = () => call('workspaces.changes', { workspaceId }).then(setChanges).catch(() => setChanges([]))
  useEffect(() => { void refresh() }, [workspaceId])
  useEffect(() => { if (!running) void refresh() }, [running])
  useEffect(() => onRefreshChanges((id) => { if (id === workspaceId) void refresh() }), [workspaceId])

  if (!ws) return <div className="panel" />
  const setup = ws.status === 'setup'
  const blocked = setup || ws.status === 'failed' || !!banner?.blocks

  const select = (id: string) => {
    if (!id.startsWith('file:') && !id.startsWith('image:')) setLastChat(id)
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
  /** The same image again selects its tab instead of opening a second one. */
  const openImage = (part: ImagePart) => {
    const have = images.find((i) => i.part.dataUrl === part.dataUrl)
    const id = have?.id ?? `image:${++imageCount}`
    if (!have) setImages((list) => [...list, { id, part }])
    select(id)
  }
  const closeImage = (id: string) => {
    setImages((list) => list.filter((i) => i.id !== id))
    if (tab === id) select(chat?.id ?? '')
  }
  const changed = filePath ? changes.some((c) => c.path === filePath) : false

  // The header spans the chat column only. The right panel runs the full height and carries the PR actions at its top;
  // while it is hidden they move into the header, so Create PR and Merge stay one click away.
  return (
    <div className="panel ws-panel">
      <header className="header">
        <SidebarToggle />
        <span className="crumb-avatar" aria-hidden="true">{room ? roomLetter(room.name) : ''}</span>
        <button type="button" className="crumb" onClick={() => room && go({ name: 'floor', roomId: room.id })}>{room?.name}</button>
        <span className="muted"><Icon name="right" size={12} /></span>
        <h1 className="ellipsis">{ws.name}</h1>
        <span className="mono muted ellipsis ws-branch">{ws.mode === 'current' ? `current branch · ${ws.branch}` : ws.branch}</span>
        <IconButton icon="code" size={15} label="Open in editor" onClick={() => void call('system.openInEditor', { path: ws.path })} />
        <span className="grow" />
        {!panels && <PrHeader ws={ws} />}
        <RightPanelToggle name="panels" />
      </header>
      <OpenImage.Provider value={openImage}>
        <section aria-label="Agent" className="ws-main">
          <ChatTabs workspaceId={workspaceId} chats={chats} files={files} images={images.map((i) => ({ id: i.id, name: i.part.name }))} active={tab} onSelect={select} onCloseFile={closeFile} onCloseImage={closeImage} />
          <div className="col grow" style={{ minHeight: 0 }}>
            {view.diff !== undefined
              ? <DiffView ws={ws} path={view.diff} changes={changes} onClose={() => actions.ui.setWorkspaceView({ diff: undefined })} />
              : filePath
                ? <FileView ws={ws} path={filePath} changed={changed} editedBy={agent?.name} />
                : image
                  ? <ImageView name={image.name} src={image.dataUrl} width={image.width} height={image.height} />
                : setup
                  ? <TranscriptSkeleton branch={ws.branch} />
                  // A failed setup holds the first prompt, so the chat is empty but not new: no "New chat" suggestions.
                  : ws.status === 'failed' && empty
                    ? <div className="grow" />
                  : chat?.kind === 'terminal'
                    ? <TerminalView id={chat.id} label="Big terminal" />
                  : chat
                    ? <Transcript chat={chat} workspaceId={workspaceId} changes={changes} onEdit={(text) => setPrefill({ text, n: Date.now() })} onForked={select} />
                    : <div className="grow" />}
          </div>
          {chat && chat.kind !== 'terminal' && <Composer chat={chat} agent={agent} blocked={blocked} running={running} prefill={prefill} banner={banner && <WorkspaceBanner view={banner} ws={ws} chat={chat} />} />}
          {view.checkpoints && <CheckpointsDrawer workspaceId={workspaceId} />}
        </section>
      </OpenImage.Provider>
      {panels && (
        <aside aria-label="Workspace panels" className="ws-aside">
          <div className="ws-aside-head"><PrHeader ws={ws} spread /></div>
          <RightPanel ws={ws} changes={changes} onOpenFile={openFile} onOpenDiff={(path) => actions.ui.setWorkspaceView({ diff: path })} />
          <BottomPanel ws={ws} />
        </aside>
      )}
    </div>
  )
}
