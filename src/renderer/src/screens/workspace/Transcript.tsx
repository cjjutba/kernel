import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Approval, ChangedFile, Chat, ChatItem, ChatPart, LeadMode } from '@shared/types'
import { leadModeName, leadModeOf, leadModeSwitched } from '@shared/leadMode'
import { maskSecrets, stripAnsi, toolView } from '@shared/toolView'
import { call } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { Avatar, Button, Card, EmptyState, Icon, IconButton, Spinner, useBusy, type IconName } from '../../ui'
import { ServiceMark } from '../../icons'
import { actions, getState, go, loadWorkspace, setLeadMode, useStore } from '../../store'
import { openProject } from '../../lead'
import { floorProjectId, noteLinkTarget } from './noteLink'
import { NoteText } from './NoteText'
import { ApprovalCard } from './cards/ApprovalCard'
import { waitingPlan } from './cards/steps'
import { ErrorCard } from './cards/ErrorCard'
import { Markdown } from './markdown'
import { attempt, CopyOverlay, MessageActions, useCopy, type MessageAction } from './MessageActions'
import { ChipIcon, fileView, HoverPreview, ImageButton, IssueButton, isPastedText, OpenImage, TextButton, type ImagePart } from './composer/Chip'
import { foldHeader, settle, wantOpen, windowEntries, WAITING, WINDOW } from './fold'
import { buildThread, countsLabel, fmtDuration, messageLabel, runLabel, turnFiles, type Entry, type Run, type ThreadBlock } from './thread'
import { InstructionCard } from './pr/InstructionCard'
import { instructionOf } from './pr/model'
import { userView } from './sender'
import { KernelNote } from './KernelNote'
import { SharedCard } from './cards/SharedCard'
import { TeamUpdateCard } from './cards/TeamUpdateCard'
import { LocalMergeRow } from './pr/LocalMerge'
import { ReviewCard } from './pr/ReviewCard'
import { LEAD_MODE_ICON } from './composer/modes'
import { retryMessage, sendMessage } from './composer/sendMessage'
import { ChatWelcome, LEAD_SUGGESTIONS, SUGGESTIONS } from './ChatWelcome'
import { ChatRail } from './ChatRail'
import { countNew, holdView, leftAtEnd, opensAtEnd, placeTop, readPlace, savePlace, takePlace, TranscriptChat, useRowOpen, type RowBox } from './chatPlace'
import { RAIL_MIN, railEntries, sameEntries } from './railEntries'
import { createGlider, type Glider } from './scrollGlide'
import { TranscriptGlide } from './glideContext'

const EMPTY: ChatItem[] = []
/** A plan revealing itself within this long of the chat opening is placed, not glided. */
const OPEN_MS = 600
/** The reader counts as following the chat while the end is this close. */
const PIN_PX = 80

/** The PR state icons a note draws before its text, the same glyphs as the PR header (KERNEL-313). */
const NOTE_GLYPH: Record<NonNullable<Extract<ChatItem, { kind: 'note' }>['pr']>, IconName> = { merged: 'merged', closed: 'prClosed', cifail: 'prCifail' }

/** The user's own send is what a reader scrolled up follows. A bubble with a sender, the Lead handing work to a teammate, arrives while they read and leaves them where they are. */
export const followsSend = (item: ChatItem | undefined) => item?.kind === 'user' && !item.from && userView(item) === 'bubble'

/** What a reader calls a message: a reply, or a message from a teammate or the team. Steps, tool rows, thinking and approvals are not, and the reader's own send follows them to the end. */
export const isMessage = (item: ChatItem) => item.kind === 'text' || (item.kind === 'user' && !followsSend(item) && ['bubble', 'update'].includes(userView(item)))

/** The numbers a scroll position is read from, so the rule below runs without a layout engine. */
export interface ScrollView { scrollTop: number; scrollHeight: number; clientHeight: number }

/** Whether rows are scrolled off the top, which is when the top edge fades. At the very top nothing is above, so nothing fades. */
export const scrolledOff = (scrollTop: number) => scrollTop > 0

/** Milliseconds a message counts as posted from the queue after the queue last held one. */
export const QUEUE_POST_MS = 2000

/**
 * What the thread does when a message arrives (KERNEL-891): follow it to the end at once, or leave the view where it is. Only the reader's own message follows, and only a new one.
 * `open` is false only for the run that is the chat opening. A queued message posts while the reader may be reading: it follows only while they are still at the end (`pinned`).
 */
export const sendFollow = (last: ChatItem | undefined, seenId: string | null, open = true, fromQueue = false, pinned = true): 'follow' | 'keep' => {
  if (!open || !last || !followsSend(last) || last.id === seenId) return 'keep'
  return fromQueue && !pinned ? 'keep' : 'follow'
}

/** Whether a message that just posted came from the queue: the queue held one a moment ago. */
export const postedFromQueue = (queuedAt: number, now: number) => now - queuedAt < QUEUE_POST_MS

const distFromEnd = (v: ScrollView) => v.scrollHeight - v.scrollTop - v.clientHeight

const rangeOf = (v: ScrollView) => v.scrollHeight - v.clientHeight

/** The keys that scroll the view. The rest (the number keys and Enter on a card, typing) arm nothing. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/**
 * Whether the chat keeps following its end after a scroll event (KERNEL-605). `before` is the view at the last scroll event, and `byHand` is
 * whether the reader's own input (wheel, touch, scrolling keys, the scrollbar, a jump from the chat rail) is behind this scroll.
 * - The view moving up unpins when the reader did it, even by a little, or the next streamed line would pull them straight back. A move nobody
 *   asked for unpins once it lands past PIN_PX, which is how the plan card opening a long plan at its top stops the following.
 * - The reader's scrolling never changes the scroll range. When it changed, layout moved the view, so input that came first doesn't make it theirs:
 *   a question answered by keyboard collapses its card and the browser clamps the view up, with `byHand` still set from the keys.
 * - Anything else only ever follows. The end within PIN_PX means following, and a thread that grew under a view at its end moves no scroll
 *   position, only the distance, which the thread's size observer closes. Our own scroll to the end and the browser clamping or anchoring
 *   the view after rows resize therefore never unpin.
 */
export function followsAfterScroll(pinned: boolean, view: ScrollView, before: ScrollView, byHand: boolean): boolean {
  const own = byHand && rangeOf(view) === rangeOf(before)
  if (view.scrollTop < before.scrollTop && (own || distFromEnd(view) > PIN_PX)) return false
  return distFromEnd(view) <= PIN_PX ? true : pinned
}

/**
 * Whether following may move the view (KERNEL-629). Not while the reader's own gesture or its momentum is under way, and not when the view is already
 * at its end, since a jump there cuts the native rubber-band bounce short. Following resumes once the scroll lands.
 */
export const movesToEnd = (view: ScrollView, byHand: boolean) => !byHand && distFromEnd(view) >= 1

/** How long the reader's input counts as scrolling with no scroll event after it. A pull past the end moves nothing and never fires scrollend. */
const HAND_MS = 200

/** Calls `fn` once `ms` pass without another call of the returned function, which restarts the wait. `cancel` drops it. */
export function lapse(ms: number, fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const restart = () => { clearTimeout(timer); timer = setTimeout(fn, ms) }
  restart.cancel = () => clearTimeout(timer)
  return restart
}

const partsText = (parts: ChatPart[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')

export function PartChip({ part, gone }: { part: ChatPart; gone?: boolean }) {
  if (part.type === 'text') return null
  const view = fileView(part, gone)
  const body = <>{part.type === 'skill' ? <span aria-hidden="true" className="muted">/</span> : <ChipIcon part={part} />}<span className="chip-name">{view ? view.label : part.name}</span>{view?.size && <span className="chip-meta">{view.size}</span>}</>
  if (part.type === 'image' && part.dataUrl) return <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className="msg-chip" data-kind="image">{body}</ImageButton>
  if (isPastedText(part)) return <TextButton paste={part} className="msg-chip" data-kind="file">{body}</TextButton>
  if (part.type === 'issue') return <IssueButton issue={part} className="msg-chip" data-kind="issue">{body}</IssueButton>
  return <span className="msg-chip" data-tip={view?.tip} data-tip-hint={view?.hint} data-state={view?.state} data-kind={part.type}>{body}</span>
}

/** True when a revert to this checkpoint would change something: it is linked and the worktree isn't already there. */
function useRevertable(workspaceId: string, checkpointId: string | undefined): boolean {
  return useStore((s) => !!checkpointId && !s.checkpoints[workspaceId]?.some((c) => c.current && c.id === checkpointId))
}

const revertAction = (workspaceId: string, checkpointId: string, label: string, start?: boolean): MessageAction =>
  ({ icon: 'history', label, onClick: () => actions.ui.openModal({ name: 'confirm', kind: 'revert', workspaceId, checkpointId, ...(start ? { start } : {}) }) })

function UserMessage({ item, workspaceId, onEdit }: { item: Extract<ChatItem, { kind: 'user' }>; workspaceId: string; onEdit: (text: string) => void }) {
  const revertable = useRevertable(workspaceId, item.checkpointId)
  const archived = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.status === 'archived')
  const more: MessageAction[] = revertable && item.checkpointId ? [revertAction(workspaceId, item.checkpointId, 'Revert files to start of chat', true)] : []
  return (
    <div className="msg msg-user" data-jump={item.id}>
      <div className="bubble">
        {item.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text} </span> : <PartChip key={i} part={p} gone={archived && p.type === 'file' && !!p.path?.startsWith('.kernel/attachments/')} />))}
      </div>
      {/* An answer to a card (KERNEL-838) is not a prompt the reader can edit, so it keeps Copy only. */}
      <MessageActions align="end" label="Message actions" copy={partsText(item.parts)} items={item.approvalId ? [] : [{ icon: 'pen', label: 'Edit', onClick: () => onEdit(partsText(item.parts)) }]}
        more={more.length ? { menu: `reply:${item.id}`, items: more } : undefined} />
    </div>
  )
}

