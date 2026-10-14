import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ChangedFile, NewChatPicks, Room, Workspace as WorkspaceModel, WorkspaceSource } from '@shared/types'
import { call } from '../../api'
import { actions, getState, loadWorkspace, panelShownIn, useStore } from '../../store'
import { Icon } from '../../ui'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { leadModeOf } from '@shared/leadMode'
import { RightPanelToggle, SidebarToggle } from '../../components/PanelToggles'
import { ResizeHandle, readWidth } from '../../components/ResizeHandle'
import { isLeadWorkspace, leadOf, openRoom } from '../../lead'
import { currentThread, tabOf, threadIdOf } from '../../nav'
import { RoomIcon } from '../../components/RoomIcon'
import { ChatTabs, diffTab, fileTab } from './ChatTabs'
import { bringBoxOnAsk, leadHasNoChat, newChatOnScreen, showsNewChat } from './leadNoChat'
import { NewChatHeader, NewChatTab } from './NewChatBar'
import { NewLeadChat } from './NewLeadChat'
import { nextTab } from './nextTab'
import { OpenIn } from './OpenIn'
import { OpenImage, OpenText, type ImagePart, type TextPart } from './composer/Chip'
import { Composer } from './composer/Composer'
import { OpenItems } from './composer/OpenItems'
import { WhereBranch, WhereRow } from './composer/WhereRow'
import { DiffView, FileView, ImageView, TextView } from './FileView'
import { BottomPanel, RightPanel } from './Panels'
import { SharedView } from './shared/SharedView'
import { LeadPrSummary } from './pr/LeadPrSummary'
import { LocalMergeInfo } from './pr/LocalMerge'
import { hasChanges } from './pr/model'
import { copyBranch, PrHeader } from './pr/PrHeader'
import { SkipNotice } from './terminal/SkipNotice'
import { TerminalView } from './terminal/Terminal'
import { SetupWait } from './SetupWait'
import { setupGate, skipsSetup } from './setupGate'
import { Transcript } from './Transcript'
import { useBanner, WorkspaceBanner } from './banners/Banners'
import { onRefreshChanges } from './changesBus'
import { githubIssueUrl, issueTracker } from './issueKey'
import { useWorkspaceShortcuts } from './shortcuts'
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

/**
 * The branch the shared Lead worktree from before KERNEL-405 follows, for the header's "latest main" (KERNEL-355): the room's default
 * branch when the base is that branch on its remote or locally, so only a remote name comes off ("release/v2" stays whole), else the
 * base as it is.
 */
const leadBase = (ws: WorkspaceModel, room?: Room) => {
  const d = room?.defaultBranch
  return d && (ws.baseRef === d || ws.baseRef.endsWith(`/${d}`)) ? d : ws.baseRef
}

/**
 * The header's title: the task title, else the workspace's name. The issue chip beside it already says the key, so a title that starts
 * with it ("KERNEL-155 Home and Inbox", "KERNEL-155: Home and Inbox") drops it. "KERNEL-1550 ..." is not that key, and a title that is
 * only the key stays whole.
 */
export function headerTitle(ws: Pick<WorkspaceModel, 'title' | 'name' | 'source'>) {
  const title = ws.title?.trim() || ws.name
  const key = ws.source?.kind === 'issue' ? ws.source.id : undefined
  if (!key || !title.toLowerCase().startsWith(key.toLowerCase())) return title
  const rest = title.slice(key.length)
  if (/^\w/.test(rest)) return title
  return rest.replace(/^[\s:·|\-–—.]+/, '') || title
}

