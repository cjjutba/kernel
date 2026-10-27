import { isRemote } from '../../remote/isRemote'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ChangedFile, NewChatPicks, Project, Workspace as WorkspaceModel, WorkspaceSource } from '@shared/types'
import { call } from '../../api'
import { actions, getState, loadWorkspace, NEW_CHAT_HELD, panelShownIn, useStore } from '../../store'
import { EmptyState, Icon } from '../../ui'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { FocusChip, railShownIn, ViewToggles } from '../../components/PanelToggles'
import { ResizeHandle, readWidth } from '../../components/ResizeHandle'
import { isLeadWorkspace, leadOf, openProject } from '../../lead'
import { currentThread, tabOf, threadIdOf } from '../../nav'
import { ProjectIcon } from '../../components/ProjectIcon'
import { ChatTabs, diffTab, fileTab } from './ChatTabs'
import { FileLinkScope } from './fileLinks'
import { bringBoxOnAsk, leadHasNoChat, newChatOnScreen, showsNewChat } from './leadNoChat'
import { bottomKindOf } from './bottomSplit'
import { NewChatHeader, NewChatTab, OneRowHeader } from './NewChatBar'
import { NewLeadChat } from './NewLeadChat'
import { nextTab } from './nextTab'
import { OpenIn } from './OpenIn'
import { followIssue, OpenImage, OpenIssue, OpenText, type ImagePart, type TextPart } from './composer/Chip'
import { Composer } from './composer/Composer'
import { OpenItems } from './composer/OpenItems'
import { DiffView, FileView, ImageView, TextView } from './FileView'
import { BottomDrawer } from './BottomDrawer'
import { RightPanel } from './Panels'
import { SharedView } from './shared/SharedView'
import { PrTitleBar } from './pr/PrTitleBar'
import { LeadRail, NewChatRail } from './LeadRail'
import { SessionRail } from './SessionRail'
import { SkipNotice } from './terminal/SkipNotice'
import { TerminalView } from './terminal/Terminal'
import { WorktreeWait } from './WorktreeWait'
import { setupGate, skipsSetup } from './setupGate'
import { Transcript } from './Transcript'
import { useBanner, useProblemToast, WorkspaceBanner } from './banners/Banners'
import { ChatMoveNotice, useMoveNotice } from './banners/ChatMoveNotice'
import { FellBackLine } from './banners/FellBackLine'
import { onRefreshChanges } from './changesBus'
import { issueOpen, issueUrl } from './issueKey'
import { useProjectTracker } from '../issues/useProjectTracker'
import { useWorkspaceShortcuts } from './shortcuts'
import './workspace.css'
import './panel.css'

const EMPTY_CHATS: never[] = []
const NO_TABS: string[] = []
const NO_CHANGES: ChangedFile[] = []
const PANEL_MIN = 320
const PANEL_MAX = 960
const PANEL_KEY = 'kernel.rightPanelWidth'
/** Letting go below this hides the panel. The saved width stays. */
const PANEL_HIDE_BELOW = 240
/** The chat column keeps at least this much, however wide the panel was saved. */
const CHAT_MIN = 420
/** What `.ws-aside` is until the user drags: 48% of the window between 420 and 880px, so its CSS and this agree (KERNEL-1096). */
const panelDefault = () => Math.min(880, Math.max(420, Math.round(window.innerWidth * 0.48)))
let imageCount = 0
let textCount = 0

/** An attached image open in a tab. Its tab id is `image:<n>`. */
interface OpenedImage { id: string; part: ImagePart }

/** A pasted text open in a tab. Its tab id is `text:<n>`. */
interface OpenedText { id: string; part: TextPart }

/**
 * The branch the shared Lead worktree from before KERNEL-405 follows, for the header's "latest main" (KERNEL-355): the project's default
 * branch when the base is that branch on its remote or locally, so only a remote name comes off ("release/v2" stays whole), else the
 * base as it is.
 */
