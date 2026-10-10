import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangedFile, Room, Workspace as WorkspaceModel } from '@shared/types'
import { call } from '../../api'
import { actions, getState, loadWorkspace, useStore } from '../../store'
import { Icon, IconButton } from '../../ui'
import { RightPanelToggle, SidebarToggle } from '../../components/PanelToggles'
import { ResizeHandle, readWidth } from '../../components/ResizeHandle'
import { openRoom } from '../../lead'
import { tabOf } from '../../nav'
import { RoomIcon } from '../../components/RoomIcon'
import { ChatTabs, diffTab, fileTab } from './ChatTabs'
import { CheckpointsDrawer } from './checkpoints/Checkpoints'
import { OpenImage, OpenText, type ImagePart, type TextPart } from './composer/Chip'
import { Composer } from './composer/Composer'
import { DiffView, FileView, ImageView, TextView } from './FileView'
import { BottomPanel, RightPanel } from './Panels'
import { PrHeader } from './pr/PrHeader'
import { TerminalView } from './terminal/Terminal'
import { Transcript, TranscriptSkeleton } from './Transcript'
import { useBanner, WorkspaceBanner } from './banners/Banners'
import { onRefreshChanges } from './changesBus'
import { githubIssueUrl, isGithubKey } from './issueKey'
import './workspace.css'

const EMPTY_CHATS: never[] = []
const NO_TABS: string[] = []
const NO_CHANGES: ChangedFile[] = []
const PANEL_MIN = 320
const PANEL_MAX = 720
const PANEL_KEY = 'kernel.rightPanelWidth'
/** Letting go below this hides the panel. The saved width stays. */
const PANEL_HIDE_BELOW = 240
/** The chat column keeps at least this much, however wide the panel was saved. */
const CHAT_MIN = 420
/** What `.ws-aside` is until the user drags: 28% of the window between 320 and 400px (D-080), so its CSS and this agree. */
const panelDefault = () => Math.min(400, Math.max(PANEL_MIN, Math.round(window.innerWidth * 0.28)))
let imageCount = 0
let textCount = 0

/** An attached image open in a tab. Its tab id is `image:<n>`. */
interface OpenedImage { id: string; part: ImagePart }

/** A pasted text open in a tab. Its tab id is `text:<n>`. */
interface OpenedText { id: string; part: TextPart }

