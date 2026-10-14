import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Approval, ChangedFile, Chat, ChatItem, ChatPart, LeadMode } from '@shared/types'
import { leadModeName, leadModeOf, leadModeSwitched } from '@shared/leadMode'
import { maskSecrets, stripAnsi, toolView } from '@shared/toolView'
import { call } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { Avatar, Button, Card, Icon, IconButton, Spinner, useBusy, type IconName } from '../../ui'
import { ServiceMark } from '../../icons'
import { actions, getState, go, loadWorkspace, setLeadMode, useStore } from '../../store'
import { openRoom } from '../../lead'
import { floorRoomId, noteLinkTarget } from './noteLink'
import { NoteText } from './NoteText'
import { ApprovalCard } from './cards/ApprovalCard'
import { waitingPlan } from './cards/steps'
import { ErrorCard } from './cards/ErrorCard'
import { Markdown } from './markdown'
import { attempt, MessageActions, useCopy, type MessageAction } from './MessageActions'
import { ChipIcon, HoverPreview, ImageButton, isPastedText, OpenImage, TextButton, type ImagePart } from './composer/Chip'
import { buildThread, countsLabel, fmtDuration, runLabel, turnFiles, type Entry, type Run, type ThreadBlock } from './thread'
import { InstructionCard } from './pr/InstructionCard'
import { instructionOf } from './pr/model'
import { userView } from './sender'
import { KernelNote } from './KernelNote'
import { SharedCard } from './cards/SharedCard'
import { TeamUpdateCard } from './cards/TeamUpdateCard'
import { LocalMergeRow } from './pr/LocalMerge'
import { ReviewCard } from './pr/ReviewCard'
import { LEAD_MODE_ICON } from './composer/modes'
import { ChatWelcome, LEAD_SUGGESTIONS, SUGGESTIONS } from './ChatWelcome'
import { ChatRail } from './ChatRail'
import { opensAtEnd, placeTop, readPlace, savePlace, takePlace, TranscriptChat, useRowOpen, type RowBox } from './chatPlace'
import { RAIL_MIN, railEntries, sameEntries } from './railEntries'

const EMPTY: ChatItem[] = []
/** The reader counts as following the chat while the end is this close. */
const PIN_PX = 80

/** The PR state icons a note draws before its text, the same glyphs as the PR header (KERNEL-313). */
const NOTE_GLYPH: Record<NonNullable<Extract<ChatItem, { kind: 'note' }>['pr']>, IconName> = { merged: 'merged', closed: 'prClosed', cifail: 'prCifail' }

/** The user's own send is what a reader scrolled up follows. A bubble with a sender, the Lead handing work to a teammate, arrives while they read and leaves them where they are. */
export const followsSend = (item: ChatItem | undefined) => item?.kind === 'user' && !item.from && userView(item) === 'bubble'

/** The numbers a scroll position is read from, so the rule below runs without a layout engine. */
export interface ScrollView { scrollTop: number; scrollHeight: number; clientHeight: number }

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

export function PartChip({ part }: { part: ChatPart }) {
  if (part.type === 'text') return null
  const body = <>{part.type === 'skill' ? <span aria-hidden="true" className="muted">/</span> : <ChipIcon part={part} />}{part.name}</>
  if (part.type === 'image' && part.dataUrl) return <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className="msg-chip" data-kind="image">{body}</ImageButton>
  if (isPastedText(part)) return <TextButton paste={part} className="msg-chip" data-kind="file">{body}</TextButton>
  return <span className="msg-chip" data-kind={part.type}>{body}</span>
}

/** True when a revert to this checkpoint would change something: it is linked and the worktree isn't already there. */
function useRevertable(workspaceId: string, checkpointId: string | undefined): boolean {
  return useStore((s) => !!checkpointId && !s.checkpoints[workspaceId]?.some((c) => c.current && c.id === checkpointId))
}

const revertAction = (workspaceId: string, checkpointId: string, label: string, start?: boolean): MessageAction =>
  ({ icon: 'history', label, onClick: () => actions.ui.openModal({ name: 'confirm', kind: 'revert', workspaceId, checkpointId, ...(start ? { start } : {}) }) })