const leadBase = (ws: WorkspaceModel, project?: Project) => {
  const d = project?.defaultBranch
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

/** Header, tabs, transcript, composer, the bottom drawer, and the right panel (Workspace.png). */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const project = useStore((s) => s.projects.find((r) => r.id === ws?.projectId))
  const { read: trackerRead } = useProjectTracker(ws?.projectId)
  const issueCtx = useMemo(() => ({ project, tracker: trackerRead.kind === 'ready' ? trackerRead.tracker : undefined }), [project, trackerRead])
  const agent = useStore((s) => (ws ? s.agents[ws.projectId]?.find((a) => a.id === ws.agentId) : undefined))
  const everyChat = useStore((s) => s.chats[workspaceId] ?? EMPTY_CHATS)
  // The Lead's workspace shows one chat at a time: that chat's tabs, then the files. Its other chats' tabs are rows in the sidebar (KERNEL-338).
  const isLead = useStore((s) => !!ws && isLeadWorkspace(ws, ws.projectId, leadOf(s.agents, ws.projectId)?.id))
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
  const railWanted = useStore((s) => railShownIn(s.ui, workspaceId))
  const sidebar = useStore((s) => s.ui.sidebar)
  // Expand: the panel takes the whole screen, chat included, until it is pressed again.
  const [expanded, setExpanded] = useState(false)
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
  // A page, file, image, text or diff fills the column, so the composer under it is one line until something opens it (KERNEL-934).
  const viewer = diffPath !== undefined || !!sharedId || !!filePath || !!image || !!text
  // A project whose last chat was closed has no chat to show: New chat is drawn instead, and the first message starts the chat (KERNEL-366).
  // A terminal tab is shown while it is the one open, until + or ⌘T ask for the box (`newChat`).
  const noChat = leadHasNoChat(isLead, everyChat)
  const showNewChat = showsNewChat(noChat, newChat, chats, tab)
  const newChatShown = newChatOnScreen(noChat, newChat, chats, tab)
  const chat = filePath || diffPath !== undefined || sharedId || image || text ? chats.find((c) => c.id === lastChat) ?? chats[0] : chats.find((c) => c.id === tab) ?? chats[0]
  const files = tabs?.files ?? NO_TABS
  const diffs = tabs?.diffs ?? NO_TABS
  const shared = tabs?.shared ?? NO_TABS
  const running = useStore((s) => (chat ? !!s.running[chat.id] : false))
  // A chat whose worktree isn't made yet holds its messages in main (KERNEL-430), so you can keep typing: they queue behind it. The
  // setup script never holds them (KERNEL-1086).
  const heldForSetup = useStore((s) => (chat ? !!s.queue[chat.id]?.length && s.queueWhy[chat.id] === 'worktree' : false))
  const skips = !!ws && skipsSetup(heldForSetup)
  const empty = useStore((s) => (chat ? !s.items[chat.id]?.length : true))
  const found = useBanner(ws, chat, agent?.name ?? 'The agent', running)
  useProblemToast(found)
  const moveNotice = useMoveNotice(chat)

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
  // A Lead chat shows its PR actions, Create PR included, like a teammate's (KERNEL-405, D-106). Every chat may build, so its PR
  // header shows before it has changes (KERNEL-780, one-lead-chat).
  const ownPr = !isLead || isLeadChatWorkspace(ws)
  // the Lead's shared worktree and a current-branch workspace say what they follow instead of a branch. That label carries meaning, so it
  // stays, and it has no copy: the title is plain text there.
  const label = ws.mode === 'current' ? `current branch · ${ws.branch}` : ws.lead && ws.branch === 'HEAD' ? `latest ${leadBase(ws, project)}` : undefined
  // A chat waiting for its worktree shows its message and what is under way (KERNEL-430). A teammate's brief still on its way keeps the
  // box shut, so nothing goes out before it. A chat that isn't held shows its transcript and stays open while setup runs, and a run or
  // a worktree that fails is a toast (KERNEL-490, KERNEL-1086, KERNEL-1093).
  const gate = setupGate({ status: ws.status, skips, held: heldForSetup, empty })
  const setupWait = gate.wait && chat?.kind !== 'terminal'
  const problem = found
  // Only a limit that needs a choice is a banner. Provider, network and Mac errors are a toast, and the box says why it can't send (Pen 14.7).
  const banner = problem && !problem.as ? problem : undefined
  const blocked = gate.shut || !!problem?.blocks

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
  // New chat is the only tab while the project has no chat and nothing else is open, so the row is its one tab (KERNEL-788).
  const alone = newChatShown && !order.length
  const changed = filePath ? changes.some((c) => c.path === filePath) : false

  // The header is one row over both columns (Pen 9.1): the project, then the chat and file tabs in one pill, then what acts on the workspace, then the view toggles. The panel and
  // the Session rail are cards under it. A teammate's workspace and a chat with Kernel show their Session rail on the right while the panel is closed, and the title bar's toggles swap one for the
  // other. Neither is Focus mode (KERNEL-1096).
  const rail = railWanted && !newChatShown
  const focus = !sidebar && !panels && !rail
  const tabsRow = alone ? <NewChatTab /> : (
    <ChatTabs
      inline note={label} branch={isLead && ws.lead && ws.mode === 'worktree' && ws.branch !== 'HEAD' ? ws.branch : undefined} tip={isLead ? undefined : ws.branch}
      workspaceId={workspaceId} threadId={isLead ? chats.find((c) => c.kind === 'chat')?.threadId : undefined} noChat={noChat} onNewChat={showNew} chats={chats} files={files} diffs={diffs} shared={shared}
      images={images.map((i) => ({ id: i.id, name: i.part.name }))} texts={texts.map((t) => ({ id: t.id, name: t.part.name }))} active={newChatShown ? undefined : tab}
      onSelect={select} onCloseFile={closeFile} onCloseDiff={closeDiff} onCloseShared={closeShared} onCloseImage={closeImage} onCloseText={closeText}
    />
  )
  return (
    <div className="panel ws-panel" data-rail={rail || undefined} data-panel={(panels && !newChatShown) || undefined} data-expanded={(expanded && panels && !newChatShown) || undefined}>
      <OneRowHeader project={project} end={!newChatShown && <>
        {focus && <FocusChip />}
        <IssueKey ws={ws} project={project} />
        {/* The pull request's own place is the Session rail and the Pull request tab. With neither on screen, its state moves here: an icon, its number, a few words and the one action (Pen 10.3). */}
        {ownPr && !rail && !(panels && !newChatShown) && <PrTitleBar ws={ws} />}
        {!isRemote() && <OpenIn ws={ws} />}
        <ViewToggles kind={bottomKindOf(getState(), ws)} />
      </>}>
        {tabsRow}
      </OneRowHeader>
      <FileLinkScope.Provider value={workspaceId}>
      <OpenImage.Provider value={openImage}>
      <OpenText.Provider value={openText}>
      <OpenIssue.Provider value={issueCtx}>
        <section aria-label="Agent" className="ws-main">
          <div className={viewer || (chat?.kind === 'terminal' && !setupWait && !showNewChat) ? 'col grow view-card' : 'col grow'} style={{ minHeight: 0 }}>
            {diffPath !== undefined
              ? <DiffView ws={ws} path={diffPath} changes={changes} stepper={diffPath ? { index: Math.max(0, changes.findIndex((c) => c.path === diffPath)), total: changes.length, go: (i) => { const to = changes[i]?.path; if (to !== undefined) openDiff(to) } } : undefined} />
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
                  ? <WorktreeWait ws={ws} chat={chat} />
                  : showNewChat
                    ? <NewLeadChat projectId={ws.projectId} focusIn={workspaceId} />
                  : chat?.kind === 'terminal'
                    ? <><SkipNotice chat={chat} /><TerminalView id={chat.id} label="Big terminal" /></>
                  : chat
                    ? <Transcript chat={chat} workspaceId={workspaceId} changes={changes} onEdit={edit} onOpenDiff={openDiff} onForked={select} moveNotice={banner ? null : moveNotice} />
                    : <div className="grow" />}
          </div>
          {chat && chat.kind !== 'terminal' && <Composer chat={chat} agent={agent} blocked={blocked} why={problem?.placeholder ?? (moveNotice && !banner ? 'Pick an account above to keep going' : undefined)} setupShown={setupWait} running={running} prefill={prefill} viewer={viewer ? { held: banner ? banner.actions.length > 0 : !!moveNotice } : undefined} banner={<>{isLead && chat.kind === 'chat' && <OpenItems chat={chat} />}{banner && <WorkspaceBanner view={banner} ws={ws} chat={chat} />}{chat.kind === 'chat' && <FellBackLine chat={chat} />}</>} />}
          {/* The drawer sits under the chat and its composer, the width of the chat column. The title bar toggle and ⌘J open it. */}
          {!newChatShown && <BottomDrawer ws={ws} />}
        </section>
      </OpenIssue.Provider>
      </OpenText.Provider>
      </OpenImage.Provider>
      </FileLinkScope.Provider>
      {panels && !newChatShown && (
        <aside ref={aside} aria-label="Workspace panels" className="ws-aside" style={panelWidth === null ? undefined : { width: `max(${PANEL_MIN}px, min(${panelWidth}px, 100cqw - ${CHAT_MIN}px))` }}>
          <ResizeHandle
            targetRef={aside} edge="left" label="Resize panel" size={panelWidth ?? panelDefault()} min={PANEL_MIN} limit={panelLimit} defaultSize={panelDefault}
            storageKey={PANEL_KEY} hideBelow={PANEL_HIDE_BELOW} onHide={() => actions.ui.setRightPanel(false)} onCommit={setPanelWidth}
          />
          <section className="side-card" aria-label="Panels">
            <RightPanel ws={ws} changes={changes} onOpenFile={openFile} onOpenDiff={openDiff} filePath={filePath} diffPath={diffPath || undefined} expanded={expanded} onExpand={() => setExpanded((e) => !e)} />
          </section>
        </aside>
      )}
      {rail && (isLead ? <LeadRail ws={ws} threadId={threadId} /> : <SessionRail ws={ws} />)}
    </div>
  )
}