/** Header, tabs, transcript, composer, and the right and bottom panels (Workspace.png). */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const room = useStore((s) => s.rooms.find((r) => r.id === ws?.roomId))
  const agent = useStore((s) => (ws ? s.agents[ws.roomId]?.find((a) => a.id === ws.agentId) : undefined))
  const everyChat = useStore((s) => s.chats[workspaceId] ?? EMPTY_CHATS)
  // The Lead's workspace shows one chat at a time: that chat's tabs, then the files. Its other chats' tabs are rows in the sidebar (KERNEL-338).
  const isLead = useStore((s) => !!ws && isLeadWorkspace(ws, ws.roomId, leadOf(s.agents, ws.roomId)?.id))
  const threadId = useStore((s) => (isLead ? currentThread(s, workspaceId) : undefined))
  const chats = useMemo(
    // With no chat open (threadId unset) a closed chat's tab stays out of the row too, so only a terminal is left (KERNEL-366).
    () => (isLead ? everyChat.filter((c) => !c.closed && (!threadId || c.kind === 'terminal' || threadIdOf(c) === threadId)) : everyChat),
    [everyChat, isLead, threadId]
  )
  const view = useStore((s) => s.ui.workspace)
  const stored = useStore((s) => tabOf(s, workspaceId))
  const tabs = useStore((s) => s.ui.tabs[workspaceId])
  // A chat started from New chat keeps its panel closed until the toggle is pressed in it (KERNEL-788).
  const panels = useStore((s) => panelShownIn(s.ui, workspaceId))
  const held = useStore((s) => s.ui.panelHeld.includes(workspaceId))
  const bottomRatio = useStore((s) => s.ui.bottomRatio)
  // The changed files remember which workspace they were read for, so a late answer or a switch never shows another workspace's files.
  const [fetched, setFetched] = useState<{ workspaceId: string; files: ChangedFile[] }>({ workspaceId, files: NO_CHANGES })
  const changes = fetched.workspaceId === workspaceId ? fetched.files : NO_CHANGES
  const shown = useRef({ workspaceId, request: 0 })
  shown.current.workspaceId = workspaceId
  const [images, setImages] = useState<OpenedImage[]>([])
  const [texts, setTexts] = useState<OpenedText[]>([])
  // + and ⌘T with no chat open switch from whatever tab is showing to the New chat box. Picking a tab goes back to it.
  const [newChat, setNewChat] = useState(false)
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
  const sharedId = tab?.startsWith('shared:') ? tab.slice(7) : undefined
  const image = images.find((i) => i.id === tab)?.part
  const text = texts.find((t) => t.id === tab)?.part
  // A room whose last chat was closed has no chat to show: New chat is drawn instead, and the first message starts the chat (KERNEL-366).
  // A terminal tab is shown while it is the one open, until + or ⌘T ask for the box (`newChat`).
  const noChat = leadHasNoChat(isLead, everyChat)
  const showNewChat = showsNewChat(noChat, newChat, chats, tab)
  const newChatShown = newChatOnScreen(noChat, newChat, chats, tab)
  const chat = filePath || diffPath !== undefined || sharedId || image || text ? chats.find((c) => c.id === lastChat) ?? chats[0] : chats.find((c) => c.id === tab) ?? chats[0]
  const files = tabs?.files ?? NO_TABS
  const diffs = tabs?.diffs ?? NO_TABS
  const shared = tabs?.shared ?? NO_TABS
  const running = useStore((s) => (chat ? !!s.running[chat.id] : false))
  // A chat waiting for setup holds its messages in main (KERNEL-430), so you can keep typing: they queue behind it.
  const heldForSetup = useStore((s) => (chat ? !!s.queue[chat.id]?.length && s.queueWhy[chat.id] === 'setup' : false))
  const skips = !!ws && skipsSetup(ws, heldForSetup)
  const found = useBanner(ws, chat, agent?.name ?? 'The agent', running, skips)
  const empty = useStore((s) => (chat ? !s.items[chat.id]?.length : true))

  // Images and pasted texts belong to the screen, not the store, so they start empty for each workspace. A tab of one left in the
  // store from before goes back to the chat, or the sidebar and closing a chat would still think it is the one on screen.
  useEffect(() => {
    setImages([]); setTexts([]); setNewChat(false)
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
    if (!id) return
    setNewChat(false)
    actions.ui.openTab(workspaceId, id)
  }, [workspaceId])
  const showNew = useCallback(() => {
    setNewChat(true)
    actions.ui.setTabs(workspaceId, { tab: undefined })
  }, [workspaceId])
  // Asked for the composer with a file, diff or shared tab in front and no chat open, the box takes its place (leadNoChat.ts).
  const latest = useRef({ noChat, tab })
  latest.current = { noChat, tab }
  useEffect(() => bringBoxOnAsk(workspaceId, () => latest.current, showNew), [workspaceId, showNew])
  useWorkspaceShortcuts({ workspaceId, chatId: chat?.id, openDiff: (path) => select(diffTab(path)) })

  if (!ws) return <div className="panel" />
  // A Lead chat with work of its own shows its PR actions, Create PR included, like a teammate's (KERNEL-405, D-106).
  // In Build here the chat is a builder from its first turn, so its PR header shows before it has changes (KERNEL-780).
  const ownPr = !isLead || (isLeadChatWorkspace(ws) && (leadModeOf(ws) === 'build' || hasChanges(ws) || !!ws.prNumber || ws.prState !== 'none'))
  const title = headerTitle(ws)
  // the Lead's shared worktree and a current-branch workspace say what they follow instead of a branch. That label carries meaning, so it
  // stays, and it has no copy: the title is plain text there.
  const label = ws.mode === 'current' ? `current branch · ${ws.branch}` : ws.lead && ws.branch === 'HEAD' ? `latest ${leadBase(ws, room)}` : undefined
  // A chat waiting for setup shows what waits and where setup stands (KERNEL-430). It draws a failed setup as its own card, so the
  // banner doesn't say it a second time. A teammate's brief still on its way keeps the box shut, so nothing goes out before it. A chat
  // with the Lead that isn't held shows its transcript and stays open while setup runs (KERNEL-490).
  const gate = setupGate({ status: ws.status, skips, held: heldForSetup, empty })
  const setupWait = gate.wait && chat?.kind !== 'terminal'
  const banner = setupWait && found?.id === 'setup' ? undefined : found
  const blocked = gate.shut || !!banner?.blocks

  // The tabs as ChatTabs lists them, left to right. Closing the open one goes back to the tab used before it (nextTab.ts).
  const order = [...chats.map((c) => c.id), ...files.map(fileTab), ...diffs.map(diffTab), ...shared.map((id) => `shared:${id}`), ...images.map((i) => i.id), ...texts.map((t) => t.id)]
  const afterClosing = (id: string) => { const to = nextTab(order, tabs?.recent, [id], tab) ?? chat?.id; if (tab === id && to) select(to) }
  const openFile = (path: string) => select(fileTab(path))
  const closeFile = (path: string) => {
    actions.ui.setTabs(workspaceId, { files: files.filter((x) => x !== path) })
    afterClosing(fileTab(path))
  }
  /** The same diff again selects its tab. An empty path is All changes. */
  const openDiff = (path: string) => select(diffTab(path))
  const closeDiff = (path: string) => {
    actions.ui.setTabs(workspaceId, { diffs: diffs.filter((x) => x !== path) })
    afterClosing(diffTab(path))
  }
  /** Closing drops the version picked in the tab too, so opening the file again follows the latest. */
  const closeShared = (id: string) => {
    const { [id]: _picked, ...picks } = tabs?.sharedVersion ?? {}
    actions.ui.setTabs(workspaceId, { shared: shared.filter((x) => x !== id), sharedVersion: picks })
    afterClosing(`shared:${id}`)
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
    afterClosing(id)
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
    afterClosing(id)
  }
  // New chat is the only tab while the room has no chat and nothing else is open, so the row is its one tab (KERNEL-788).
  const alone = newChatShown && !order.length
  const changed = filePath ? changes.some((c) => c.path === filePath) : false

  // The header spans the chat column only. The right panel runs the full height and carries the PR actions at its top;
  // while it is hidden they move into the header, in a capsule, so Create PR and Merge stay one click away. The panel toggle is window
  // chrome, not a PR action, so it stays in the window's top right corner: the header's last item while the panel is hidden, the end of
  // the panel's head while it is open, in a neutral cell beside the PR band so it never takes the band's tone (KERNEL-769).
  return (
    <div className="panel ws-panel">
      {newChatShown ? <NewChatHeader room={room} /> : <header className="header">
        <SidebarToggle />
        <RoomIcon room={room} className="crumb-avatar" />
        <button type="button" className="crumb" onClick={() => room && void openRoom(room.id)}>{room?.name}</button>
        <span className="muted"><Icon name="right" size={12} /></span>
        {label ? <h1 className="ellipsis">{title}</h1> : <WorkspaceTitle branch={ws.branch} title={title} />}
        {label && <span className="mono muted ellipsis ws-label">{label}</span>}
        <IssueKey ws={ws} room={room} />
        <span className="grow" />
        <OpenIn ws={ws} />
        {!panels && (ownPr ? <PrHeader ws={ws} capsule /> : <LeadPrSummary roomId={ws.roomId} capsule quiet={held} />)}
        {!panels && <RightPanelToggle name="panels" />}
      </header>}
      <OpenImage.Provider value={openImage}>
      <OpenText.Provider value={openText}>
        <section aria-label="Agent" className="ws-main">
          {alone ? <NewChatTab /> : <ChatTabs workspaceId={workspaceId} threadId={isLead ? chats.find((c) => c.kind === 'chat')?.threadId : undefined} noChat={noChat} onNewChat={showNew} chats={chats} files={files} diffs={diffs} shared={shared} images={images.map((i) => ({ id: i.id, name: i.part.name }))} texts={texts.map((t) => ({ id: t.id, name: t.part.name }))} active={newChatShown ? undefined : tab} onSelect={select} onCloseFile={closeFile} onCloseDiff={closeDiff} onCloseShared={closeShared} onCloseImage={closeImage} onCloseText={closeText} />}
          <div className="col grow" style={{ minHeight: 0 }}>
            {diffPath !== undefined
              ? <DiffView ws={ws} path={diffPath} changes={changes} />
              : sharedId
                ? <SharedView workspaceId={workspaceId} sharedId={sharedId} />
              : filePath
                ? <FileView ws={ws} path={filePath} changed={changed} editedBy={agent?.name} />
                : image
                  ? <ImageView name={image.path ?? image.name} src={image.dataUrl} width={image.width} height={image.height} />
                : text
                  ? <TextView name={text.name} text={text.text} />
                // A chat waiting for setup shows what waits and where setup stands, not a skeleton or the New chat suggestions.
                : setupWait
                  ? <SetupWait ws={ws} chat={chat} />
                  : showNewChat
                    ? <NewLeadChat roomId={ws.roomId} focusIn={workspaceId} />
                  : chat?.kind === 'terminal'
                    ? <><SkipNotice chat={chat} /><TerminalView id={chat.id} label="Big terminal" /></>
                  : chat
                    ? <Transcript chat={chat} workspaceId={workspaceId} changes={changes} onEdit={edit} onOpenDiff={openDiff} onForked={select} />
                    : <div className="grow" />}
          </div>
          {chat && chat.kind !== 'terminal' && <Composer chat={chat} agent={agent} blocked={blocked} running={running} prefill={prefill} where={<WhereRow room={room} mode={ws.mode} branch={<WhereBranch branch={ws.branch} />} />} banner={<>{isLead && chat.kind === 'chat' && <OpenItems chat={chat} />}{banner && <WorkspaceBanner view={banner} ws={ws} chat={chat} />}</>} />}
        </section>
      </OpenText.Provider>
      </OpenImage.Provider>
      {panels && !newChatShown && (
        <aside ref={aside} aria-label="Workspace panels" className="ws-aside" style={panelWidth === null ? undefined : { width: `max(${PANEL_MIN}px, min(${panelWidth}px, 100cqw - ${CHAT_MIN}px))` }}>
          <ResizeHandle
            targetRef={aside} edge="left" label="Resize panel" size={panelWidth ?? panelDefault()} min={PANEL_MIN} limit={panelLimit} defaultSize={panelDefault}
            storageKey={PANEL_KEY} hideBelow={PANEL_HIDE_BELOW} onHide={() => actions.ui.setRightPanel(false)} onCommit={setPanelWidth}
          />
          <div className="ws-aside-head">
            {ownPr ? <PrHeader ws={ws} spread toggle={<RightPanelToggle name="panels" />} /> : <LeadPrSummary roomId={ws.roomId} spread toggle={<RightPanelToggle name="panels" />} />}
          </div>
          {ownPr && <LocalMergeInfo ws={ws} />}
          {/* Below the PR band the panel is two panes, 2/3 over 1/3 until the bottom is dragged. The one fraction is every chat's (KERNEL-513). */}
          <div className="ws-split" style={{ '--bottom-ratio': bottomRatio } as CSSProperties}>
            <RightPanel ws={ws} changes={changes} onOpenFile={openFile} onOpenDiff={openDiff} filePath={filePath} diffPath={diffPath || undefined} />
            <BottomPanel ws={ws} />
          </div>
        </aside>
      )}
    </div>
  )
}