function UserMessage({ item, workspaceId, onEdit }: { item: Extract<ChatItem, { kind: 'user' }>; workspaceId: string; onEdit: (text: string) => void }) {
  const revertable = useRevertable(workspaceId, item.checkpointId)
  const more: MessageAction[] = revertable && item.checkpointId ? [revertAction(workspaceId, item.checkpointId, 'Revert files to start of chat', true)] : []
  return (
    <div className="msg msg-user" data-jump={item.id}>
      <div className="bubble">
        {item.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text} </span> : <PartChip key={i} part={p} />))}
      </div>
      <MessageActions align="end" label="Message actions" copy={partsText(item.parts)} items={[{ icon: 'pen', label: 'Edit', onClick: () => onEdit(partsText(item.parts)) }]}
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

interface ReplyProps { item: Extract<ChatItem, { kind: 'text' }>; chatId: string; workspaceId: string; checkpointId?: string; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown>; files?: ChangedFile[]; inWorkspace?: number; meta?: string; onOpenDiff: (path: string) => void }

/**
 * A reply, with Copy, Retry and a "..." menu that forks and, on the reply that ends a turn with changed files, reverts the files to that turn (KERNEL-766). The reply that ends a finished turn also carries the turn's files and
 * its time, which leads the actions' row (KERNEL-346). Fork into new workspace only shows where the workspace has its own worktree.
 */
function ReplyMessage({ item, chatId, workspaceId, checkpointId, onFork, onForkWorkspace, files, inWorkspace, meta, onOpenDiff }: ReplyProps) {
  const revertable = useRevertable(workspaceId, files?.length ? checkpointId : undefined)
  const forks: MessageAction[] = [{ icon: 'fork', label: 'Fork into new tab', busyLabel: 'Forking', onClick: () => onFork(item.id) }]
  if (onForkWorkspace) forks.push({ icon: 'branch', label: 'Fork into new workspace', busyLabel: 'Forking', onClick: () => onForkWorkspace(item.id) })
  if (revertable && checkpointId) forks.push(revertAction(workspaceId, checkpointId, 'Revert files to here'))
  return (
    <div className="msg msg-reply">
      <Markdown text={item.text} />
      {files && <TurnFilesCard rowId={item.id} files={files} inWorkspace={inWorkspace} onOpenDiff={onOpenDiff} />}
      <MessageActions label="Message actions" copy={item.text} meta={meta}
        items={[{ icon: 'refresh', label: 'Retry', busyLabel: 'Retrying', onClick: () => attempt('Could not retry', () => call('chats.retry', { chatId, itemId: item.id })) }]}
        more={{ menu: `reply:${item.id}`, items: forks }} />
    </div>
  )
}

/**
 * A room link (see noteLink.ts) opens that room, in its Lead chat. A web link opens in the browser,
 * never in the app window (KERNEL-294). Any other href shows as plain text.
 */
function NoteLink({ link }: { link: { label: string; href: string } }) {
  switch (noteLinkTarget(link.href)) {
    case 'room': return <a href={link.href} onClick={(e) => { e.preventDefault(); void openRoom(floorRoomId(link.href)!) }}>{link.label}</a>
    case 'external': return <a href={link.href} onClick={(e) => { e.preventDefault(); void attempt('Could not open the link', () => call('system.openExternal', { url: link.href })) }}>{link.label}</a>
    default: return <span>{link.label}</span>
  }
}

type Tool = Extract<ChatItem, { kind: 'tool' }>

/**
 * One step of the agent's work: a button that opens in place to what it did (KERNEL-198). On hover and focus the row's icon
 * turns into the chevron, in the same 15px slot, and the chevron stays while the row is open (KERNEL-562). A row whose preview
 * is its own text (thinking, a message) drops the preview once open. With nothing to show the row is inert and keeps its icon.
 * Open state is local, so a tool going from running to done keeps it. `compact` is the row inside the folded list: no icon, so no
 * slot and no chevron, and a right-hand note.
 */