/**
 * The New chat page (KERNEL-788): the `leadNew` route, the same two header rows as a chat and the box below. No workspace exists before
 * the first message, which makes the chat's own worktree (KERNEL-405), so the Session rail and the right panel show an empty state and the
 * toggles work as in a chat, bar the bottom pane. `source` and `picks` are the route's.
 */
export function LeadNewScreen({ projectId, source, picks }: { projectId: string; source?: WorkspaceSource; picks?: NewChatPicks }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
  // Each visit starts on the Session rail, as a chat started from here does. The panel's toggle opens the panel, and that releases the hold.
  useEffect(() => { actions.ui.holdPanel(NEW_CHAT_HELD) }, [])
  const panels = useStore((s) => panelShownIn(s.ui, NEW_CHAT_HELD))
  const rail = useStore((s) => railShownIn(s.ui, NEW_CHAT_HELD))
  const focus = useStore((s) => !s.ui.sidebar && !panelShownIn(s.ui, NEW_CHAT_HELD) && !railShownIn(s.ui, NEW_CHAT_HELD))
  return (
    <div className="panel ws-panel" data-rail={rail || undefined} data-panel={panels || undefined}>
      <NewChatHeader project={project} end={<>{focus && <FocusChip />}<ViewToggles /></>} />
      <section aria-label="Agent" className="ws-main">
        <div className="col grow" style={{ minHeight: 0 }}><NewLeadChat projectId={projectId} source={source} picks={picks} /></div>
      </section>
      {panels && (
        <aside aria-label="Workspace panels" className="ws-aside">
          <section className="side-card" aria-label="Panels">
            <div className="rail-nothing grow"><EmptyState icon="panelRight" title="No panels yet">Files, changes and the terminal of this chat show up here once you send the first message.</EmptyState></div>
          </section>
        </aside>
      )}
      {rail && <NewChatRail />}
    </div>
  )
}

/**
 * The issue a workspace started on, after the branch (WorkspaceIssue.png). A Linear key opens the Issues screen on it, in the workspace's
 * project when its tracker is the issue's, else its page in the browser (KERNEL-898). A key with no page to open is plain text.
 */
function IssueKey({ ws, project }: { ws: WorkspaceModel; project?: Project }) {
  const { read } = useProjectTracker(ws.projectId)
  const source = ws.source
  if (source?.kind !== 'issue') return null
  const target = issueOpen(source, project, read.kind === 'ready' ? read.tracker : undefined)
  if (target.kind === 'none') return <span className="ws-issue" title={source.title}>{source.id}</span>
  return <button type="button" className="ws-issue" aria-label={`Open issue ${source.id}`} title={source.title} onClick={(e) => followIssue(target, issueUrl(source, project), e, source.id)}>{source.id}</button>
}