/**
 * The New chat page (KERNEL-788): the `leadNew` route, the same two header rows as a chat and the box below. No workspace exists before
 * the first message, which makes the chat's own worktree (KERNEL-405), so there is no right panel. `source` and `picks` are the route's.
 */
export function LeadNewScreen({ roomId, source, picks }: { roomId: string; source?: WorkspaceSource; picks?: NewChatPicks }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  return (
    <div className="panel ws-panel">
      <NewChatHeader room={room} />
      <section aria-label="Agent" className="ws-main">
        <NewChatTab />
        <div className="col grow" style={{ minHeight: 0 }}><NewLeadChat roomId={roomId} source={source} picks={picks} /></div>
      </section>
    </div>
  )
}

/** The title, a real button: hovering shows the full branch and clicking copies it (HeaderBranchTooltip.png). It is the one thing in the header that gives way to a narrow window. */
function WorkspaceTitle({ branch, title }: { branch: string; title: string }) {
  return (
    <h1 className="ws-title">
      <button type="button" className="ws-title-btn" aria-label={`${title}, copy branch ${branch}`} data-tip={branch} data-tip-hint="Click to copy the branch" data-tip-align="start" onClick={() => void copyBranch(branch)}>
        <span>{title}</span>
      </button>
    </h1>
  )
}

/**
 * The issue a workspace started on, after the branch (WorkspaceIssue.png). A Linear key opens the Issues screen on it, in the workspace's
 * room, and a GitHub issue opens its page. A key with no page to open is plain text.
 */
function IssueKey({ ws, room }: { ws: WorkspaceModel; room?: Room }) {
  const source = ws.source
  if (source?.kind !== 'issue') return null
  const tracker = issueTracker(source)
  if (tracker === 'linear') return <button type="button" className="ws-issue" aria-label={`Open issue ${source.id}`} title={source.title} onClick={() => actions.ui.go({ name: 'issues', issueId: source.id, roomId: ws.roomId })}>{source.id}</button>
  const url = tracker === 'github' ? githubIssueUrl(source, room) : source.url
  if (!url) return <span className="ws-issue" title={source.title}>{source.id}</span>
  return <button type="button" className="ws-issue" aria-label={`Open issue ${source.id}`} title={source.title} onClick={() => void call('system.openExternal', { url })}>{source.id}</button>
}