/** `glyph` draws in the icon's place, as a file's icon on a Read, Edit or Write row. `chip` draws after the label in the detail's place, as the image on a Read image row. */
function StepRow({ icon, glyph, failed, label, detail, preview, keep, name, chip, mono, meta, compact, startOpen, onOpen, onPeek, peek, children }: {
  icon?: IconName; glyph?: ReactNode; failed?: boolean; label: ReactNode; detail?: string; chip?: ReactNode; mono?: boolean; meta?: string; compact?: boolean
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
    <div className="col" style={{ gap: 4 }}>
      <button
        type="button" className="trow trow-btn" aria-label={name} aria-expanded={can ? open : undefined} aria-controls={can ? panel : undefined} disabled={!can} onClick={click}
        {...(onPeek && {
          onMouseEnter: (e: MouseEvent<HTMLElement>) => show(e.currentTarget), onMouseLeave: () => setAt(null),
          // Focus shows it from the keyboard only, so a click doesn't bring it back.
          onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget) }, onBlur: () => setAt(null),
          onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (e.key === 'Escape' && at) { e.stopPropagation(); setAt(null) } }
        })}
      >
        {(glyph || icon) && (
          <span className={`step-slot${glyph ? ' step-glyph' : ''}`} style={glyph ? undefined : { color: failed ? 'var(--del)' : 'var(--muted)' }}>
            {glyph || <Icon name={icon!} size={16} />}
            {can && <span className="chev step-chev" data-open={open} aria-hidden="true"><Icon name="right" size={12} /></span>}
          </span>
        )}
        <span className="ellipsis" style={{ maxWidth: 300, flexShrink: 0, color: failed ? 'var(--del)' : 'var(--ink-2)' }}>{label}</span>
        {chip ? <span className="grow step-chip">{chip}</span> : <span className={`grow muted ellipsis${mono ? ' mono' : ''}`} style={mono ? { fontSize: 12 } : undefined} aria-hidden={mono ? undefined : true}>{mono || keep || !open ? preview ?? detail : null}</span>}
        {meta && <span className="mono muted" style={{ fontSize: 11.5 }}>{meta}</span>}
      </button>
      {at && peek && <HoverPreview at={at} className="img-preview">{peek}</HoverPreview>}
      {open && can && <div id={panel} className="step-body" data-compact={compact || undefined}>{children}</div>}
    </div>
  )
}

/** Rows compare their item, so a step that didn't change isn't drawn again when its neighbours do. `StepRow` below takes its body as children, a new element every time, so the skip has to happen here. */
const ThinkingRow = memo(function ThinkingRow({ item, compact }: { item: Extract<ChatItem, { kind: 'thinking' }>; compact?: boolean }) {
  return <StepRow icon={compact ? undefined : 'bulb'} label="Thought" compact={compact}>{item.text.trim() && <div className="step-text">{item.text}</div>}</StepRow>
})

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** Edit shows what it took out and put in, one prefixed line each. */
function EditDiff({ from, to }: { from: string; to: string }) {
  return (
    <>
      {from.split('\n').map((l, i) => <div key={`-${i}`} className="del">-{l}</div>)}
      {to.split('\n').map((l, i) => <div key={`+${i}`} className="add">+{l}</div>)}
    </>
  )
}

/** One block of an opened row with a Copy button, shown on hover and on focus. `text` is what it copies. */
function ToolBlock({ text, label, children }: { text: string; label: string; children: ReactNode }) {
  const [copied, copy] = useCopy(text)
  return (
    <div className="tool-block">
      <div className="code tool-out">{children}</div>
      <IconButton icon={copied ? 'check' : 'copy'} size={14} label={copied ? 'Copied' : label} onClick={copy} />
    </div>
  )
}

/** The tool's input as the text a person would have typed: the command, the path, the pattern, the prompt. Anything else is JSON. Secrets are masked. */
function inputView(item: Tool): { node: ReactNode; text: string } | null {
  const i = item.input
  if (!i || !Object.keys(i).length) return null
  const lines = (...rows: (string | undefined)[]) => rows.filter((r): r is string => r !== undefined).join('\n')
  const plain = (t: string | undefined) => t && { text: maskSecrets(t), node: maskSecrets(t) }
  const known = ((): { node: ReactNode; text: string } | undefined | '' => {
    switch (item.name) {
      case 'Bash': return plain(text(i.command) && `$ ${i.command}`)
      case 'Edit': {
        if (typeof i.old_string !== 'string' || typeof i.new_string !== 'string') return undefined
        const from = maskSecrets(i.old_string)
        const to = maskSecrets(i.new_string)
        return { node: <EditDiff from={from} to={to} />, text: lines(...from.split('\n').map((l) => `-${l}`), ...to.split('\n').map((l) => `+${l}`)) }
      }
      case 'Write': return text(i.file_path) && typeof i.content === 'string' ? plain(lines(text(i.file_path), '', i.content)) : undefined
      case 'Read': return plain(text(i.file_path) && lines(text(i.file_path), typeof i.offset === 'number' ? `offset: ${i.offset}` : undefined, typeof i.limit === 'number' ? `limit: ${i.limit}` : undefined))
      case 'Grep': case 'Glob': return plain(text(i.pattern) && lines(`pattern: ${text(i.pattern)}`, text(i.path) && `path: ${text(i.path)}`))
      case 'Agent': case 'Task': return plain(text(i.prompt))
      default: return undefined
    }
  })()
  return known || plain(JSON.stringify(i, null, 2)) || null
}