/** The two count columns of the turn files card, so the numbers line up from the header down. A side that is 0 shows nothing. */
function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="tf-n"><span className="add">{added ? `+${added}` : ''}</span><span className="del">{removed ? `-${removed}` : ''}</span></span>
}

const MORE = ':more'

/** Opens the right panel on the Changes tab, the way the header's panel toggle opens it. */
function showChanges() {
  actions.ui.setWorkspaceView({ right: 'changes' })
  actions.ui.setRightPanel(true)
}

/**
 * The files a finished turn created, edited or deleted, each row a button that opens that file's diff (KERNEL-586). From 7 files the
 * card shows the first 5 and a row that opens the rest in place. The rows are one tab stop and the arrow keys move between them.
 */
function TurnFilesCard({ rowId, files, inWorkspace, onOpenDiff }: { rowId: string; files: ChangedFile[]; inWorkspace?: number; onOpenDiff: (path: string) => void }) {
  const [open, setOpen] = useRowOpen(useContext(TranscriptChat), `${rowId}:files`, false)
  const [stop, setStop] = useState<string>()
  const v = useMemo(() => turnFiles(files), [files])
  const rows = open ? [...v.shown, ...v.hidden] : v.shown
  const keys = [...rows.map((r) => r.path), ...(v.hidden.length ? [MORE] : [])]
  const tabbable = stop && keys.includes(stop) ? stop : keys[0]
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = ({ ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity } as Record<string, number>)[e.key]
    if (!step) return
    const list = Array.from(e.currentTarget.querySelectorAll('button'))
    const at = list.indexOf(e.target as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    list[Math.max(0, Math.min(list.length - 1, at + step))].focus()
  }
  return (
    <Card className="tf" role="group" aria-label="Files changed in this reply">
      <div className="tf-h"><span className="tf-c">{v.title}</span><Counts added={v.added} removed={v.removed} />
        {inWorkspace !== undefined && <button type="button" className="tf-all" aria-label={`Show all ${inWorkspace} changed ${inWorkspace === 1 ? 'file' : 'files'} in this workspace`} onClick={showChanges}>{inWorkspace} in workspace</button>}
      </div>
      <div className="tf-b" onKeyDown={move}>
        {rows.map((r) => (
          <button key={r.path} type="button" className="tf-r" data-gone={r.deleted || undefined} aria-label={r.label} tabIndex={r.path === tabbable ? 0 : -1} onFocus={() => setStop(r.path)} onClick={() => onOpenDiff(r.path)}>
            <FileIcon path={r.path} size={16} />
            <span className="tf-nm">{r.name}</span>
            <span className="tf-dir">{r.dir}</span>
            <span className="tf-mk">{r.marker}</span>
            <Counts added={r.added} removed={r.removed} />
          </button>
        ))}
        {v.hidden.length > 0 && (
          <button key={MORE} type="button" className="tf-r tf-more" aria-expanded={open} tabIndex={tabbable === MORE ? 0 : -1} onFocus={() => setStop(MORE)} onClick={() => setOpen(!open)}
            aria-label={open ? 'Show less' : [`Show ${v.hidden.length} more`, countsLabel(v.hiddenAdded, v.hiddenRemoved)].filter(Boolean).join(', ')}>
            <span className="tf-chev" data-open={open}><Icon name="chevron" size={16} /></span>
            <span className="tf-nm">{open ? 'Show less' : `Show ${v.hidden.length} more`}</span>
            {!open && <Counts added={v.hiddenAdded} removed={v.hiddenRemoved} />}
          </button>
        )}
      </div>
    </Card>
  )
}

interface FootProps { id: string; chatId: string; workspaceId: string; copy?: string; checkpointId?: string; hasFiles: boolean; meta?: string; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown> }

/** Copy, Retry and the "..." menu that forks and, where a finished turn changed files, reverts them to that turn (KERNEL-766). `id` is the row Retry and the forks start from. Fork into new workspace only shows where the workspace has its own worktree. */
function ReplyFoot({ id, chatId, workspaceId, copy, checkpointId, hasFiles, meta, onFork, onForkWorkspace }: FootProps) {
  const revertable = useRevertable(workspaceId, hasFiles ? checkpointId : undefined)
  const forks: MessageAction[] = [{ icon: 'fork', label: 'Fork into new tab', busyLabel: 'Forking', onClick: () => onFork(id) }]
  if (onForkWorkspace) forks.push({ icon: 'branch', label: 'Fork into new workspace', busyLabel: 'Forking', onClick: () => onForkWorkspace(id) })
  if (revertable && checkpointId) forks.push(revertAction(workspaceId, checkpointId, 'Revert files to here'))
  return (
    <MessageActions label="Message actions" copy={copy} meta={meta}
      items={[{ icon: 'refresh', label: 'Retry', busyLabel: 'Retrying', onClick: () => attempt('Could not retry', () => call('chats.retry', { chatId, itemId: id })) }]}
      more={{ menu: `reply:${id}`, items: forks }} />
  )
}

interface ReplyProps { item: Extract<ChatItem, { kind: 'text' }>; chatId: string; workspaceId: string; checkpointId?: string; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown>; files?: ChangedFile[]; inWorkspace?: number; meta?: string; full?: boolean; onOpenDiff: (path: string) => void }

/**
 * An agent line. Most only offer Copy, as an overlay that takes no height. The reply that ends a finished turn (`meta`) and the last line of a
 * stopped or cut-off turn (`full`) carry Copy, Retry and the "..." menu (KERNEL-828). The reply that ends a finished turn also carries the turn's files and
 * its time, which leads the actions' row (KERNEL-346).
 */
function ReplyMessage({ item, chatId, workspaceId, checkpointId, onFork, onForkWorkspace, files, inWorkspace, meta, full, onOpenDiff }: ReplyProps) {
  return (
    <div className="msg msg-reply" data-copy={!full && meta === undefined ? '' : undefined}>
      <Markdown text={item.text} />
      {files && <TurnFilesCard rowId={item.id} files={files} inWorkspace={inWorkspace} onOpenDiff={onOpenDiff} />}
      {full || meta !== undefined
        ? <ReplyFoot id={item.id} chatId={chatId} workspaceId={workspaceId} copy={item.text} checkpointId={checkpointId} hasFiles={!!files?.length} meta={meta} onFork={onFork} onForkWorkspace={onForkWorkspace} />
        : <CopyOverlay text={item.text} />}
    </div>
  )
}

/** The end of a finished turn that doesn't end on a message: its time, then the actions the reply would have carried (KERNEL-828). */
function TurnEnd({ block, chatId, workspaceId, onFork, onForkWorkspace }: { block: Extract<ThreadBlock, { kind: 'meta' }> } & Pick<BlockProps, 'chatId' | 'workspaceId' | 'onFork' | 'onForkWorkspace'>) {
  const a = block.actions!
  return <ReplyFoot id={block.id} chatId={chatId} workspaceId={workspaceId} copy={a.copy} checkpointId={a.checkpointId} hasFiles={a.files} meta={block.text} onFork={onFork} onForkWorkspace={onForkWorkspace} />
}

/**
 * A project link (see noteLink.ts) opens that project, in its Lead chat. A web link opens in the browser,
 * never in the app window (KERNEL-294). Any other href shows as plain text.
 */
function NoteLink({ link }: { link: { label: string; href: string } }) {
  switch (noteLinkTarget(link.href)) {
    case 'project': return <a href={link.href} onClick={(e) => { e.preventDefault(); void openProject(floorProjectId(link.href)!) }}>{link.label}</a>
    case 'external': return <a href={link.href} onClick={(e) => { e.preventDefault(); void attempt('Could not open the link', () => call('system.openExternal', { url: link.href })) }}>{link.label}</a>
    default: return <span>{link.label}</span>
  }
}

type Tool = Extract<ChatItem, { kind: 'tool' }>

/**
 * What a step says, for every kind of row: the icon (or a file's icon, a service's mark, an avatar) in a 15px slot, the label, then the
 * muted object. A row that can open puts its chevron over the icon, in the same slot (KERNEL-562). Folded, open and live rows all draw it.
 */