/** Header, tabs, transcript, composer, and the right and bottom panels (Workspace.png). */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const room = useStore((s) => s.rooms.find((r) => r.id === ws?.roomId))
  const agent = useStore((s) => (ws ? s.agents[ws.roomId]?.find((a) => a.id === ws.agentId) : undefined))
  const chats = useStore((s) => s.chats[workspaceId] ?? EMPTY_CHATS)
  const view = useStore((s) => s.ui.workspace)
  const stored = useStore((s) => tabOf(s, workspaceId))
  const tabs = useStore((s) => s.ui.tabs[workspaceId])
  const panels = useStore((s) => s.ui.rightPanel)
  // The changed files remember which workspace they were read for, so a late answer or a switch never shows another workspace's files.
  const [fetched, setFetched] = useState<{ workspaceId: string; files: ChangedFile[] }>({ workspaceId, files: NO_CHANGES })
  const changes = fetched.workspaceId === workspaceId ? fetched.files : NO_CHANGES
  const shown = useRef({ workspaceId, request: 0 })
  shown.current.workspaceId = workspaceId
  const [images, setImages] = useState<OpenedImage[]>([])
  const [texts, setTexts] = useState<OpenedText[]>([])
  const [prefill, setPrefill] = useState<{ text: string; n: number }>()
  // The panel's width is the CSS clamp until it is dragged, then a saved px width. It is read once. The CSS caps a saved width so the chat column keeps CHAT_MIN, whatever the window or the sidebar does.
  const aside = useRef<HTMLElement>(null)
  const [panelWidth, setPanelWidth] = useState(() => readWidth(PANEL_KEY, PANEL_MIN, PANEL_MAX))
  const panelLimit = () => Math.max(PANEL_MIN, Math.min(PANEL_MAX, (aside.current?.parentElement?.clientWidth ?? window.innerWidth) - CHAT_MIN))

  const lastChat = chats.some((c) => !c.closed && c.id === tabs?.lastChat) ? tabs?.lastChat : undefined
  // Images and pasted texts live only as long as this screen, so such a tab left in the store after it remounts falls back to the chat.
  const gone = (stored?.startsWith('image:') && !images.some((i) => i.id === stored)) || (stored?.startsWith('text:') && !texts.some((t) => t.id === stored))
  const tab = gone ? lastChat ?? chats[0]?.id : stored
  const filePath = tab?.startsWith('file:') ? tab.slice(5) : undefined
  // An empty path is the diff of every changed file, so test for undefined, never for truthiness.
  const diffPath = tab?.startsWith('diff:') ? tab.slice(5) : undefined
  const image = images.find((i) => i.id === tab)?.part
  const text = texts.find((t) => t.id === tab)?.part
  const chat = filePath || diffPath !== undefined || image || text ? chats.find((c) => c.id === lastChat) ?? chats[0] : chats.find((c) => c.id === tab) ?? chats[0]
  const files = tabs?.files ?? NO_TABS
  const diffs = tabs?.diffs ?? NO_TABS
  const running = useStore((s) => (chat ? !!s.running[chat.id] : false))
  const banner = useBanner(ws, chat, agent?.name ?? 'The agent', running)
  const empty = useStore((s) => (chat ? !s.items[chat.id]?.length : true))

  // Images and pasted texts belong to the screen, not the store, so they start empty for each workspace. A tab of one left in the
  // store from before goes back to the chat, or the sidebar and closing a chat would still think it is the one on screen.
  useEffect(() => {
    setImages([]); setTexts([])
    const t = getState().ui.tabs[workspaceId]
    if (t?.tab?.startsWith('image:') || t?.tab?.startsWith('text:')) actions.ui.setTabs(workspaceId, { tab: t.lastChat })
  }, [workspaceId])

  useEffect(() => { void loadWorkspace(workspaceId) }, [workspaceId])
  // An answer counts only if it is for the workspace on screen and the latest asked for.
  const refresh = useCallback(() => {
    const request = ++shown.current.request
    return call('workspaces.changes', { workspaceId }).catch((): ChangedFile[] => NO_CHANGES).then((files) => {
      if (shown.current.workspaceId === workspaceId && shown.current.request === request) setFetched({ workspaceId, files })
    })
  }, [workspaceId])
  useEffect(() => { setFetched((c) => (c.workspaceId === workspaceId ? c : { workspaceId, files: NO_CHANGES })); void refresh() }, [refresh])
  useEffect(() => { if (!running) void refresh() }, [running])
  useEffect(() => onRefreshChanges((id) => { if (id === workspaceId) void refresh() }), [workspaceId, refresh])
  // Stable, so the memoized transcript stays put while the screen redraws.
  const edit = useCallback((text: string) => setPrefill({ text, n: Date.now() }), [])
  const select = useCallback((id: string) => {
    if (id) actions.ui.openTab(workspaceId, id)
  }, [workspaceId])

  if (!ws) return <div className="panel" />
  const setup = ws.status === 'setup'
  const blocked = setup || ws.status === 'failed' || !!banner?.blocks

  const openFile = (path: string) => select(fileTab(path))
  const closeFile = (path: string) => {
    actions.ui.setTabs(workspaceId, { files: files.filter((x) => x !== path) })
    if (tab === fileTab(path)) select(chat?.id ?? '')
  }
  /** The same diff again selects its tab. An empty path is All changes. */
  const openDiff = (path: string) => select(diffTab(path))
  const closeDiff = (path: string) => {
    actions.ui.setTabs(workspaceId, { diffs: diffs.filter((x) => x !== path) })
    if (tab === diffTab(path)) select(chat?.id ?? '')
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
  /** The same paste again selects its tab. Two pastes with the same name and text are the same paste. */
  const openText = (part: TextPart) => {
    const have = texts.find((t) => t.part.name === part.name && t.part.text === part.text)
    const id = have?.id ?? `text:${++textCount}`
    if (!have) setTexts((list) => [...list, { id, part }])
    select(id)
  }
  const closeText = (id: string) => {
    setTexts((list) => list.filter((t) => t.id !== id))
    if (tab === id) select(chat?.id ?? '')
  }
  const changed = filePath ? changes.some((c) => c.path === filePath) : false

  // The header spans the chat column only. The right panel runs the full height and carries the PR actions at its top;
  // while it is hidden they move into the header, so Create PR and Merge stay one click away.
  return (
    <div className="panel ws-panel">
      <header className="header">
        <SidebarToggle />
        <RoomIcon room={room} className="crumb-avatar" />
        <button type="button" className="crumb" onClick={() => room && void openRoom(room.id)}>{room?.name}</button>
        <span className="muted"><Icon name="right" size={12} /></span>
        <h1 className="ellipsis">{ws.name}</h1>
        <span className="mono muted ellipsis ws-branch">{ws.mode === 'current' ? `current branch · ${ws.branch}` : ws.branch}</span>
        <IssueKey ws={ws} room={room} />
        <IconButton icon="code" size={15} label="Open in editor" onClick={() => void call('system.openInEditor', { path: ws.path })} />
        <span className="grow" />
        {!panels && <PrHeader ws={ws} />}
        <RightPanelToggle name="panels" />
      </header>
      <OpenImage.Provider value={openImage}>
      <OpenText.Provider value={openText}>
        <section aria-label="Agent" className="ws-main">
          <ChatTabs workspaceId={workspaceId} chats={chats} files={files} diffs={diffs} images={images.map((i) => ({ id: i.id, name: i.part.name }))} texts={texts.map((t) => ({ id: t.id, name: t.part.name }))} active={tab} onSelect={select} onCloseFile={closeFile} onCloseDiff={closeDiff} onCloseImage={closeImage} onCloseText={closeText} />
          <div className="col grow" style={{ minHeight: 0 }}>
            {diffPath !== undefined
              ? <DiffView ws={ws} path={diffPath} changes={changes} />
              : filePath
                ? <FileView ws={ws} path={filePath} changed={changed} editedBy={agent?.name} />
                : image
                  ? <ImageView name={image.name} src={image.dataUrl} width={image.width} height={image.height} />
                : text
                  ? <TextView name={text.name} text={text.text} />
                : setup
                  ? <TranscriptSkeleton branch={ws.branch} />
                  // A failed setup holds the first prompt, so the chat is empty but not new: no "New chat" suggestions.
                  : ws.status === 'failed' && empty
                    ? <div className="grow" />
                  : chat?.kind === 'terminal'
                    ? <TerminalView id={chat.id} label="Big terminal" />
                  : chat
                    ? <Transcript chat={chat} workspaceId={workspaceId} changes={changes} onEdit={edit} onForked={select} />
                    : <div className="grow" />}
          </div>
          {chat && chat.kind !== 'terminal' && <Composer chat={chat} agent={agent} blocked={blocked} running={running} prefill={prefill} banner={banner && <WorkspaceBanner view={banner} ws={ws} chat={chat} />} />}
          {view.checkpoints && <CheckpointsDrawer workspaceId={workspaceId} />}
        </section>
      </OpenText.Provider>
      </OpenImage.Provider>
      {panels && (
        <aside ref={aside} aria-label="Workspace panels" className="ws-aside" style={panelWidth === null ? undefined : { width: `max(${PANEL_MIN}px, min(${panelWidth}px, 100cqw - ${CHAT_MIN}px))` }}>
          <ResizeHandle
            targetRef={aside} edge="left" label="Resize panel" width={panelWidth ?? panelDefault()} min={PANEL_MIN} limit={panelLimit} defaultWidth={panelDefault}
            storageKey={PANEL_KEY} hideBelow={PANEL_HIDE_BELOW} onHide={() => actions.ui.setRightPanel(false)} onCommit={setPanelWidth}
          />
          <div className="ws-aside-head"><PrHeader ws={ws} spread /></div>
          <RightPanel ws={ws} changes={changes} onOpenFile={openFile} onOpenDiff={openDiff} />
          <BottomPanel ws={ws} />
        </aside>
      )}
    </div>
  )
}

/** The issue a workspace started on, after the branch (WorkspaceIssue.png). A Linear key opens the Issues screen on it, a GitHub issue opens its page. A GitHub key with no page to open is plain text. */
function IssueKey({ ws, room }: { ws: WorkspaceModel; room?: Room }) {
  const source = ws.source
  if (source?.kind !== 'issue') return null
  if (!isGithubKey(source.id)) return <button type="button" className="ws-issue" aria-label={`Open Linear issue ${source.id}`} title={source.title} onClick={() => actions.ui.go({ name: 'issues', issueId: source.id })}>{source.id}</button>
  const url = githubIssueUrl(source, room)
  if (!url) return <span className="ws-issue" title={source.title}>{source.id}</span>
  return <button type="button" className="ws-issue" aria-label={`Open issue ${source.id}`} title={source.title} onClick={() => void call('system.openExternal', { url })}>{source.id}</button>
}