/** The call as it was made, for whoever wants to replay or report it. Masked like everything the row shows. */
const rawCall = (item: Tool) => maskSecrets(JSON.stringify({ name: item.name, input: item.input, output: item.output }, null, 2))

function CopyRaw({ item }: { item: Tool }) {
  const [copied, copy] = useCopy(rawCall(item))
  return <Button variant="ghost" icon={copied ? 'check' : 'copy'} className="tool-raw" onClick={copy}>{copied ? 'Copied' : 'Copy raw call'}</Button>
}

/** What a tool shows when opened: its input, then its output with the terminal's colour codes stripped. A tool with neither has nothing to open. */
function toolBody(item: Tool): ReactNode {
  const input = inputView(item)
  if (!input && !item.output) return null
  const output = item.output ? maskSecrets(stripAnsi(item.output)) : ''
  return (
    <>
      {input && <ToolBlock text={input.text} label="Copy input">{input.node}</ToolBlock>}
      {output && <ToolBlock text={output} label="Copy output">{output}{item.outputCut && <span className="step-cut">Output cut at 20,000 characters</span>}</ToolBlock>}
      <CopyRaw item={item} />
    </>
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
function ReadImageRow({ item, image, file, meta, compact }: { item: Tool; image: string; file?: string; meta?: string; compact?: boolean }) {
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
      icon={compact ? undefined : 'term'} glyph={file && <FileIcon path={file} size={15} />} failed={view.state === 'failed'}
      label={`${view.verb} image`} name={`${view.verb} image: ${name}`} detail={item.detail} chip={<PartChip part={{ type: 'image', name }} />}
      mono meta={meta} compact={compact}
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
  return ws && s.agents[ws.roomId]?.find((a) => a.id === ws.agentId)?.name
}

const ToolRow = memo(function ToolRow({ item, meta, compact }: { item: Tool; meta?: string; compact?: boolean }) {
  const workspaceId = useContext(TranscriptWorkspace)
  const root = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path)
  const target = useStore(agentNamed(item.name.endsWith('__message_agent') ? item.input?.workspace_id : undefined))
  const view = useMemo(() => toolView(item, { root, agentOf: target ? () => target : undefined }), [item, root, target])
  if (view.hidden) return null
  const image = readImage(item)
  if (image) return <ReadImageRow item={item} image={image} file={compact ? undefined : view.file ?? item.detail} meta={meta} compact={compact} />
  const mark = view.file ? <FileIcon path={view.file} size={15} /> : view.agent ? <Avatar name={view.agent} size={15} /> : view.service ? <span className="step-mark"><ServiceMark name={view.service} size={15} /></span> : undefined
  const preview = (view.object || view.dir || view.detail) && (
    <>
      {view.object && <span className={view.mono ? 'step-cmd mono' : 'step-obj'}>{view.object}</span>}
      {view.dir && <span className="step-dir">{view.dir}</span>}
      {view.detail && <span className="step-det">{view.detail}</span>}
    </>
  )
  return (
    <StepRow
      icon={compact || mark ? undefined : 'term'} glyph={compact ? undefined : mark} failed={view.state === 'failed'}
      label={view.verb} preview={preview} keep name={view.sentence} meta={meta} compact={compact}
    >
      {toolBody(item)}
    </StepRow>
  )
})

/** Edit and Write calls show what they added and removed, read from the changed files. */
function toolMeta(item: Tool, changes: ChangedFile[]): string {
  const file = (item.name === 'Edit' || item.name === 'Write') && changes.find((c) => c.path === item.detail)
  if (file) return [file.added ? `+${file.added}` : '', file.removed ? `-${file.removed}` : ''].filter(Boolean).join(' ')
  return item.durationMs !== undefined ? `${(item.durationMs / 1000).toFixed(item.durationMs < 10_000 ? 1 : 0)}s` : ''
}

/** A row in the folded list: every step the turn took before its reply, in order, each closed until opened. */
const GroupItem = memo(function GroupItem({ item, meta }: { item: ChatItem; meta?: string }) {
  if (item.kind === 'tool') return toolView(item).hidden ? null : <div className="group-item"><ToolRow item={item} meta={meta} compact /></div>
  if (item.kind === 'thinking') return <div className="group-item"><ThinkingRow item={item} compact /></div>
  if (item.kind === 'text') return <div className="group-item"><StepRow label="Message" detail={item.text} compact>{item.text.trim() && <div className="step-text"><Markdown text={item.text} /></div>}</StepRow></div>
  return null
})

/**
 * Calls of one verb on one service as one row: "Filed 7 issues in Linear". It keeps the service's mark, says what failed in red after the sentence,
 * and opens to each call as its own row. Inside an open fold a run with a failure is already open (KERNEL-784). Closed, it draws nothing but its line.
 */
const RunRow = memo(function RunRow({ run, changes, compact, startOpen }: { run: Run; changes: ChangedFile[]; compact?: boolean; startOpen?: boolean }) {
  const { text, bad } = runLabel(run)
  const mark = run.service ? <span className="step-mark"><ServiceMark name={run.service} size={15} /></span> : undefined
  return (
    <StepRow
      icon={compact || mark ? undefined : 'term'} glyph={compact ? undefined : mark} failed={!run.done && !!bad} startOpen={startOpen && !!bad}
      label={<>{text}{bad && <span className="step-bad">, {bad}</span>}</>} name={bad ? `${text}, ${bad}` : text} compact={compact}
    >
      <div className="run-list">
        {run.items.map((i) => <GroupItem key={i.id} item={i} meta={i.kind === 'tool' ? toolMeta(i, changes) : undefined} />)}
      </div>
    </StepRow>
  )
}, (a, b) => (a.run === b.run || (a.run.id === b.run.id && sameList(a.run.items, b.run.items) && a.run.failed === b.run.failed)) && a.changes === b.changes && a.compact === b.compact && a.startOpen === b.startOpen)

const GroupEntry = memo(function GroupEntry({ entry, changes }: { entry: Entry; changes: ChangedFile[] }) {
  if (entry.kind === 'run') return <div className="group-item"><RunRow run={entry.run} changes={changes} compact startOpen /></div>
  return <GroupItem item={entry.item} meta={entry.item.kind === 'tool' ? toolMeta(entry.item, changes) : undefined} />
}, (a, b) => (a.entry === b.entry || (a.entry.kind === 'item' && b.entry.kind === 'item' && a.entry.item === b.entry.item) || (a.entry.kind === 'run' && b.entry.kind === 'run' && a.entry.run.id === b.entry.run.id && sameList(a.entry.run.items, b.entry.run.items))) && a.changes === b.changes)

function ToolGroup({ block, changes }: { block: Extract<ThreadBlock, { kind: 'group' }>; changes: ChangedFile[] }) {
  // Each group opens on its own. The view's flag only sets how a group starts, which is how WorkspaceToolCalls shows them open.
  const [open, setOpen] = useRowOpen(useContext(TranscriptChat), block.id, getState().ui.workspace.toolsOpen)
  const id = `${block.id}-list`
  const { text, bad } = block.summary
  return (
    <div className="col" style={{ gap: 2 }}>
      <button type="button" className="group-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="chev" data-open={open}><Icon name="right" size={12} /></span>
        <span className="group-text">{text}{bad && <span className="step-bad">, {bad}</span>}</span>
      </button>
      {open && (
        <div id={id} className="group-list">
          {block.entries.map((e) => <GroupEntry key={e.kind === 'run' ? e.run.id : e.item.id} entry={e} changes={changes} />)}
        </div>
      )}
    </div>
  )
}

/** Seconds since the turn started. Counts from the message's own timestamp, so it is right after a reload. */
function Elapsed({ since, step }: { since: number; step?: ReactNode }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return <span className="running"><Spinner label="Working" pattern="spiral" />{fmtDuration(now - since)}{step}</span>
}

/** The step in flight, under a running turn's folds: what it is doing, next to the turn's clock. */
function LiveLine({ item, since }: { item: Extract<ThreadBlock, { kind: 'live' }>['item']; since: number }) {
  const workspaceId = useContext(TranscriptWorkspace)
  const root = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path)
  const view = useMemo(() => (item.kind === 'tool' ? toolView(item, { root }) : undefined), [item, root])
  const verb = item.kind === 'thinking' ? 'Thinking' : view?.hidden ? undefined : view?.verb
  return <Elapsed since={since} step={verb && <span className="live-step ellipsis">{verb}{view?.object && <span className={view.mono ? 'mono' : undefined}> {view.object}</span>}</span>} />
}