function StepLine({ icon, glyph, failed, label, detail, preview, keep, chip, mono, meta, open, chev }: {
  icon?: IconName; glyph?: ReactNode; failed?: boolean; label: ReactNode; detail?: string; chip?: ReactNode; mono?: boolean; meta?: ReactNode; open?: boolean
  preview?: ReactNode; keep?: boolean; chev?: boolean
}) {
  return (
    <>
      {(glyph || icon) && (
        <span className={`step-slot${glyph ? ' step-glyph' : ''}`} style={glyph ? undefined : { color: failed ? 'var(--del)' : 'var(--muted)' }}>
          {glyph || <Icon name={icon!} size={16} />}
          {chev && <span className="chev step-chev" data-open={open} aria-hidden="true"><Icon name="right" size={12} /></span>}
        </span>
      )}
      <span className="ellipsis" style={{ maxWidth: 300, flexShrink: 0, color: failed ? 'var(--del)' : 'var(--ink-2)' }}>{label}</span>
      {chip ? <span className="grow step-chip">{chip}</span> : <span className={`grow muted ellipsis${mono ? ' mono' : ''}`} style={mono ? { fontSize: 12 } : undefined} aria-hidden={mono ? undefined : true}>{mono || keep || !open ? preview ?? detail : null}</span>}
      {meta && <span className="mono muted" style={{ fontSize: 11.5 }}>{meta}</span>}
    </>
  )
}

/**
 * One step of the agent's work: a button that opens in place to what it did (KERNEL-198). On hover and focus the row's icon
 * turns into the chevron, in the same 15px slot, and the chevron stays while the row is open (KERNEL-562). A row whose preview
 * is its own text (thinking, a message) drops the preview once open. With nothing to show the row is inert and keeps its icon.
 * Open state is local, so a tool going from running to done keeps it.
 */
/** `glyph` draws in the icon's place, as a file's icon on a Read, Edit or Write row. `chip` draws after the label in the detail's place, as the image on a Read image row. */
function StepRow({ icon, glyph, failed, label, detail, preview, keep, name, chip, mono, meta, startOpen, onOpen, onPeek, peek, children }: {
  icon?: IconName; glyph?: ReactNode; failed?: boolean; label: ReactNode; detail?: string; chip?: ReactNode; mono?: boolean; meta?: string
  /** The row starts open, as a run with a failure does inside an open fold. */
  startOpen?: boolean
  /** The sentence a screen reader reads for the row, in place of its label and preview. */
  name?: string
  /** Draws in the detail's place, and `keep` leaves it in place once the row is open. */
  preview?: ReactNode; keep?: boolean
  /** Runs on click before the row opens, and resolves true when it handled the click, so the row stays closed. */
  onOpen?: () => Promise<boolean>
  /** Runs when the row is hovered or focused from the keyboard, so `peek` can load. `peek` is drawn as the hover preview once it is there. */
  onPeek?: () => void
  peek?: ReactNode
  children?: ReactNode
}) {
  const [open, setOpen] = useState(!!startOpen)
  const [at, setAt] = useState<DOMRect | null>(null)
  const panel = useId()
  const can = !!children
  const show = (el: HTMLElement) => { setAt(el.getBoundingClientRect()); onPeek?.() }
  // The preview is placed once, so a scroll under it hides it rather than leave it behind.
  useEffect(() => {
    if (!at) return
    const hide = () => setAt(null)
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [at])
  const click = () => {
    setAt(null)
    if (!onOpen) return setOpen(!open)
    void onOpen().then((handled) => { if (!handled) setOpen((o) => !o) })
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <button
        type="button" className="trow trow-btn" aria-label={name} aria-expanded={can ? open : undefined} aria-controls={can ? panel : undefined} disabled={!can} onClick={click}
        {...(onPeek && {
          onMouseEnter: (e: MouseEvent<HTMLElement>) => show(e.currentTarget), onMouseLeave: () => setAt(null),
          // Focus shows it from the keyboard only, so a click doesn't bring it back.
          onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget) }, onBlur: () => setAt(null),
          onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (e.key === 'Escape' && at) { e.stopPropagation(); setAt(null) } }
        })}
      >
        <StepLine icon={icon} glyph={glyph} failed={failed} label={label} detail={detail} preview={preview} keep={keep} chip={chip} mono={mono} meta={meta} open={open} chev={can} />
      </button>
      {at && peek && <HoverPreview at={at} className="img-preview">{peek}</HoverPreview>}
      {open && can && <div id={panel} className="step-body">{children}</div>}
    </div>
  )
}

/** Rows compare their item, so a step that didn't change isn't drawn again when its neighbours do. `StepRow` below takes its body as children, a new element every time, so the skip has to happen here. */
const ThinkingRow = memo(function ThinkingRow({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }) {
  return <StepRow icon="bulb" label="Thought">{item.text.trim() && <div className="step-text">{item.text}</div>}</StepRow>
})

/** An in-between message as a step (KERNEL-840): its first line as the label, the whole message as Markdown once open, in the muted ink of thinking, with Copy on hover and focus. */
const MessageRow = memo(function MessageRow({ item }: { item: Extract<ChatItem, { kind: 'text' }> }) {
  const [copied, copy] = useCopy(item.text)
  const label = messageLabel(item.text)
  return (
    <StepRow icon="chat" label={label} name={`Message: ${label}`}>
      <div className="step-msg">
        <div className="step-text"><Markdown text={item.text} /></div>
        <div className="step-copy"><IconButton icon={copied ? 'check' : 'copy'} size={14} label={copied ? 'Copied' : 'Copy message'} onClick={copy} /></div>
      </div>
    </StepRow>
  )
})

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** One side of a diff per line, prefixed: what an edit took out in red and put in in green. */
function EditDiff({ from, to }: { from: string; to: string }) {
  return (
    <>
      {from.split('\n').map((l, i) => <div key={`-${i}`} className="del">-{l}</div>)}
      {to.split('\n').map((l, i) => <div key={`+${i}`} className="add">+{l}</div>)}
    </>
  )
}

/** A unified diff, as Codex's file changes write it: added and removed lines in colour, hunk headers faint, the rest in ink. */
function PatchDiff({ patch }: { patch: string }) {
  return (
    <>
      {patch.split('\n').map((l, i) => {
        const kind = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''
        return <div key={i} className={kind || undefined}>{l || ' '}</div>
      })}
    </>
  )
}

const looksLikePatch = (t: string) => /^(diff --git |--- |@@ )/m.test(t)

/** A response that parses as JSON is shown indented, the way the request is. Anything else is left as it came. */
function prettyJson(t: string): string {
  const s = t.trim()
  if (!/^[[{]/.test(s)) return t
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return t }
}

/**
 * One section of an opened row: a small muted heading with its Copy button always in the corner, then the text, capped at 260px. When the text
 * is cut a fade shows at the bottom, and goes once it is scrolled to the end. `text` is what Copy copies.
 */
function ToolSection({ title, note, text, label, children }: { title: string; note?: string; text: string; label: string; children: ReactNode }) {
  const [copied, copy] = useCopy(text)
  const body = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState({ scrolls: false, more: false })
  const measure = useCallback(() => {
    const el = body.current
    if (!el) return
    const next = { scrolls: el.scrollHeight > el.clientHeight + 1, more: el.scrollHeight - el.scrollTop - el.clientHeight > 1 }
    setCut((c) => (c.scrolls === next.scrolls && c.more === next.more ? c : next))
  }, [])
  useLayoutEffect(measure)
  const id = useId()
  return (
    <section className="tool-sec" aria-labelledby={id}>
      <header className="tool-head">
        <span id={id} className="tool-title">{title}</span>
        {note && <span className="tool-note">{note}</span>}
        <IconButton icon={copied ? 'check' : 'copy'} size={14} label={copied ? 'Copied' : label} onClick={copy} />
      </header>
      <div ref={body} className="tool-body" data-more={cut.more || undefined} tabIndex={cut.scrolls ? 0 : undefined} role={cut.scrolls ? 'region' : undefined} aria-labelledby={cut.scrolls ? id : undefined} onScroll={measure}>{children}</div>
    </section>
  )
}

interface Piece { title: string; note?: string; node: ReactNode; text: string }

/** The tool's input as the text a person would have typed: the command, the path, the pattern, the prompt. Anything else is JSON. Secrets are masked. */
function inputView(item: Tool): Piece | null {
  const i = item.input
  if (!i || !Object.keys(i).length) return null
  const lines = (...rows: (string | undefined)[]) => rows.filter((r): r is string => r !== undefined).join('\n')
  const plain = (title: string, t: string | undefined, note?: string): Piece | undefined => t ? { title, note, text: maskSecrets(t), node: maskSecrets(t) } : undefined
  const diff = (pairs: { from: string; to: string }[]): Piece => {
    const masked = pairs.map((p) => ({ from: maskSecrets(p.from), to: maskSecrets(p.to) }))
    return {
      title: 'Changes',
      node: masked.map((p, n) => <EditDiff key={n} from={p.from} to={p.to} />),
      text: masked.flatMap((p) => [...p.from.split('\n').map((l) => `-${l}`), ...p.to.split('\n').map((l) => `+${l}`)]).join('\n')
    }
  }
  const known = ((): Piece | undefined => {
    switch (item.name) {
      case 'Bash': return plain('Command', text(i.command) && `$ ${i.command}`)
      case 'Edit': return typeof i.old_string === 'string' && typeof i.new_string === 'string' ? diff([{ from: i.old_string, to: i.new_string }]) : undefined
      case 'MultiEdit': {
        const edits = Array.isArray(i.edits) ? i.edits.filter((e): e is { old_string: string; new_string: string } => !!e && typeof e.old_string === 'string' && typeof e.new_string === 'string') : []
        return edits.length ? diff(edits.map((e) => ({ from: e.old_string, to: e.new_string }))) : undefined
      }
      case 'Write': {
        if (typeof i.content !== 'string') return undefined
        const n = i.content ? i.content.split('\n').length : 0
        return plain('Contents', i.content, `${n} ${n === 1 ? 'line' : 'lines'}`)
      }
      case 'Read': return plain('Input', text(i.file_path) && lines(text(i.file_path), typeof i.offset === 'number' ? `offset: ${i.offset}` : undefined, typeof i.limit === 'number' ? `limit: ${i.limit}` : undefined))
      case 'Grep': case 'Glob': return plain('Input', text(i.pattern) && lines(`pattern: ${text(i.pattern)}`, text(i.path) && `path: ${text(i.path)}`))
      case 'Agent': case 'Task': return plain('Prompt', text(i.prompt))
      default: return undefined
    }
  })()
  if (!known && FILE_TOOLS.has(item.name)) return null
  return known ?? plain('Request', JSON.stringify(i, null, 2)) ?? null
}

/** The tool's output as a section. A file change from Codex has no input to diff, so its output, a unified diff, is the Changes section. */
function outputView(item: Tool, hide: boolean): Piece | null {
  if (!item.output || hide) return null
  const clean = maskSecrets(stripAnsi(item.output))
  const mcp = item.name.startsWith('mcp__')
  const fileTool = item.name === 'Edit' || item.name === 'MultiEdit' || item.name === 'Write'
  if (fileTool && looksLikePatch(clean)) return { title: 'Changes', text: clean, node: <PatchDiff patch={clean} /> }
  const shown = prettyJson(clean)
  const cut = item.outputCut && <span className="step-cut">Output cut at 20,000 characters</span>
  return { title: item.name === 'Bash' ? 'Output' : mcp || !inputIsText(item) ? 'Response' : 'Output', text: shown, node: <>{shown}{cut}</> }
}

/** A file tool's input is its path, which the row already says, so with no text to show it has no input section. */
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const TEXT_INPUT = new Set(['Bash', 'Read', 'Grep', 'Glob', 'Agent', 'Task', 'Edit', 'MultiEdit', 'Write'])
const inputIsText = (item: Tool) => TEXT_INPUT.has(item.name)

/** The call as it was made, for whoever wants to replay or report it. Masked like everything the row shows. */
const rawCall = (item: Tool) => maskSecrets(JSON.stringify({ name: item.name, input: item.input, output: item.output }, null, 2))

function CopyRaw({ item }: { item: Tool }) {
  const [copied, copy] = useCopy(rawCall(item))
  return <Button variant="ghost" icon={copied ? 'check' : 'copy'} className="tool-raw" onClick={copy}>{copied ? 'Copied' : 'Copy raw call'}</Button>
}

/** The tool calls whose output the turn's error card already shows, by item id, so their rows don't say it twice. */
const ShownInError = createContext<ReadonlySet<string>>(new Set())

/** What a tool shows when opened: one card with its input and its output as sections, and Copy raw call in its footer. A tool with neither has nothing to open. */
function toolBody(item: Tool, hideOutput = false): ReactNode {
  const input = inputView(item)
  const output = outputView(item, hideOutput)
  if (!input && !output) return null
  return (
    <div className="tool-card">
      {input && <ToolSection title={input.title} note={input.note} text={input.text} label={`Copy ${input.title.toLowerCase()}`}>{input.node}</ToolSection>}
      {output && <ToolSection title={output.title} note={output.note} text={output.text} label={`Copy ${output.title.toLowerCase()}`}>{output.node}</ToolSection>}
      <footer className="tool-foot"><CopyRaw item={item} /></footer>
    </div>
  )
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

/** The image a Read row opened, by its file's path. Codex's view_image calls are Read rows too, so the provider doesn't matter. */
function readImage(item: Tool): string | undefined {
  if (item.name !== 'Read') return undefined
  const path = text(item.input?.file_path) ?? item.detail
  return path && IMAGE_FILE.test(path) ? path : undefined
}

/** The workspace a transcript belongs to, so a Read image row can load its file. */
const TranscriptWorkspace = createContext<string | null>(null)

/** A path a Read row named, made relative to the workspace folder as `workspaces.readImage` takes it. Null when it is absolute and outside the folder. */
function workspaceRelative(path: string, root?: string): string | null {
  const base = root?.replace(/[\\/]+$/, '')
  if (base && (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`))) return path.slice(base.length + 1)
  return /^([\\/]|[a-zA-Z]:[\\/])/.test(path) ? null : path
}

/**
 * A Read row on an image file. Clicking opens the image in a tab beside the chat, as a chip in a message does; hovering the row shows the
 * same small preview. The file loads on the first hover, focus or click and is kept. When it can't load (deleted, outside the workspace
 * folder, too big) or there is no tab to open it in, the click opens the row to the path as any other row (KERNEL-671).
 */
function ReadImageRow({ item, image, file, meta }: { item: Tool; image: string; file?: string; meta?: string }) {
  const workspaceId = useContext(TranscriptWorkspace)
  const root = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path)
  const openImage = useContext(OpenImage)
  const [loaded, setLoaded] = useState<ImagePart | null>(null)
  const pending = useRef<Promise<ImagePart | null> | null>(null)
  const rel = workspaceRelative(image, root)
  const name = image.split(/[\\/]/).pop() ?? image
  const view = toolView(item, { root })
  const load = (): Promise<ImagePart | null> => {
    if (loaded) return Promise.resolve(loaded)
    if (!workspaceId || rel === null) return Promise.resolve(null)
    pending.current ??= call('workspaces.readImage', { workspaceId, path: rel, at: 'worktree' })
      .then((r): ImagePart | null => (r ? { type: 'image', name, path: rel, dataUrl: r.dataUrl } : null))
      .catch(() => null)
      .then((part) => { if (part) setLoaded(part); else pending.current = null; return part })
    return pending.current
  }
  return (
    <StepRow
      icon="term" glyph={file && <FileIcon path={file} size={15} />} failed={view.state === 'failed'}
      label={`${view.verb} image`} name={`${view.verb} image: ${name}`} detail={item.detail} chip={<PartChip part={{ type: 'image', name }} />}
      mono meta={meta}
      onPeek={openImage ? () => void load() : undefined} peek={loaded && <img src={loaded.dataUrl} alt="" />}
      onOpen={openImage ? async () => { const part = await load(); if (!part) return false; openImage(part); return true } : undefined}
    >
      {toolBody(item)}
    </StepRow>
  )
}

/** The agent a workspace belongs to, by name, for a message_agent row. */
const agentNamed = (workspaceId: unknown) => (s: ReturnType<typeof getState>) => {
  const ws = typeof workspaceId === 'string' ? s.workspaces.find((w) => w.id === workspaceId) : undefined
  return ws && s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name
}

/** How a tool call looks as a step: its label, mark and object, the same in a fold and open in the thread. */
function useToolLook(item: Tool) {
  const workspaceId = useContext(TranscriptWorkspace)
  const root = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path)
  const target = useStore(agentNamed(item.name.endsWith('__message_agent') ? item.input?.workspace_id : undefined))
  const view = useMemo(() => toolView(item, { root, agentOf: target ? () => target : undefined }), [item, root, target])
  const mark = view.file ? <FileIcon path={view.file} size={15} /> : view.agent ? <Avatar name={view.agent} size={15} /> : view.service ? <span className="step-mark"><ServiceMark name={view.service} size={15} /></span> : undefined
  return { view, mark }
}

const ToolRow = memo(function ToolRow({ item, meta }: { item: Tool; meta?: string }) {
  const { view, mark } = useToolLook(item)
  const shown = useContext(ShownInError).has(item.id)
  if (view.hidden) return null
  const image = readImage(item)
  if (image) return <ReadImageRow item={item} image={image} file={view.file ?? item.detail} meta={meta} />
  const detail = shown ? undefined : view.detail
  const preview = (view.object || view.dir || detail) && (
    <>
      {view.object && <span className={view.mono ? 'step-cmd mono' : 'step-obj'}>{view.object}</span>}
      {view.dir && <span className="step-dir">{view.dir}</span>}
      {detail && <span className="step-det">{detail}</span>}
    </>
  )
  return (
    <StepRow
      icon="term" glyph={mark} failed={view.state === 'failed'}
      label={view.verb} preview={preview} keep name={view.sentence} meta={meta}
    >
      {toolBody(item, shown)}
    </StepRow>
  )
})

/** Edit and Write calls show what they added and removed, read from the changed files. Any other step shows how long it took once that is 5s or more. */
function toolMeta(item: Tool, changes: ChangedFile[]): string {
  const file = (item.name === 'Edit' || item.name === 'Write') && changes.find((c) => c.path === item.detail)
  if (file) return [file.added ? `+${file.added}` : '', file.removed ? `-${file.removed}` : ''].filter(Boolean).join(' ')
  return item.durationMs !== undefined && item.durationMs >= 5000 ? `${(item.durationMs / 1000).toFixed(item.durationMs < 10_000 ? 1 : 0)}s` : ''
}

/** A row in the folded list: every step the turn took before its reply, in order, each closed until opened. */
const GroupItem = memo(function GroupItem({ item, meta, full }: { item: ChatItem; meta?: string; full?: boolean }) {
  // The newest step of a running turn that is a message streams in full, as the reply will read under the fold; once another step follows, it is a row.
  if (item.kind === 'text' && full) return <div className="group-item"><div className="msg msg-reply"><Markdown text={item.text} /></div></div>
  if (item.kind === 'tool') return toolView(item).hidden ? null : <div className="group-item"><ToolRow item={item} meta={meta} /></div>
  if (item.kind === 'thinking') return <div className="group-item"><ThinkingRow item={item} /></div>
  if (item.kind === 'text') return <div className="group-item"><MessageRow item={item} /></div>
  return null
})

/**
 * Calls of one verb on one service as one row: "Filed 7 issues in Linear". It keeps the service's mark, says what failed in red after the sentence,
 * and opens to each call as its own row. Inside an open fold a run with a failure is already open (KERNEL-784). Closed, it draws nothing but its line.
 */
const RunRow = memo(function RunRow({ run, changes, startOpen }: { run: Run; changes: ChangedFile[]; startOpen?: boolean }) {
  const { text, bad } = runLabel(run)
  const mark = run.service ? <span className="step-mark"><ServiceMark name={run.service} size={15} /></span> : undefined
  return (
    <StepRow
      icon="term" glyph={mark} failed={!run.done && !!bad} startOpen={startOpen && !!bad}
      label={<>{text}{bad && <span className="step-bad">, {bad}</span>}</>} name={bad ? `${text}, ${bad}` : text}
    >
      <div className="run-list">
        {run.items.map((i) => <GroupItem key={i.id} item={i} meta={i.kind === 'tool' ? toolMeta(i, changes) : undefined} />)}
      </div>
    </StepRow>
  )
}, (a, b) => (a.run === b.run || (a.run.id === b.run.id && sameList(a.run.items, b.run.items) && a.run.failed === b.run.failed)) && a.changes === b.changes && a.startOpen === b.startOpen)

const GroupEntry = memo(function GroupEntry({ entry, changes, full }: { entry: Entry; changes: ChangedFile[]; full?: boolean }) {
  if (entry.kind === 'run') return <div className="group-item"><RunRow run={entry.run} changes={changes} startOpen /></div>
  return <GroupItem item={entry.item} meta={entry.item.kind === 'tool' ? toolMeta(entry.item, changes) : undefined} full={full} />
}, (a, b) => a.full === b.full && (a.entry === b.entry || (a.entry.kind === 'item' && b.entry.kind === 'item' && a.entry.item === b.entry.item) || (a.entry.kind === 'run' && b.entry.kind === 'run' && a.entry.run.id === b.entry.run.id && sameList(a.entry.run.items, b.entry.run.items))) && a.changes === b.changes)

/** Whether the reader is away from the end of the transcript, which a fold waits on before it closes under them. */
const TranscriptAway = createContext(false)

/** Whether the reader has text selected inside `el`. */
const selectingIn = (el: HTMLElement | null) => {
  const sel = getSelection()
  return !!el && !!sel && !sel.isCollapsed && !!sel.anchorNode && el.contains(sel.anchorNode)
}

const reduced = () => document.documentElement.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A stretch of steps. Its header is one row that changes tense (`foldHeader`). By default it is open while its turn runs and folds when the turn ends;
 * a fold the reader opened or closed keeps that, and Settings, Appearance, Tool calls picks the other two ways. A fold waits to close until the
 * reader is at the end and holds no selection in it. A running fold lists its newest steps, with the rest behind a row at the top.
 */
function ToolGroup({ block, changes }: { block: Extract<ThreadBlock, { kind: 'group' }>; changes: ChangedFile[] }) {
  const chatId = useContext(TranscriptChat)
  const mode = useStore((s) => s.ui.workspace.toolCalls ?? 'auto')
  const away = useContext(TranscriptAway)
  const { turn } = block
  const want = wantOpen(mode, turn.live)
  const [manual, setManual, touched] = useRowOpen(chatId, block.id, want)
  const [shown, setShown] = useState(want)
  const box = useRef<HTMLDivElement>(null)
  const pending = shown && !want && !touched
  useEffect(() => {
    const run = () => setShown((cur) => settle({ shown: cur, want, touched, mode, away, selecting: selectingIn(box.current) }))
    run()
    if (!pending) return
    document.addEventListener('selectionchange', run)
    return () => document.removeEventListener('selectionchange', run)
  }, [want, touched, mode, away, pending])
  const open = touched ? manual : shown
  // The list leaves the page after its fold-up has played. A short turn, and reduced motion, skip it.
  const animates = !turn.short && !(typeof matchMedia === 'function' && reduced())
  const [mounted, setMounted] = useState(open)
  const first = useRef(true)
  useLayoutEffect(() => {
    if (open || !mounted) { setMounted(open); return }
    if (!animates) { setMounted(false); return }
    const t = setTimeout(() => setMounted(false), 200)
    return () => clearTimeout(t)
  }, [open, animates]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { first.current = false }, [])
  const [all, setAll] = useRowOpen(chatId, `${block.id}:earlier`, false)
  const { shown: rows, earlier } = windowEntries(block.entries, turn.live, all)
  const id = `${block.id}-list`
  const head = foldHeader(turn, block.summary)
  const { bad } = block.summary
  const last = block.entries[block.entries.length - 1]
  return (
    <div className="col" style={{ gap: 2 }} ref={box}>
      <button type="button" className="group-btn" aria-expanded={open} aria-controls={id} onClick={() => setManual(!open)}>
        <span className="chev" data-open={open}><Icon name="right" size={12} /></span>
        <span className="group-text">
          {head}{bad && <span className="step-bad">, {bad}</span>}
        </span>
      </button>
      {mounted && (
        <div className="group-collapse" data-open={open} data-animate={animates && !first.current ? '' : undefined}>
          <div id={id} className="group-list">
            {earlier > 0 && (
              <button type="button" className="group-earlier" aria-expanded={false} onClick={() => setAll(true)}>{earlier} earlier {earlier === 1 ? 'step' : 'steps'}</button>
            )}
            {rows.map((e) => <GroupEntry key={e.kind === 'run' ? e.run.id : e.item.id} entry={e} changes={changes} full={turn.live && e === last && e.kind === 'item' && e.item.kind === 'text'} />)}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The line at the end of a running turn, under every fold, card and note: the spinner and the seconds since the turn started, counted from the message's own
 * timestamp so it is right after a reload. While a request waits on the reader it says "Waiting for you", with no spinner and no clock.
 */
function TurnLine({ since, waiting }: { since: number; waiting: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (waiting) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [waiting])
  return waiting
    ? <span className="running">{WAITING}</span>
    : <span className="running"><Spinner label="Working" pattern="spiral" />{fmtDuration(now - since)}</span>
}

/** One line across the thread where the chat switched between Hand off and Build here, so the transcript shows which turns could edit (KERNEL-780). */
function LeadModeDivider({ mode }: { mode: LeadMode }) {
  return <div className="mode-divider" role="separator" aria-label={leadModeSwitched(mode)}><Icon name={LEAD_MODE_ICON[mode]} size={14} /><span>{leadModeSwitched(mode)}</span></div>
}

/** Under Kernel's reply when the work is bigger than one PR: one button, only for the newest suggestion with no mode switch after it, and only while the chat is still in Build here. Kernel never switches on its own. */
function ModeSuggestion({ workspaceId, chatId, itemId, mode }: { workspaceId: string; chatId: string; itemId: string; mode: LeadMode }) {
  const current = useStore((s) => leadModeOf(s.workspaces.find((w) => w.id === workspaceId)))
  const live = useStore((s) => {
    const list = s.items[chatId] ?? EMPTY
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].kind === 'leadMode') return false
      if (list[i].kind === 'modeSuggestion') return list[i].id === itemId
    }
    return false
  })
  const [busy, run] = useBusy()
  if (current === mode || !live) return null
  return (
    <div className="mode-suggest">
      <Button icon={LEAD_MODE_ICON[mode]} busy={!!busy} busyLabel="Switching" onClick={() => void run('Switching', () => attempt('Could not switch', () => setLeadMode(workspaceId, mode)))}>Switch to {leadModeName(mode)}</Button>
    </div>
  )
}

function ApprovalRow({ id }: { id: string }) {
  const a = useStore((s) => s.approvals.find((x) => x.id === id))
  return a ? <ApprovalCard approval={a} inChat /> : null
}

const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** buildThread makes new block objects on every run, so a block is the same when what it draws is. Items keep their identity until they change. */
function sameBlock(a: ThreadBlock, b: ThreadBlock): boolean {
  if (a === b) return true
  switch (a.kind) {
    case 'item': return b.kind === 'item' && a.item === b.item && a.actions === b.actions
    case 'group': return b.kind === 'group' && a.id === b.id && sameList(a.items, b.items) && a.turn.live === b.turn.live && a.turn.timer === b.turn.timer && a.turn.startedAt === b.turn.startedAt && a.turn.durationMs === b.turn.durationMs && a.turn.short === b.turn.short
    case 'files': return b.kind === 'files' && a.id === b.id && sameList(a.files, b.files)
    case 'meta': return b.kind === 'meta' && a.id === b.id && a.text === b.text && a.actions?.copy === b.actions?.copy && a.actions?.files === b.actions?.files && a.actions?.checkpointId === b.actions?.checkpointId && !a.actions === !b.actions
    case 'reply': return b.kind === 'reply' && a.item === b.item && a.meta === b.meta && a.checkpointId === b.checkpointId && sameList(a.files ?? [], b.files ?? [])
    case 'relaunch': return b.kind === 'relaunch' && a.note === b.note && a.message === b.message
    case 'error': return b.kind === 'error' && a.id === b.id && a.message === b.message && a.output === b.output
  }
}

interface BlockProps { block: ThreadBlock; chatId: string; workspaceId: string; changes: ChangedFile[]; inWorkspace?: number; agentName: string; onEdit: (text: string) => void; onOpenDiff: (path: string) => void; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown>; onTerminal: () => Promise<unknown> }

/** Only a tool group reads the changed files, so a new list redraws the groups and nothing else. */
const sameProps = (a: BlockProps, b: BlockProps) =>
  sameBlock(a.block, b.block) && a.chatId === b.chatId && a.workspaceId === b.workspaceId && a.inWorkspace === b.inWorkspace && a.agentName === b.agentName && a.onEdit === b.onEdit && a.onOpenDiff === b.onOpenDiff && a.onFork === b.onFork && a.onForkWorkspace === b.onForkWorkspace && a.onTerminal === b.onTerminal
  && (a.block.kind !== 'group' || a.changes === b.changes)

const Block = memo(function Block({ block, chatId, workspaceId, changes, inWorkspace, agentName, onEdit, onOpenDiff, onFork, onForkWorkspace, onTerminal }: BlockProps) {
  if (block.kind === 'error') {
    return (
      <ErrorCard message={block.message} output={block.output} agentName={agentName} onTerminal={onTerminal}
        onFix={() => sendMessage(chatId, [{ type: 'text', text: `Fix this: ${block.message}` }])}
        onRetry={() => retryMessage(chatId, block.id)} />
    )
  }
  if (block.kind === 'group') return <ToolGroup block={block} changes={changes} />
  if (block.kind === 'relaunch') return <KernelNote item={block.message} lead={block.note.text} />
  if (block.kind === 'meta') return block.actions ? <TurnEnd block={block} chatId={chatId} workspaceId={workspaceId} onFork={onFork} onForkWorkspace={onForkWorkspace} /> : <span className="meta">{block.text}</span>
  if (block.kind === 'files') return <TurnFilesCard rowId={block.id} files={block.files} inWorkspace={inWorkspace} onOpenDiff={onOpenDiff} />
  if (block.kind === 'reply') return <ReplyMessage item={block.item} chatId={chatId} workspaceId={workspaceId} checkpointId={block.checkpointId} onFork={onFork} onForkWorkspace={onForkWorkspace} files={block.files} inWorkspace={inWorkspace} meta={block.meta} onOpenDiff={onOpenDiff} />
  const item = block.item
  switch (item.kind) {
    case 'user': {
      const sent = instructionOf(item)
      if (sent) return <InstructionCard part={sent} />
      const view = userView(item)
      return view === 'update' ? <div className="jump-anchor" data-jump={item.id}><TeamUpdateCard item={item} chatId={chatId} /></div> : view === 'note' ? <KernelNote item={item} /> : view === 'hidden' ? null : <UserMessage item={item} workspaceId={workspaceId} onEdit={onEdit} />
    }
    case 'text': return <ReplyMessage item={item} chatId={chatId} workspaceId={workspaceId} full={block.actions} onFork={onFork} onForkWorkspace={onForkWorkspace} onOpenDiff={onOpenDiff} />
    case 'thinking': return <ThinkingRow item={item} />
    case 'tool': return <ToolRow item={item} />
    case 'note': return <div className="note inline" data-pr={item.pr}>{item.pr && <Icon name={NOTE_GLYPH[item.pr]} size={14} />}<span className="note-text"><NoteText text={item.text} refs={item.refs} /></span><span className="note-rule" aria-hidden="true" />{item.link && <NoteLink link={item.link} />}</div>
    case 'interrupted': return <span className="interrupted">INTERRUPTED BY YOU</span>
    case 'approval': return <ApprovalRow id={item.approvalId} />
    case 'shared': return <SharedCard sharedId={item.sharedId} version={item.version} />
    case 'leadMode': return <LeadModeDivider mode={item.mode} />
    case 'modeSuggestion': return <ModeSuggestion workspaceId={workspaceId} chatId={chatId} itemId={item.id} mode={item.mode} />
    // Result is folded into a meta row or an error card by buildThread.
    case 'result': return null
  }
}, sameProps)

interface TranscriptProps { chat: Chat; workspaceId: string; changes: ChangedFile[]; onEdit: (text: string) => void; onOpenDiff: (path: string) => void; onForked: (chatId: string) => void }

/** Each chat is its own view, so its scroll and open rows never carry over from the one before, and leaving it saves where the reader was (KERNEL-765). */
export const Transcript = memo(function Transcript(props: TranscriptProps) {
  return <ChatTranscript key={props.chat.id} {...props} />
})

const blockKey = (b: ThreadBlock) => (b.kind === 'item' ? b.item.id : b.id)

function ChatTranscript({ chat, workspaceId, changes, onEdit, onOpenDiff, onForked }: TranscriptProps) {
  const items = useStore((s) => s.items[chat.id] ?? EMPTY)
  const running = useStore((s) => !!s.running[chat.id])
  const loaded = useStore((s) => !!s.itemsLoaded[chat.id])
  const failed = useStore((s) => !!s.itemsFailed[chat.id]) && !loaded && !items.length
  const loading = !loaded && !failed && !items.length
  const approvals = useStore((s) => s.approvals)
  // The agent is waiting on you, not working, while a request or its plan waits. Both come from the real approvals, so the line at the end of the turn never guesses.
  const planWaits = useStore((s) => !!waitingPlan(s.approvals, chat))
  const agentName = useStore((s) => { const ws = s.workspaces.find((w) => w.id === workspaceId); return s.agents[ws?.projectId ?? '']?.find((a) => a.id === ws?.agentId)?.name ?? 'the agent' })
  const isLead = useStore((s) => { const ws = s.workspaces.find((w) => w.id === workspaceId); return !!s.agents[ws?.projectId ?? '']?.find((a) => a.id === ws?.agentId)?.lead })
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const pr = useStore((s) => s.prs[workspaceId])
  const blocks = useMemo(() => buildThread(items, running), [items, running])
  // The failed step above an error card is the one whose output the card shows, so its row leaves the output out.
  const inError = useMemo(() => {
    const ids = new Set<string>()
    for (const b of blocks) {
      if (b.kind !== 'error' || !b.output) continue
      const end = items.findIndex((i) => i.id === b.id)
      for (let n = end - 1; n >= 0; n--) {
        const i = items[n]
        if (i.kind === 'tool' && i.status === 'failed') { if (i.output === b.output) ids.add(i.id); break }
      }
    }
    return ids
  }, [blocks, items])
  // The blocks that put an element in the thread, in order, so the thread's children line up with them.
  const drawn = useRef<string[]>([])
  drawn.current = blocks.filter((b) => b.kind !== 'item' || !(b.item.kind === 'result' || (b.item.kind === 'user' && !instructionOf(b.item) && userView(b.item) === 'hidden') || (b.item.kind === 'approval' && !approvals.some((a: Approval) => a.id === (b.item as Extract<ChatItem, { kind: 'approval' }>).approvalId)))).map(blockKey)
  const itemsNow = useRef(items)
  itemsNow.current = items
  // What the chat rail lists. A streamed reply redraws the transcript but changes none of this, so the rail keeps its list.
  const listed = useMemo(() => railEntries(items, isLead), [items, isLead])
  const rail = useRef(listed)
  if (!sameEntries(rail.current, listed)) rail.current = listed
  // A pending request shows even before the engine has placed a card for it in the transcript.
  const loose = useMemo(() => {
    const placed = new Set(items.flatMap((i) => (i.kind === 'approval' ? [i.approvalId] : [])))
    return approvals.filter((a: Approval) => a.status === 'pending' && !placed.has(a.id) && a.workspaceId === workspaceId && (!a.chatId || a.chatId === chat.id))
  }, [approvals, items, workspaceId, chat.id])
  const waits = planWaits || approvals.some((a: Approval) => a.status === 'pending' && a.workspaceId === workspaceId && (!a.chatId || a.chatId === chat.id))
  // The chat follows its end only while the reader is at it. Scrolling up to read stops it, scrolling back down starts it again.
  const scroller = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // The Scroll to bottom button shows while the reader is away from the end and not following it. State changes only when it flips, so scrolling doesn't render the transcript on every event.
  const [away, setAway] = useState(false)
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null)
  const awayNow = useRef(false)
  const show = (on: boolean) => {
    if (awayNow.current === on) return
    awayNow.current = on
    setAway(on)
    setBefore(on ? new Set(itemsNow.current.map((i) => i.id)) : null)
  }
  const pin = (at: boolean) => { pinned.current = at; show(!at) }
  // Only the reader's own scrolling can unpin a small move, so layout that shifts the view doesn't. Input arms it, and the scroll landing disarms it.
  const byHand = useRef(false)
  // While a chat is being put back where it was left: the step that sets the view again (the thread calls it when it changes size), and whether it is a spot and not the end.
  const restoring = useRef<{ put: () => void; stop: () => void } | null>(null)
  const spot = useRef(false)
  const endRestore = () => { restoring.current?.stop(); restoring.current = null; spot.current = false }
  const seen = useRef<ScrollView>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
  const remember = (el: ScrollView) => { seen.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } }
  const letGo = useRef<ReturnType<typeof lapse> | undefined>(undefined)
  letGo.current ??= lapse(HAND_MS, () => { byHand.current = false })
  useEffect(() => () => letGo.current?.cancel(), [])
  // The top fade shows only with rows above. The attribute is set on the element and only when it flips, so scrolling never renders the transcript.
  const fade = () => {
    const el = scroller.current
    if (!el) return
    const on = scrolledOff(el.scrollTop)
    if (el.hasAttribute('data-scrolled') !== on) el.toggleAttribute('data-scrolled', on)
  }
  useLayoutEffect(fade)
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    fade()
    if (byHand.current) letGo.current?.()
    // A spot being put back is not the reader's scrolling: a clamped frame near the end must not make the chat follow (KERNEL-918).
    if (!spot.current) pinned.current = followsAfterScroll(pinned.current, el, seen.current, byHand.current)
    remember(el)
    show(!pinned.current && distFromEnd(el) > PIN_PX)
  }
  // A glide to the end (the button's) must not be cut short by following. It ends when it lands, or when the reader takes over.
  // The button's glide passes through "away" on its way down, which never unpins since it only moves toward the end.
  const gliding = useRef(false)
  // The scrolls Kernel makes on its own with a glide go through this one glider (KERNEL-862): Scroll to bottom, the chat rail's jump and a plan revealing itself.
  const glider = useRef<Glider>(undefined as unknown as Glider)
  glider.current ??= createGlider(() => scroller.current)
  const release = () => { gliding.current = false; glider.current.cancel() }
  // The reader's own scrolling ends a glide and holds the view where they left it.
  const take = () => { release(); endRestore(); byHand.current = true; letGo.current?.() }
  const press = (e: KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key) && !(e.target as Element).closest('input, textarea, select, [contenteditable="true"]')) take()
    else release()
  }
  const frame = useRef(0)
  // Rows far above the end are measured a frame after they first show, so the end moves once. Following again next frame lands on it.
  const follow = () => {
    if (gliding.current) return 0
    const move = () => { const el = scroller.current; if (!el || movesToEnd(el, byHand.current)) end.current?.scrollIntoView({ block: 'end' }) }
    move()
    return requestAnimationFrame(() => { if (pinned.current && !gliding.current) move() })
  }
  const followNow = () => { cancelAnimationFrame(frame.current); frame.current = follow() }
  const landed = () => {
    // The glide's own scrolls end in between its frames, which doesn't mean it landed.
    if (glider.current.live()) return
    release()
    byHand.current = false
    if (pinned.current) followNow()
  }
  const toEnd = () => {
    release()
    endRestore()
    byHand.current = false
    pin(true)
    const el = scroller.current
    if (!el) return
    const goalOf = () => Math.max(0, rangeOf(el))
    // Already at the end, nothing would run.
    if (goalOf() - el.scrollTop <= 0) return
    glider.current.start({
      goal: goalOf,
      far: true,
      done: (landed) => { gliding.current = false; if (!landed) return; pin(true); followNow() }
    })
    gliding.current = glider.current.live()
  }
  // The chat rail glides to a message the reader picked, which is the reader scrolling. It unpins, and following stays out of the way until it lands.
  const glideFor = useCallback((goal: () => number, done: (landed: boolean, replaced?: boolean) => void) => {
    glider.current.start({
      goal,
      done: (landed, replaced) => { gliding.current = false; done(landed, replaced) }
    })
    gliding.current = glider.current.live()
    endRestore()
    byHand.current = true
    letGo.current?.()
  }, [])
  const stopGlide = useCallback(() => { gliding.current = false; glider.current.cancel() }, [])
  const railGlide = useMemo(() => ({ glide: glideFor, stop: stopGlide }), [glideFor, stopGlide])
  // The rows on screen with where they sit in the scroller, which is how a spot is saved and found again.
  const rowBoxes = (): RowBox[] => {
    const el = scroller.current
    const kids = thread.current?.children
    if (!el || !kids) return []
    const base = el.getBoundingClientRect().top - el.scrollTop
    return drawn.current.flatMap((id, i) => {
      const r = kids[i]?.getBoundingClientRect()
      return r ? [{ id, top: r.top - base, height: r.height }] : []
    })
  }
  // A chat opens where it was left, or at its end when it was left there or the reader has sent something since (KERNEL-765). A chat a send just created has no spot, so it opens at its end.
  useLayoutEffect(() => {
    if (!loaded) return
    gliding.current = false
    byHand.current = false
    const el = scroller.current
    const place = takePlace(chat.id)
    const lastSent = [...itemsNow.current].reverse().find(followsSend)?.id
    let held: ReturnType<typeof holdView> | undefined
    // The view is put back every frame until what it is put at holds still for 4 frames. A spot then keeps being corrected whenever the thread changes size
    // (late layout: code highlighting, images, rows measured after the first paint), until the reader scrolls. `put` returns the scrollTop it set.
    const hold = (put: () => number, ends: boolean) => {
      if (!el) return
      held = holdView({
        put, ends, over: () => byHand.current, following: () => pinned.current,
        now: () => performance.now(), raf: (step) => requestAnimationFrame(step), caf: (id) => cancelAnimationFrame(id), capMs: OPEN_MS,
        frames: (running) => { if (running) el.setAttribute('data-opening', ''); else el.removeAttribute('data-opening') }
      })
      if (ends) return
      spot.current = true
      restoring.current = { put: () => held?.resume(), stop: () => held?.stop() }
    }
    if (el && place?.heights) {
      const kids = thread.current?.children
      drawn.current.forEach((id, i) => {
        const h = place.heights![id]
        const row = kids?.[i]
        if (h && row instanceof HTMLElement) row.style.containIntrinsicBlockSize = `auto ${h}px`
      })
    }
    el?.setAttribute('data-opening', '')
    if (!el || opensAtEnd(place, lastSent)) {
      pin(true)
      if (el) {
        hold(() => { const to = Math.max(0, rangeOf(el)); el.scrollTop = to; remember(el); return to }, true)
        remember(el)
      } else followNow()
    } else {
      pinned.current = false
      hold(() => {
        const boxes = new Map(rowBoxes().map((r) => [r.id, r.top]))
        const to = placeTop(place!, (id) => boxes.get(id), rangeOf(el))
        el.scrollTop = to
        remember(el)
        show(distFromEnd(el) > PIN_PX)
        return to
      }, false)
    }
    return () => {
      cancelAnimationFrame(frame.current)
      el?.removeAttribute('data-opening')
      const correcting = !!held?.state.correcting && !byHand.current
      endRestore()
      held?.stop()
      const view = scroller.current
      // A chat that was just closed or archived has no spot to keep, nor has one in an archived workspace.
      const state = getState()
      if (!view || !state.chats[workspaceId]?.some((c) => c.id === chat.id && !c.closed) || state.workspaces.find((w) => w.id === workspaceId)?.status === 'archived') return
      // Still being put back, the view is not where the reader left it: the spot from before stays.
      if (correcting) return
      savePlace(chat.id, readPlace(rowBoxes(), view.scrollTop, leftAtEnd(distFromEnd(view)), [...itemsNow.current].reverse().find(followsSend)?.id))
    }
  }, [loaded])
  // Opening a row at the end grows the thread under the reader's click, and following would scroll the row they opened out from under them. They are reading it now,
  // so the end doesn't pull it away. Only a click on something that opens counts, and only when the thread grows from it: a menu, or a row that closes, leaves following alone.
  const opening = useRef(false)
  const opened = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target as Element).closest('[aria-expanded]')) return
    opening.current = true
    requestAnimationFrame(() => requestAnimationFrame(() => { opening.current = false }))
  }
  useEffect(() => () => glider.current.cancel(), [])
  // The thread grows without gaining a row: a reply streaming text into the one it has, a step opening, a turn folding into its summary. Follow its size, not its row count.
  const height = useRef(0)
  useEffect(() => {
    const el = thread.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height
      if (opening.current && h > height.current) pinned.current = false
      opening.current = false
      height.current = h
      if (restoring.current) { restoring.current.put(); return }
      if (pinned.current) followNow()
      else if (scroller.current) show(distFromEnd(scroller.current) > PIN_PX)
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  const openedAt = useRef(Date.now())
  const reveal = useCallback((el: HTMLElement, holdMs: number) => {
    const box = scroller.current
    if (!box || byHand.current) return
    const goal = () => {
      const view = box.getBoundingClientRect()
      const at = el.getBoundingClientRect()
      return Math.round(el.offsetHeight > box.clientHeight ? box.scrollTop + at.top - view.top - 8 : box.scrollTop + at.bottom - view.bottom + 14)
    }
    glider.current.start({ goal, instant: Date.now() - openedAt.current < OPEN_MS, holdMs, over: () => byHand.current, done: () => { gliding.current = false } })
    gliding.current = glider.current.live()
  }, [])
  // Sending a message puts the view at its end at once, even from further up, since the reader just asked for something. No glide: the new row appears and the view stays at the end.
  const last = items[items.length - 1]
  const arrived = useRef(false)
  const sentId = useRef<string | null>(null)
  const queued = useStore((s) => s.queue[chat.id]?.length ?? 0)
  const queuedAt = useRef(0)
  const prevQueued = useRef(queued)
  useEffect(() => { if (queued > 0 || prevQueued.current > 0) queuedAt.current = Date.now(); prevQueued.current = queued }, [queued])
  useLayoutEffect(() => {
    if (!loaded) return
    // Before paint, so the frame that draws the new row is already at the end (KERNEL-895). The first run is the chat opening, which the effect above has placed already.
    const step = sendFollow(last, sentId.current, arrived.current, postedFromQueue(queuedAt.current, Date.now()), pinned.current)
    if (step === 'follow') {
      release()
      endRestore()
      byHand.current = false
      pin(true)
    } else if (followsSend(last) && last!.id !== sentId.current && scroller.current) show(distFromEnd(scroller.current) > PIN_PX)
    if (followsSend(last)) sentId.current = last!.id
    arrived.current = true
    if (pinned.current) followNow()
  }, [items.length, loose.length, running, queued, loaded])
  const since = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].ts; return Date.now() }, [items])
  // This chat is on screen, so it is read, whether the window has focus or not. Main can't tell which chat is shown, so it clears the flag when asked:
  // on opening the chat, and again whenever a turn ends in it while it stays open (KERNEL-507, KERNEL-508).
  const unreadAt = chat.unreadAt
  useEffect(() => { if (unreadAt !== undefined) void call('chats.markRead', { chatId: chat.id }).catch(() => undefined) }, [chat.id, unreadAt])

  // An empty chat shows the centred welcome in place of the thread, which sits at the bottom of the scroll area.
  // A chat whose items have not arrived is not empty, whatever it holds: it shows nothing until they do, or Try again when the load failed (KERNEL-860).
  const empty = !loading && !failed && !items.length && !loose.length && !running && !(ws?.prState === 'changes' && pr)
  const newCount = useMemo(() => countNew(items, before, isMessage), [items, before])
  const [retrying, retry] = useBusy()
  // The rows are memoized, so these keep one identity while the chat and workspace stay the same, whatever the parent passes.
  useEffect(() => {
    if (!getState().checkpoints[workspaceId]) void call('checkpoints.list', { workspaceId }).then((l) => actions.workspaces.setCheckpoints(workspaceId, l)).catch(() => undefined)
  }, [workspaceId])
  const forked = useRef(onForked)
  forked.current = onForked
  const chatId = chat.id
  const fork = useCallback((itemId: string) => attempt('Could not fork', async () => {
    const next = await call('chats.fork', { chatId, itemId })
    await loadWorkspace(workspaceId)
    forked.current(next.id)
  }), [chatId, workspaceId])
  // Only a workspace with its own worktree forks into a new one, and not a Lead chat's, which plans and hands off (KERNEL-405).
  // The new workspace opens while its setup runs.
  const worktree = ws?.mode === 'worktree' && !ws.lead
  // Only the latest reply's card links to the workspace's changes, and only when they differ from its own and the diff is the agent's alone.
  let latestFiles = -1
  if (worktree) for (let i = blocks.length - 1; i >= 0 && latestFiles < 0; i--) { const b = blocks[i]; if ((b.kind === 'reply' && b.files) || b.kind === 'files') latestFiles = i }
  const forkWorkspace = useCallback((itemId: string) => attempt('Could not fork into a new workspace', async () => {
    const next = await call('workspaces.fork', { chatId, itemId })
    actions.workspaces.upsert(next)
    await loadWorkspace(next.id)
    go({ name: 'workspace', workspaceId: next.id })
  }), [chatId])

  const terminal = useCallback(() => attempt('Could not open a terminal', async () => {
    const t = await call('chats.create', { workspaceId, kind: 'terminal' })
    await loadWorkspace(workspaceId)
    forked.current(t.id)
  }), [workspaceId])
  const edit = useRef(onEdit)
  edit.current = onEdit
  const editMessage = useCallback((text: string) => edit.current(text), [])
  const diff = useRef(onOpenDiff)
  diff.current = onOpenDiff
  const openDiff = useCallback((path: string) => diff.current(path), [])

  return (
    <div className="ws-chat" data-rail={rail.current.length >= RAIL_MIN || undefined}>
      <ChatRail key={chat.id} entries={rail.current} scroller={scroller} glide={railGlide} />
      <div ref={scroller} aria-busy={loading || undefined} className="ws-scroll selectable" onScroll={onScroll} onScrollEnd={landed} onClick={opened} onWheel={take} onTouchStart={take} onPointerDown={(e) => (e.target === e.currentTarget ? take() : release())} onKeyDown={press}>
        {failed && (
          <EmptyState icon="warning" title="Could not load this chat">
            <Button busy={retrying !== null} busyLabel="Loading" onClick={() => void retry('load', () => loadWorkspace(workspaceId).catch(() => undefined))}>Try again</Button>
          </EmptyState>
        )}
        {empty && (
          <ChatWelcome title={chat.kind === 'terminal' ? chat.title : `New tab with ${agentName}`} suggestions={isLead ? LEAD_SUGGESTIONS : SUGGESTIONS}
            onPick={(text) => sendMessage(chat.id, [{ type: 'text', text }])} />
        )}
        <TranscriptGlide.Provider value={reveal}>
        <TranscriptWorkspace.Provider value={workspaceId}>
        <TranscriptChat.Provider value={chatId}>
        <TranscriptAway.Provider value={away}>
        <ShownInError.Provider value={inError}>
        <div ref={thread} className="thread" style={empty || failed ? { display: 'none' } : undefined}>
          {blocks.map((b, i) => <Block key={b.kind === 'item' ? b.item.id : b.id} block={b} chatId={chatId} workspaceId={workspaceId} changes={changes} inWorkspace={i === latestFiles && changes.length > 0 && changes.length !== ((b.kind === 'reply' || b.kind === 'files') && b.files ? b.files.length : 0) ? changes.length : undefined} agentName={agentName} onEdit={editMessage} onOpenDiff={openDiff} onFork={fork} onForkWorkspace={worktree ? forkWorkspace : undefined} onTerminal={terminal} />)}
          {loose.map((a) => <ApprovalCard key={a.id} approval={a} inChat />)}
          {ws?.prState === 'changes' && pr && <ReviewCard ws={ws} pr={pr} agentName={agentName} />}
          {ws && <LocalMergeRow ws={ws} />}
          {running && <TurnLine since={since} waiting={waits} />}
          <div ref={end} />
        </div>
        </ShownInError.Provider>
        </TranscriptAway.Provider>
        </TranscriptChat.Provider>
        </TranscriptWorkspace.Provider>
        </TranscriptGlide.Provider>
      </div>
      {away && !empty && (newCount > 0
        ? <Button icon="arrowDown" className="ws-jump new" aria-label={`Scroll to bottom, ${newCount} new`} onClick={toEnd}>{newCount} new</Button>
        : <IconButton icon="arrowDown" label="Scroll to bottom" className="ws-jump" onClick={toEnd} />)}
    </div>
  )
}