/** One line across the thread where the chat switched between Hand off and Build here, so the transcript shows which turns could edit (KERNEL-780). */
function LeadModeDivider({ mode }: { mode: LeadMode }) {
  return <div className="mode-divider" role="separator" aria-label={leadModeSwitched(mode)}><Icon name={LEAD_MODE_ICON[mode]} size={14} /><span>{leadModeSwitched(mode)}</span></div>
}

/** Under Kernel's reply when the work is bigger than one PR: one button, only while the chat is still in Build here. Kernel never switches on its own. */
function ModeSuggestion({ workspaceId, mode }: { workspaceId: string; mode: LeadMode }) {
  const current = useStore((s) => leadModeOf(s.workspaces.find((w) => w.id === workspaceId)))
  const [busy, run] = useBusy()
  if (current === mode) return null
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
    case 'item': return b.kind === 'item' && a.item === b.item
    case 'group': return b.kind === 'group' && a.id === b.id && sameList(a.items, b.items)
    case 'run': return b.kind === 'run' && a.id === b.id && sameList(a.run.items, b.run.items)
    case 'live': return b.kind === 'live' && a.item === b.item
    case 'files': return b.kind === 'files' && a.id === b.id && sameList(a.files, b.files)
    case 'meta': return b.kind === 'meta' && a.id === b.id && a.text === b.text
    case 'reply': return b.kind === 'reply' && a.item === b.item && a.meta === b.meta && a.checkpointId === b.checkpointId && sameList(a.files ?? [], b.files ?? [])
    case 'relaunch': return b.kind === 'relaunch' && a.note === b.note && a.message === b.message
    case 'error': return b.kind === 'error' && a.id === b.id && a.message === b.message && a.output === b.output
  }
}

interface BlockProps { block: ThreadBlock; chatId: string; workspaceId: string; changes: ChangedFile[]; inWorkspace?: number; agentName: string; onEdit: (text: string) => void; onOpenDiff: (path: string) => void; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown>; onTerminal: () => Promise<unknown> }

/** Only a tool group reads the changed files, so a new list redraws the groups and nothing else. */
const sameProps = (a: BlockProps, b: BlockProps) =>
  sameBlock(a.block, b.block) && a.chatId === b.chatId && a.workspaceId === b.workspaceId && a.inWorkspace === b.inWorkspace && a.agentName === b.agentName && a.onEdit === b.onEdit && a.onOpenDiff === b.onOpenDiff && a.onFork === b.onFork && a.onForkWorkspace === b.onForkWorkspace && a.onTerminal === b.onTerminal
  && ((a.block.kind !== 'group' && a.block.kind !== 'run') || a.changes === b.changes)

const Block = memo(function Block({ block, chatId, workspaceId, changes, inWorkspace, agentName, onEdit, onOpenDiff, onFork, onForkWorkspace, onTerminal }: BlockProps) {
  if (block.kind === 'error') {
    return (
      <ErrorCard message={block.message} output={block.output} agentName={agentName} onTerminal={onTerminal}
        onFix={() => attempt('Could not send', () => call('chats.send', { chatId, parts: [{ type: 'text', text: `Fix this: ${block.message}` }] }))}
        onRetry={() => attempt('Could not retry', () => call('chats.retry', { chatId, itemId: block.id }))} />
    )
  }
  if (block.kind === 'group') return <ToolGroup block={block} changes={changes} />
  if (block.kind === 'run') return <RunRow run={block.run} changes={changes} />
  if (block.kind === 'live') return block.item.kind === 'tool' ? <ToolRow item={block.item} /> : <ThinkingRow item={block.item} />
  if (block.kind === 'relaunch') return <KernelNote item={block.message} lead={block.note.text} />
  if (block.kind === 'meta') return <span className="meta">{block.text}</span>
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
    case 'text': return <ReplyMessage item={item} chatId={chatId} workspaceId={workspaceId} onFork={onFork} onForkWorkspace={onForkWorkspace} onOpenDiff={onOpenDiff} />
    case 'thinking': return <ThinkingRow item={item} />
    case 'tool': return <ToolRow item={item} />
    case 'note': return <div className="note inline" data-pr={item.pr}>{item.pr && <Icon name={NOTE_GLYPH[item.pr]} size={14} />}<span className="note-text"><NoteText text={item.text} refs={item.refs} /></span><span className="note-rule" aria-hidden="true" />{item.link && <NoteLink link={item.link} />}</div>
    case 'interrupted': return <span className="interrupted">INTERRUPTED BY YOU</span>
    case 'approval': return <ApprovalRow id={item.approvalId} />
    case 'shared': return <SharedCard sharedId={item.sharedId} version={item.version} />
    case 'leadMode': return <LeadModeDivider mode={item.mode} />
    case 'modeSuggestion': return <ModeSuggestion workspaceId={workspaceId} mode={item.mode} />
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
  const approvals = useStore((s) => s.approvals)
  // The agent is waiting on you, not working, while its plan waits.
  const planWaits = useStore((s) => !!waitingPlan(s.approvals, chat))
  const agentName = useStore((s) => { const ws = s.workspaces.find((w) => w.id === workspaceId); return s.agents[ws?.roomId ?? '']?.find((a) => a.id === ws?.agentId)?.name ?? 'the agent' })
  const isLead = useStore((s) => { const ws = s.workspaces.find((w) => w.id === workspaceId); return !!s.agents[ws?.roomId ?? '']?.find((a) => a.id === ws?.agentId)?.lead })
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const pr = useStore((s) => s.prs[workspaceId])
  const blocks = useMemo(() => buildThread(items, running), [items, running])
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
  // The chat follows its end only while the reader is at it. Scrolling up to read stops it, scrolling back down starts it again.
  const scroller = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // The Scroll to bottom button shows while the reader is away from the end and not following it. State changes only when it flips, so scrolling doesn't render the transcript on every event.
  const [away, setAway] = useState(false)
  const awayNow = useRef(false)
  const show = (on: boolean) => { if (awayNow.current !== on) { awayNow.current = on; setAway(on) } }
  const pin = (at: boolean) => { pinned.current = at; show(!at) }
  // Only the reader's own scrolling can unpin a small move, so layout that shifts the view doesn't. Input arms it, and the scroll landing disarms it.
  const byHand = useRef(false)
  const seen = useRef<ScrollView>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
  const remember = (el: ScrollView) => { seen.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } }
  const letGo = useRef<ReturnType<typeof lapse> | undefined>(undefined)
  letGo.current ??= lapse(HAND_MS, () => { byHand.current = false })
  useEffect(() => () => letGo.current?.cancel(), [])
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    if (byHand.current) letGo.current?.()
    pinned.current = followsAfterScroll(pinned.current, el, seen.current, byHand.current)
    remember(el)
    show(!pinned.current && distFromEnd(el) > PIN_PX)
  }
  // A smooth scroll the page runs itself (the button's, or a jump from the chat rail) must not be cut short by following. It ends when the scroll
  // lands, or when the reader takes over. The button's scroll passes through "away" on its way down, which never unpins since it only moves toward the end.
  const gliding = useRef(false)
  const release = () => { gliding.current = false }
  const take = () => { release(); byHand.current = true; letGo.current?.() }
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
    release()
    byHand.current = false
    if (pinned.current) followNow()
  }
  const toEnd = () => {
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
    gliding.current = smooth
    byHand.current = false
    pin(true)
    end.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' })
  }
  // The chat rail glides to a message the reader picked, which is the reader scrolling. It unpins, and following stays out of the way until it lands.
  const jumping = useCallback((on: boolean) => { gliding.current = on; if (on) { byHand.current = true; letGo.current?.() } }, [])
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
  // A chat opens where it was left, or at its end when it was left there or the reader has sent something since (KERNEL-765).
  useLayoutEffect(() => {
    gliding.current = false
    byHand.current = false
    const el = scroller.current
    const place = takePlace(chat.id)
    const lastSent = [...itemsNow.current].reverse().find(followsSend)?.id
    let again = 0
    if (!el || opensAtEnd(place, lastSent)) {
      pin(true)
      followNow()
      if (el) remember(el)
    } else {
      pinned.current = false
      const put = () => {
        const boxes = new Map(rowBoxes().map((r) => [r.id, r.top]))
        el.scrollTop = placeTop(place!, (id) => boxes.get(id), rangeOf(el))
        remember(el)
        show(distFromEnd(el) > PIN_PX)
      }
      put()
      // Rows far above are measured a frame after they first show, so their heights move the spot once.
      again = requestAnimationFrame(() => { if (!byHand.current) put() })
    }
    return () => {
      cancelAnimationFrame(frame.current)
      cancelAnimationFrame(again)
      const view = scroller.current
      // A chat that was just closed or archived has no spot to keep.
      if (!view || !getState().chats[workspaceId]?.some((c) => c.id === chat.id && !c.closed)) return
      savePlace(chat.id, readPlace(rowBoxes(), view.scrollTop, pinned.current, [...itemsNow.current].reverse().find(followsSend)?.id))
    }
  }, [])
  // Opening a row at the end grows the thread under the reader's click, and following would scroll the row they opened out from under them. They are reading it now,
  // so the end doesn't pull it away. Only a click on something that opens counts, and only when the thread grows from it: a menu, or a row that closes, leaves following alone.
  const opening = useRef(false)
  const opened = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target as Element).closest('[aria-expanded]')) return
    opening.current = true
    requestAnimationFrame(() => requestAnimationFrame(() => { opening.current = false }))
  }
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
      if (pinned.current) followNow()
      else if (scroller.current) show(distFromEnd(scroller.current) > PIN_PX)
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  // Sending a message follows it even from further up, since the reader just asked for something.
  const last = items[items.length - 1]
  const sent = followsSend(last)
  const arrived = useRef(false)
  useEffect(() => {
    // The first run is the chat opening, which the effect above has placed already.
    if (sent && arrived.current) { release(); byHand.current = false; pin(true) }
    arrived.current = true
    if (pinned.current) followNow()
  }, [items.length, loose.length, running])
  const since = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].ts; return Date.now() }, [items])
  // This chat is on screen, so it is read, whether the window has focus or not. Main can't tell which chat is shown, so it clears the flag when asked:
  // on opening the chat, and again whenever a turn ends in it while it stays open (KERNEL-507, KERNEL-508).
  const unreadAt = chat.unreadAt
  useEffect(() => { if (unreadAt !== undefined) void call('chats.markRead', { chatId: chat.id }).catch(() => undefined) }, [chat.id, unreadAt])

  // An empty chat shows the centred welcome in place of the thread, which sits at the bottom of the scroll area.
  const empty = !items.length && !loose.length && !running && !(ws?.prState === 'changes' && pr)
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
      <ChatRail key={chat.id} entries={rail.current} scroller={scroller} onGlide={jumping} />
      <div ref={scroller} className="ws-scroll selectable" onScroll={onScroll} onScrollEnd={landed} onClick={opened} onWheel={take} onTouchStart={take} onPointerDown={(e) => (e.target === e.currentTarget ? take() : release())} onKeyDown={press}>
        {empty && (
          <ChatWelcome title={chat.kind === 'terminal' ? chat.title : `New tab with ${agentName}`} suggestions={isLead ? LEAD_SUGGESTIONS : SUGGESTIONS}
            onPick={(text) => void attempt('Could not send', () => call('chats.send', { chatId: chat.id, parts: [{ type: 'text', text }] }))} />
        )}
        <TranscriptWorkspace.Provider value={workspaceId}>
        <TranscriptChat.Provider value={chatId}>
        <div ref={thread} className="thread" style={empty ? { display: 'none' } : undefined}>
          {blocks.map((b, i) => b.kind === 'live' && i === blocks.length - 1 && !planWaits && !loose.length ? <LiveLine key={b.id} item={b.item} since={since} /> : <Block key={b.kind === 'item' ? b.item.id : b.id} block={b} chatId={chatId} workspaceId={workspaceId} changes={changes} inWorkspace={i === latestFiles && changes.length > 0 && changes.length !== ((b.kind === 'reply' || b.kind === 'files') && b.files ? b.files.length : 0) ? changes.length : undefined} agentName={agentName} onEdit={editMessage} onOpenDiff={openDiff} onFork={fork} onForkWorkspace={worktree ? forkWorkspace : undefined} onTerminal={terminal} />)}
          {loose.map((a) => <ApprovalCard key={a.id} approval={a} inChat />)}
          {ws?.prState === 'changes' && pr && <ReviewCard ws={ws} pr={pr} agentName={agentName} />}
          {ws && <LocalMergeRow ws={ws} />}
          {running && !planWaits && (blocks[blocks.length - 1]?.kind !== 'live' || loose.length > 0) && <Elapsed since={since} />}
          <div ref={end} />
        </div>
        </TranscriptChat.Provider>
        </TranscriptWorkspace.Provider>
      </div>
      {away && !empty && <IconButton icon="arrowDown" label="Scroll to bottom" className="ws-jump" onClick={toEnd} />}
    </div>
  )
}
