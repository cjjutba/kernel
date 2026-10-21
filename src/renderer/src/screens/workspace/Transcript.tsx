import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Approval, ChangedFile, Chat, ChatItem, ChatPart, LeadMode, MoveNotice } from '@shared/types'
import { leadModeName, leadModeOf, leadModeSwitched } from '@shared/leadMode'
import { call } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { AgentAvatar, Button, FailedState, Icon, IconButton, LoadingRow, useBusy, type IconName } from '../../ui'
import { actions, getState, go, loadWorkspace, setLeadMode, useStore } from '../../store'
import { failToast, useRetryKey } from '../../retry'
import { openProject } from '../../lead'
import { floorProjectId, noteLinkTarget } from './noteLink'
import { NoteText } from './NoteText'
import { ApprovalCard } from './cards/ApprovalCard'
import { waitingPlan } from './cards/steps'
import { Markdown } from './markdown'
import { attempt, CopyOverlay, MessageActions, type MessageAction } from './MessageActions'
import { fileView, ImageButton, IssueButton, isPastedText, isToken, TextButton, TokenBody, tokenAttrs, usePrState, type ImagePart } from './composer/Chip'
import { buildThread, countsLabel, fmtDuration, turnFiles, type NoteItem, type ThreadBlock } from './thread'
import { ThoughtLine, ToolGroup, ToolRow, TranscriptAway, TranscriptWorkspace, TurnClock, TurnLine, type TurnClockValue } from './Steps'
import { InstructionCard } from './pr/InstructionCard'
import { instructionOf } from './pr/model'
import { isQuitNote, userView } from './sender'
import { KernelNote, QuitNote } from './KernelNote'
import { SharedCard } from './cards/SharedCard'
import { TeamUpdateCard, UpdateRowCard } from './cards/TeamUpdateCard'
import { isHiddenUpdate } from './cards/teamUpdate'
import { LocalMergeRow } from './pr/LocalMerge'
import { ReviewCard } from './pr/ReviewCard'
import { LEAD_MODE_ICON } from './composer/modes'
import { retryMessage, sendMessage, sentAt } from './composer/sendMessage'
import { ChatWelcome, LEAD_SUGGESTIONS, SUGGESTIONS } from './ChatWelcome'
import { ChatMoveNotice } from './banners/ChatMoveNotice'
import { ChatRail } from './ChatRail'
import { countNew, keepOpen, leftAtEnd, markRevealed, opensAtEnd, placeTop, readPlace, savePlace, shouldReveal, takePlace, TranscriptChat, useRowOpen, type RowBox } from './chatPlace'
import { RAIL_MIN, railEntries, sameEntries } from './railEntries'
import { createChatScroll, followsAfterScroll, movesToEnd, PIN_PX, type ChatScroll, type ScrollView } from './chatScroll'
import { TranscriptGlide } from './glideContext'
import { ChatSetupRows, SharedFolderNote } from './ChatSetupRows'

export { TurnLine }

const EMPTY: ChatItem[] = []
/** A plan revealing itself within this long of the chat opening is placed, not glided. */
const OPEN_MS = 600

/** A plan's reveal keeps following its goal this long, so it outlasts the Approve strip opening under it. */
const STRIP_MS = 1300
/** The open chat's spot is saved this long after the reader stops scrolling. */
const KEEP_MS = 250
/** The PR state icons a note draws before its text, the same glyphs as the PR header (KERNEL-313). */
const NOTE_GLYPH: Record<NonNullable<Extract<ChatItem, { kind: 'note' }>['pr']>, IconName> = { opened: 'prReady', ready: 'prReady', merged: 'merged', closed: 'prClosed', cifail: 'prCifail' }

/** The user's own send is what a reader scrolled up follows. A bubble with a sender, the Lead handing work to a teammate, arrives while they read and leaves them where they are. */
export const followsSend = (item: ChatItem | undefined) => item?.kind === 'user' && !item.from && userView(item) === 'bubble'

/** What a reader calls a message: a reply, or a message from a teammate or the team. Steps, tool rows, thinking and approvals are not, and the reader's own send follows them to the end. */
export const isMessage = (item: ChatItem) => item.kind === 'text' || (item.kind === 'user' && !followsSend(item) && ['bubble', 'update'].includes(userView(item)))

export { followsAfterScroll, movesToEnd, type ScrollView }

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

/** The keys that scroll the view. The rest (the number keys and Enter on a card, typing) arm nothing. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** Calls `fn` once `ms` pass without another call of the returned function, which restarts the wait. `cancel` drops it. */
export function lapse(ms: number, fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const restart = () => { clearTimeout(timer); timer = setTimeout(fn, ms) }
  restart.cancel = () => clearTimeout(timer)
  return restart
}

const partsText =(parts: ChatPart[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')

export function PartChip({ part, gone }: { part: ChatPart; gone?: boolean }) {
  const prState = usePrState(part)
  if (part.type === 'text') return null
  const view = fileView(part, gone)
  const attrs = tokenAttrs(part, { gone, prState })
  const body = <TokenBody part={part} gone={gone} />
  if (part.type === 'image' && part.dataUrl && !gone) return <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className="msg-chip" {...attrs}>{body}</ImageButton>
  if (isPastedText(part)) return <TextButton paste={part} className="msg-chip" {...attrs}>{body}</TextButton>
  if (part.type === 'issue') return <IssueButton issue={part} className="msg-chip" {...attrs}>{body}</IssueButton>
  return <span className="msg-chip" data-tip={view?.tip} data-tip-side="above" data-tip-mono={view ? '' : undefined} {...attrs}>{body}</span>
}

/** True when a revert to this checkpoint would change something: it is linked and the worktree isn't already there. */
function useRevertable(workspaceId: string, checkpointId: string | undefined): boolean {
  return useStore((s) => !!checkpointId && !s.checkpoints[workspaceId]?.some((c) => c.current && c.id === checkpointId))
}

const revertAction = (workspaceId: string, checkpointId: string, label: string, start?: boolean): MessageAction =>
  ({ icon: 'history', label, rule: true, onClick: () => actions.ui.openModal({ name: 'confirm', kind: 'revert', workspaceId, checkpointId, ...(start ? { start } : {}) }) })

/** Your answers to several questions are listed in the question's own card, so the chat's message that holds them has nothing left to say (KERNEL-1094). */
const answersListed = (item: Extract<ChatItem, { kind: 'user' }>, approvals: Approval[]) => !!item.approvalId && (approvals.find((a) => a.id === item.approvalId)?.questions?.length ?? 0) > 1

function UserMessage({ item, workspaceId, onEdit }: { item: Extract<ChatItem, { kind: 'user' }>; workspaceId: string; onEdit: (text: string) => void }) {
  const listed = useStore((s) => answersListed(item, s.approvals))
  const revertable = useRevertable(workspaceId, item.checkpointId)
  const archived = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.status === 'archived')
  const more: MessageAction[] = revertable && item.checkpointId ? [revertAction(workspaceId, item.checkpointId, 'Revert files to start of chat', true)] : []
  const thumbs = item.parts.filter((p): p is ImagePart => p.type === 'image' && !!p.dataUrl)
  // An image the archived workspace took with it keeps its place as an empty square, and its token says it is gone.
  const goneOf = (p: ChatPart) => archived && (p.type === 'file' || p.type === 'image') && !!p.path?.startsWith('.kernel/attachments/')
  const lost = item.parts.filter((p) => p.type === 'image' && !p.dataUrl && goneOf(p))
  if (listed) return null
  return (
    <div className="msg msg-user" data-jump={item.id}>
      <div className="bubble" data-tokens={item.parts.some(isToken) || undefined}>
        {/* Every image is a thumbnail above what was said, and a token in the words too. One the window doesn't hold is a token only, and a lost one an empty square. */}
        {(thumbs.length > 0 || lost.length > 0) && (
          <div className="bubble-images">
            {thumbs.map((p, i) => <ImageButton key={i} image={p} className="thumb"><img src={p.dataUrl} alt="" /></ImageButton>)}
            {lost.map((p, i) => <span key={`lost-${i}`} className="thumb" data-state="gone" role="img" aria-label={`${p.type === 'image' ? p.name : ''}, gone from disk`}><Icon name="imageOff" size={20} /></span>)}
          </div>
        )}
        {item.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text} </span> : <PartChip key={i} part={p} gone={goneOf(p)} />))}
      </div>
      {/* An answer to a card (KERNEL-838) is not a prompt the reader can edit, so it keeps Copy only. */}
      <MessageActions align="end" label="Message actions" copy={partsText(item.parts)} items={item.approvalId ? [] : [{ icon: 'pen', label: 'Edit', onClick: () => onEdit(partsText(item.parts)) }]}
        more={more.length ? { menu: `reply:${item.id}`, items: more } : undefined} />
    </div>
  )
}

/** The two count columns of the turn files card, so the numbers line up from the header down. */
function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="tf-n"><span className="add">+{added}</span><span className="del">-{removed}</span></span>
}

const MORE = ':more'

/**
 * The files a finished turn created, edited or deleted, each row a button that opens that file's diff (KERNEL-586, KERNEL-1094). Review changes opens the diff of
 * every changed file. From 7 files the card shows the first 5 and a row that opens the rest in place. The rows are one tab stop and the arrow keys move between them.
 */
function TurnFilesCard({ rowId, files, onOpenDiff }: { rowId: string; files: ChangedFile[]; onOpenDiff: (path: string) => void }) {
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
    <section className="card tcard tf" aria-label="Files changed in this reply">
      <div className="tf-h">
        <span className="tf-c">{v.title}</span><Counts added={v.added} removed={v.removed} />
        <span className="grow" />
        <Button size="sm" className="tf-review" onClick={() => onOpenDiff('')}>Review changes<Icon name="arrowRight" size={12} /></Button>
      </div>
      <div className="tf-b" onKeyDown={move}>
        {rows.map((r) => (
          <button key={r.path} type="button" className="tf-r" data-gone={r.deleted || undefined} aria-label={r.label} tabIndex={r.path === tabbable ? 0 : -1} onFocus={() => setStop(r.path)} onClick={() => onOpenDiff(r.path)}>
            <FileIcon path={r.path} size={16} />
            <span className="tf-path"><span className="tf-dir">{r.dir ? `${r.dir}/` : ''}</span><span className="tf-nm">{r.name}</span></span>
            <span className="grow" />
            <span className="tf-open" aria-hidden="true">Open diff<Icon name="ext" size={12} /></span>
            <Counts added={r.added} removed={r.removed} />
          </button>
        ))}
        {v.hidden.length > 0 && (
          <button key={MORE} type="button" className="tf-r tf-more" aria-expanded={open} tabIndex={tabbable === MORE ? 0 : -1} onFocus={() => setStop(MORE)} onClick={() => setOpen(!open)}
            aria-label={open ? 'Show less' : [`Show ${v.hidden.length} more`, countsLabel(v.hiddenAdded, v.hiddenRemoved)].filter(Boolean).join(', ')}>
            <span className="tf-chev" data-open={open}><Icon name="chevron" size={14} /></span>
            <span className="tf-nm">{open ? 'Show less' : `Show ${v.hidden.length} more`}</span>
            <span className="grow" />
            {!open && <Counts added={v.hiddenAdded} removed={v.hiddenRemoved} />}
          </button>
        )}
      </div>
    </section>
  )
}

interface FootProps { id: string; chatId: string; workspaceId: string; copy?: string; checkpointId?: string; hasFiles: boolean; meta?: string; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown> }

/** Copy, Retry and the "..." menu that forks and, where a finished turn changed files, reverts them to that turn (KERNEL-766). `id` is the row Retry and the forks start from. Fork into new workspace only shows where the workspace has its own worktree. */
function ReplyFoot({ id, chatId, workspaceId, copy, checkpointId, hasFiles, meta, onFork, onForkWorkspace }: FootProps) {
  const revertable = useRevertable(workspaceId, hasFiles ? checkpointId : undefined)
  const forks: MessageAction[] = [{ icon: 'copy', label: 'Copy message', onClick: () => navigator.clipboard.writeText(copy ?? '') }, { icon: 'fork', label: 'Fork into new tab', busyLabel: 'Forking', onClick: () => onFork(id) }]
  if (onForkWorkspace) forks.push({ icon: 'branch', label: 'Fork into new workspace', busyLabel: 'Forking', onClick: () => onForkWorkspace(id) })
  if (revertable && checkpointId) forks.push(revertAction(workspaceId, checkpointId, 'Revert files to here'))
  return (
    <MessageActions label="Message actions" copy={copy} meta={meta}
      items={[{ icon: 'refresh', label: 'Retry', busyLabel: 'Retrying', onClick: () => attempt('Could not retry', () => call('chats.retry', { chatId, itemId: id })) }]}
      more={{ menu: `reply:${id}`, items: forks }} />
  )
}

interface ReplyProps { item: Extract<ChatItem, { kind: 'text' }>; chatId: string; workspaceId: string; checkpointId?: string; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown>; files?: ChangedFile[]; meta?: string; full?: boolean; onOpenDiff: (path: string) => void }

/**
 * An agent line. Most only offer Copy, as an overlay that takes no height. The reply that ends a finished turn (`meta`) and the last line of a
 * stopped or cut-off turn (`full`) carry Copy, Retry and the "..." menu (KERNEL-828). The reply that ends a finished turn also carries the turn's files and
 * its time, which leads the actions' row (KERNEL-346).
 */
function ReplyMessage({ item, chatId, workspaceId, checkpointId, onFork, onForkWorkspace, files, meta, full, onOpenDiff }: ReplyProps) {
  return (
    <div className="msg msg-reply" data-copy={!full && meta === undefined ? '' : undefined}>
      <Markdown text={item.text} />
      {files && <TurnFilesCard rowId={item.id} files={files} onOpenDiff={onOpenDiff} />}
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

const END_ICON = { stopped: 'stop', failed: 'ban', limit: 'ban', cut: 'power' } as const

/**
 * How a turn that didn't finish ended, as one quiet line under its fold (KERNEL-1094): you stopped it, it stopped on an error or at a usage limit (the error is a toast
 * with Retry), or the app quit under it, which offers Continue. The time and the actions follow on the line below.
 */
function EndLine({ block, chatId, agentName }: { block: Extract<ThreadBlock, { kind: 'end' }>; chatId: string; agentName: string }) {
  const { why, ms } = block
  const after = ms !== undefined ? ` after ${fmtDuration(ms)}` : ''
  const words = why === 'stopped' ? `You stopped ${agentName}${after}` : why === 'failed' ? `The turn stopped on an error${after}` : why === 'limit' ? `The turn stopped at a usage limit${after}` : `Cut off when Kernel quit${after}`
  // Continue goes on the last line of the chat, and only while nothing is running.
  const last = useStore((s) => why === 'cut' && !s.running[chatId] && block.id === `end-${s.items[chatId]?.[s.items[chatId].length - 1]?.id}`)
  const [busy, run] = useBusy()
  return (
    <div className="turn-end" data-why={why}>
      <span className="turn-end-ico"><Icon name={END_ICON[why]} size={13} /></span>
      <span className="turn-end-text">{words}</span>
      {last && <Button busy={!!busy} busyLabel="Continuing" onClick={() => void run('go', () => sendMessage(chatId, [{ type: 'text', text: 'Continue where you left off.' }]))}>Continue</Button>}
    </div>
  )
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

/** One of Kernel's notes as a quiet line: its avatar, or the PR's glyph for a note about one, then the sentence. `more` draws at the line's end, as the button of a folded run does. */
function NoteRow({ item, more }: { item: NoteItem; more?: ReactNode }) {
  return <div className="note inline" data-pr={item.pr}>{item.pr ? <Icon name={NOTE_GLYPH[item.pr]} size={14} /> : <AgentAvatar name="Kernel" size={16} />}<span className="note-text"><NoteText text={item.text} refs={item.refs} /></span>{item.link && <NoteLink link={item.link} />}{more}</div>
}

/** Grey notes in a row, folded to the latest and "and N more". The button opens every one of them in order and keeps its place on the last (KERNEL-1025). */
function NoteFold({ block }: { block: Extract<ThreadBlock, { kind: 'notes' }> }) {
  const [open, setOpen] = useRowOpen(useContext(TranscriptChat), block.id, false)
  const last = block.items[block.items.length - 1]
  const earlier = block.items.slice(0, -1)
  const toggle = (
    <button type="button" className="note-more" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? 'Show less' : `and ${earlier.length} more`}
      <span className="chev" data-open={open} aria-hidden="true"><Icon name="right" size={12} /></span>
    </button>
  )
  return (
    <div className="col gap-2">
      {open && earlier.map((n) => <NoteRow key={n.id} item={n} />)}
      <NoteRow item={last} more={toggle} />
    </div>
  )
}

/** One line across the thread where the chat switched between Hand off and Build here, so the transcript shows which turns could edit (KERNEL-780). */
function LeadModeDivider({ mode }: { mode: LeadMode }) {
  return <div className="mode-divider" role="separator" aria-label={leadModeSwitched(mode)}><Icon name={LEAD_MODE_ICON[mode]} size={14} /><span>{leadModeSwitched(mode)}</span></div>
}

/** Under Kernel's reply when the work is bigger than one PR: one button, only for the newest suggestion with no mode switch after it, and only while the chat is still in Build here. Kernel never switches on its own. */
function ModeSuggestion({ workspaceId, chatId, itemId, mode, why }: { workspaceId: string; chatId: string; itemId: string; mode: LeadMode; why: string }) {
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
      <p className="mode-suggest-why">{why}</p>
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
    case 'group': return b.kind === 'group' && a.id === b.id && sameList(a.items, b.items) && a.turn.live === b.turn.live && a.turn.timer === b.turn.timer && a.turn.startedAt === b.turn.startedAt && a.turn.durationMs === b.turn.durationMs && a.turn.short === b.turn.short && a.current === b.current && a.ends === b.ends
    case 'files': return b.kind === 'files' && a.id === b.id && sameList(a.files, b.files)
    case 'meta': return b.kind === 'meta' && a.id === b.id && a.text === b.text && a.actions?.copy === b.actions?.copy && a.actions?.files === b.actions?.files && a.actions?.checkpointId === b.actions?.checkpointId && !a.actions === !b.actions
    case 'notes': return b.kind === 'notes' && a.id === b.id && sameList(a.items, b.items)
    case 'reply': return b.kind === 'reply' && a.item === b.item && a.meta === b.meta && a.checkpointId === b.checkpointId && sameList(a.files ?? [], b.files ?? [])
    case 'relaunch': return b.kind === 'relaunch' && a.note === b.note && a.message === b.message
    case 'end': return b.kind === 'end' && a.id === b.id && a.why === b.why && a.ms === b.ms
  }
}

interface BlockProps { block: ThreadBlock; chatId: string; workspaceId: string; changes: ChangedFile[]; agentName: string; onEdit: (text: string) => void; onOpenDiff: (path: string) => void; onFork: (itemId: string) => Promise<unknown>; onForkWorkspace?: (itemId: string) => Promise<unknown> }

/** Only a tool group reads the changed files, so a new list redraws the groups and nothing else. */
const sameProps = (a: BlockProps, b: BlockProps) =>
  sameBlock(a.block, b.block) && a.chatId === b.chatId && a.workspaceId === b.workspaceId && a.agentName === b.agentName && a.onEdit === b.onEdit && a.onOpenDiff === b.onOpenDiff && a.onFork === b.onFork && a.onForkWorkspace === b.onForkWorkspace
  && (a.block.kind !== 'group' || a.changes === b.changes)

const Block = memo(function Block({ block, chatId, workspaceId, changes, agentName, onEdit, onOpenDiff, onFork, onForkWorkspace }: BlockProps) {
  if (block.kind === 'end') return <EndLine block={block} chatId={chatId} agentName={agentName} />
  if (block.kind === 'group') return <ToolGroup block={block} changes={changes} />
  if (block.kind === 'notes') return <NoteFold block={block} />
  if (block.kind === 'relaunch') return <KernelNote item={block.message} agentName={agentName} lead={`Kernel quit and relaunched. ${agentName} picked up where it stopped.`} />
  if (block.kind === 'meta') return block.actions ? <TurnEnd block={block} chatId={chatId} workspaceId={workspaceId} onFork={onFork} onForkWorkspace={onForkWorkspace} /> : <span className="meta">{block.text}</span>
  if (block.kind === 'files') return <TurnFilesCard rowId={block.id} files={block.files} onOpenDiff={onOpenDiff} />
  if (block.kind === 'reply') return <ReplyMessage item={block.item} chatId={chatId} workspaceId={workspaceId} checkpointId={block.checkpointId} onFork={onFork} onForkWorkspace={onForkWorkspace} files={block.files} meta={block.meta} onOpenDiff={onOpenDiff} />
  const item = block.item
  switch (item.kind) {
    case 'user': {
      const sent = instructionOf(item)
      if (sent) return <InstructionCard part={sent} />
      const view = userView(item)
      return view === 'update' ? (isHiddenUpdate(item, workspaceId) ? null : <div className="jump-anchor" data-jump={item.id}><TeamUpdateCard item={item} chatId={chatId} selfId={workspaceId} /></div>) : view === 'note' ? <KernelNote item={item} agentName={agentName} /> : view === 'hidden' ? null : <UserMessage item={item} workspaceId={workspaceId} onEdit={onEdit} />
    }
    case 'text': return <ReplyMessage item={item} chatId={chatId} workspaceId={workspaceId} full={block.actions} onFork={onFork} onForkWorkspace={onForkWorkspace} onOpenDiff={onOpenDiff} />
    case 'thinking': return <div className="steps"><ThoughtLine item={item} /></div>
    case 'tool': return <div className="steps"><ToolRow item={item} changes={changes} /></div>
    case 'note': return isQuitNote(item) ? <QuitNote item={item} chatId={chatId} agentName={agentName} /> : <NoteRow item={item} />
    case 'update': return <div className="jump-anchor" data-jump={item.id}><UpdateRowCard item={item} /></div>
    // The stop is the quiet line buildThread draws where the turn ends.
    case 'interrupted': return null
    case 'approval': return <ApprovalRow id={item.approvalId} />
    case 'shared': return <SharedCard sharedId={item.sharedId} version={item.version} />
    case 'leadMode': return <LeadModeDivider mode={item.mode} />
    case 'modeSuggestion': return <ModeSuggestion workspaceId={workspaceId} chatId={chatId} itemId={item.id} mode={item.mode} why={item.why} />
    // Result is folded into a meta row or an error card by buildThread.
    case 'result': return null
  }
}, sameProps)

interface TranscriptProps { chat: Chat; workspaceId: string; changes: ChangedFile[]; onEdit: (text: string) => void; onOpenDiff: (path: string) => void; onForked: (chatId: string) => void; /** What a long chat waits on before it moves to another account: Kernel's choice, drawn as a card at the end of the thread (KERNEL-1094). */ moveNotice?: MoveNotice | null }

/** Each chat is its own view, so its scroll and open rows never carry over from the one before, and leaving it saves where the reader was (KERNEL-765). */
export const Transcript = memo(function Transcript(props: TranscriptProps) {
  return <ChatTranscript key={props.chat.id} {...props} />
})

/** A chat whose messages haven't arrived yet: your message and a reply as grey bars, and the loader beside "Loading the chat" under them (Pen 7.10). */
function TranscriptSkeleton() {
  return (
    <div className="ts-skel">
      <div className="ts-skel-you" aria-hidden="true"><i /><i /></div>
      <div className="ts-skel-reply" aria-hidden="true"><i /><i /><i /><i /></div>
      <LoadingRow what="the chat" inline />
    </div>
  )
}

const blockKey = (b: ThreadBlock) => (b.kind === 'item' ? b.item.id : b.id)

function ChatTranscript({ chat, workspaceId, changes, onEdit, onOpenDiff, onForked, moveNotice }: TranscriptProps) {
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
  // The blocks that put an element in the thread, in order, so the thread's children line up with them.
  const drawn = useRef<string[]>([])
  drawn.current = blocks.filter((b) => b.kind !== 'item' || !(b.item.kind === 'result' || (b.item.kind === 'user' && !instructionOf(b.item) && (userView(b.item) === 'hidden' || (userView(b.item) === 'bubble' && answersListed(b.item, approvals)))) || (b.item.kind === 'approval' && !approvals.some((a: Approval) => a.id === (b.item as Extract<ChatItem, { kind: 'approval' }>).approvalId)))).map(blockKey)
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
  const since = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return Math.min(items[i].ts, sentAt(items[i].id) ?? Infinity); return Date.now() }, [items])
  // What the turn waits on, from the real approvals, and when it asked: the fold says Waiting on your answer or approval, with the time the turn had worked by then (KERNEL-1094).
  const waiting = useMemo((): TurnClockValue['waiting'] => {
    const mine = approvals.filter((a: Approval) => a.status === 'pending' && a.workspaceId === workspaceId && (!a.chatId || a.chatId === chat.id)).sort((x, y) => x.createdAt - y.createdAt)
    const first = mine[0] ?? (planWaits ? waitingPlan(approvals, chat) : undefined)
    return first ? { what: first.kind === 'question' ? 'answer' : 'approval', after: Math.max(0, first.createdAt - since) } : undefined
  }, [approvals, workspaceId, chat, planWaits, since])
  const clock = useMemo((): TurnClockValue => ({ since, waiting }), [since, waiting])
  const hasFold = blocks.some((b) => b.kind === 'group' && b.turn.live)
  // The chat follows its end only while the reader is at it. Scrolling up to read stops it, scrolling back down starts it again. The owner (chatScroll.ts) decides what moves the view; this component only tells it what happened.
  const scroller = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLDivElement>(null)
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
  const scroll = useRef<ChatScroll>(undefined as unknown as ChatScroll)
  scroll.current ??= createChatScroll({ box: () => scroller.current, away: show })
  const owner = scroll.current
  // The top fade shows only with rows above. The attribute is set on the element and only when it flips, so scrolling never renders the transcript.
  const fade = () => {
    const el = scroller.current
    if (!el) return
    const on = scrolledOff(el.scrollTop)
    if (el.hasAttribute('data-scrolled') !== on) el.toggleAttribute('data-scrolled', on)
  }
  useLayoutEffect(fade)
  const onScroll = () => {
    fade()
    owner.scrolled()
  }
  const press = (e: KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key) && !(e.target as Element).closest('input, textarea, select, [contenteditable="true"]')) owner.hand()
    else owner.interrupt()
  }
  // The chat rail glides to a message the reader picked, which is the reader scrolling.
  const railGlide = useMemo(() => ({ glide: (goal: () => number, done: (landed: boolean, replaced?: boolean) => void) => owner.guide(goal, done), stop: () => owner.cancelGlide() }), [owner])
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
    const el = scroller.current
    if (!el) return
    const place = takePlace(chat.id)
    const lastSent = [...itemsNow.current].reverse().find(followsSend)?.id
    if (place?.heights) {
      const kids = thread.current?.children
      drawn.current.forEach((id, i) => {
        const h = place.heights![id]
        const row = kids?.[i]
        if (h && row instanceof HTMLElement) row.style.containIntrinsicBlockSize = `auto ${h}px`
      })
    }
    el.setAttribute('data-opening', '')
    // The view is put back every frame until what it is put at holds still for 4 frames (KERNEL-918). A spot keeps being corrected when the thread changes size
    // (late layout: code highlighting, images, rows measured after the first paint) until the reader scrolls or PLACE_MS passes.
    const frames = (running: boolean) => { if (running) el.setAttribute('data-opening', ''); else el.removeAttribute('data-opening') }
    if (opensAtEnd(place, lastSent)) owner.open({ frames })
    else {
      owner.open({
        frames,
        spot: () => {
          const boxes = new Map(rowBoxes().map((r) => [r.id, r.top]))
          return placeTop(place!, (id) => boxes.get(id), Math.max(0, el.scrollHeight - el.clientHeight))
        }
      })
    }
    // The spot is kept while the chat is open too, since nothing unmounts the transcript when Kernel quits (KERNEL-922): shortly after the reader stops scrolling, and when the window goes.
    const keep = () => {
      const view = scroller.current
      // A chat that was just closed or archived has no spot to keep, nor has one in an archived workspace.
      const state = getState()
      if (!view || !state.chats[workspaceId]?.some((c) => c.id === chat.id && !c.closed) || state.workspaces.find((w) => w.id === workspaceId)?.status === 'archived') return
      // Still being put back, the view is not where the reader left it: the spot from before stays.
      if (owner.correcting) return
      savePlace(chat.id, readPlace(rowBoxes(), view.scrollTop, leftAtEnd(view.scrollHeight - view.scrollTop - view.clientHeight), [...itemsNow.current].reverse().find(followsSend)?.id))
    }
    const keeper = keepOpen(keep, KEEP_MS)
    const soon = keeper.soon
    el.addEventListener('scroll', soon, { passive: true })
    window.addEventListener('pagehide', keep)
    window.addEventListener('beforeunload', keep)
    return () => {
      el.removeAttribute('data-opening')
      keeper.stop()
      el.removeEventListener('scroll', soon)
      window.removeEventListener('pagehide', keep)
      window.removeEventListener('beforeunload', keep)
      keep()
      owner.stop()
    }
  }, [loaded])
  useEffect(() => () => owner.stop(), [owner])
  // The thread grows without gaining a row: a reply streaming text into the one it has, a step opening, a turn folding into its summary. Follow its size, not its row count.
  // The scroller's own size is watched too: the composer growing (the plan strip, typing, attachments, the queue, a banner) shrinks the view with the thread unchanged.
  useEffect(() => {
    const t = thread.current
    const box = scroller.current
    if (!t || !box || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver((entries) => {
      const grown = entries.find((e) => e.target === t)
      owner.resized(grown?.contentRect.height)
    })
    watch.observe(t)
    watch.observe(box)
    return () => watch.disconnect()
  }, [owner])
  const openedAt = useRef(Date.now())
  const reveal = useCallback((el: HTMLElement, planId: string) => {
    const box = scroller.current
    if (!box) return
    const go = shouldReveal(takePlace(chat.id)?.revealed, planId, owner.pinned)
    markRevealed(chat.id, planId)
    if (!go) return
    // The plan's row can be remounted while the glide runs, which leaves `el` detached and measuring zero. Look the plan up again whenever it is.
    const live = () => (el.isConnected ? el : box.querySelector<HTMLElement>(`[data-plan-id="${CSS.escape(planId)}"]`))
    const goal = () => {
      const plan = live()
      if (!plan) return box.scrollTop
      const view = box.getBoundingClientRect()
      const at = plan.getBoundingClientRect()
      return Math.round(plan.offsetHeight > box.clientHeight ? box.scrollTop + at.top - view.top - 8 : box.scrollTop + at.bottom - view.bottom + 14)
    }
    // The Approve strip opens over about a second and shrinks the view, so the reveal keeps following its goal past that, placed or glided.
    owner.reveal({ goal, instant: Date.now() - openedAt.current < OPEN_MS, holdMs: STRIP_MS })
  }, [chat.id, owner])
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
    const step = sendFollow(last, sentId.current, arrived.current, postedFromQueue(queuedAt.current, Date.now()), owner.pinned)
    if (step === 'follow') owner.sent()
    else if (followsSend(last) && last!.id !== sentId.current) show(!owner.pinned && owner.distFromEnd() > PIN_PX)
    if (followsSend(last)) sentId.current = last!.id
    arrived.current = true
    owner.follow()
  }, [items.length, loose.length, running, queued, loaded])
  // This chat is on screen, so it is read, whether the window has focus or not. Main can't tell which chat is shown, so it clears the flag when asked:
  // on opening the chat, and again whenever a turn ends in it while it stays open (KERNEL-507, KERNEL-508).
  const unreadAt = chat.unreadAt
  useEffect(() => { if (unreadAt !== undefined) void call('chats.markRead', { chatId: chat.id }).catch(() => undefined) }, [chat.id, unreadAt])

  // The project's first chat, made when the project was added: its setup block shows until the first message is sent.
  const firstChat = useStore((s) => s.projects.find((p) => p.id === ws?.projectId)?.firstChatId === chat.id)
  // An empty chat shows the centred welcome in place of the thread, which sits at the bottom of the scroll area.
  // A chat whose items have not arrived is not empty, whatever it holds: it shows nothing until they do, or Try again when the load failed (KERNEL-860).
  const empty = !loading && !failed && !items.length && !loose.length && !running && !(ws?.prState === 'changes' && pr)
  const newCount = useMemo(() => countNew(items, before, isMessage), [items, before])
  // A chat that couldn't load is a calm empty state with Try again, and one toast with the same way to try again (DESIGN.md, State kinds).
  const reload = useCallback(() => loadWorkspace(workspaceId).catch(() => undefined), [workspaceId])
  useRetryKey(`chat:${chat.id}`, reload)
  useEffect(() => { if (failed) failToast("Couldn't load this chat", "The transcript file couldn't be read.", `chat:${chat.id}`) }, [failed, chat.id])
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
  const forkWorkspace = useCallback((itemId: string) => attempt('Could not fork into a new workspace', async () => {
    const next = await call('workspaces.fork', { chatId, itemId })
    actions.workspaces.upsert(next)
    await loadWorkspace(next.id)
    go({ name: 'workspace', workspaceId: next.id })
  }), [chatId])

  const edit = useRef(onEdit)
  edit.current = onEdit
  const editMessage = useCallback((text: string) => edit.current(text), [])
  const diff = useRef(onOpenDiff)
  diff.current = onOpenDiff
  const openDiff = useCallback((path: string) => diff.current(path), [])

  return (
    <div className="ws-chat" data-rail={rail.current.length >= RAIL_MIN || undefined}>
      <ChatRail key={chat.id} entries={rail.current} scroller={scroller} glide={railGlide} />
      <div ref={scroller} aria-busy={loading || undefined} className="ws-scroll selectable" onScroll={onScroll} onScrollEnd={() => owner.landed()} onClick={(e) => { if ((e.target as Element).closest('[aria-expanded]')) owner.opened() }} onWheel={() => owner.hand()} onTouchStart={() => owner.hand()} onPointerDown={(e) => (e.target === e.currentTarget ? owner.hand() : owner.interrupt())} onKeyDown={press}>
        {failed && (
          <FailedState icon="chatOff" title="This chat didn't load" onRetry={reload}>Kernel keeps the file. Try again, or open the chat's folder.</FailedState>
        )}
        {/* The project's first chat opens with its worktree and setup, and sending the first message clears them (KERNEL-951, KERNEL-1093). Outside the thread, whose children line up with its blocks. */}
        {ws && !failed && empty && firstChat && <ChatSetupRows ws={ws} />}
        {ws && !failed && !firstChat && <SharedFolderNote ws={ws} />}
        {loading && <TranscriptSkeleton />}
        {empty && !firstChat && (
          <ChatWelcome title={`New tab with ${agentName}`} suggestions={isLead ? LEAD_SUGGESTIONS : SUGGESTIONS}
            onPick={(text) => sendMessage(chat.id, [{ type: 'text', text }])} />
        )}
        <TranscriptGlide.Provider value={reveal}>
        <TranscriptWorkspace.Provider value={workspaceId}>
        <TranscriptChat.Provider value={chatId}>
        <TranscriptAway.Provider value={away}>
        <TurnClock.Provider value={clock}>
        <div ref={thread} className="thread" style={empty || failed ? { display: 'none' } : undefined}>
          {blocks.map((b) => <Block key={b.kind === 'item' ? b.item.id : b.id} block={b} chatId={chatId} workspaceId={workspaceId} changes={changes} agentName={agentName} onEdit={editMessage} onOpenDiff={openDiff} onFork={fork} onForkWorkspace={worktree ? forkWorkspace : undefined} />)}
          {loose.map((a) => <ApprovalCard key={a.id} approval={a} inChat />)}
          {moveNotice && <ChatMoveNotice chat={chat} notice={moveNotice} agentName={agentName} />}
          {ws?.prState === 'changes' && pr && <ReviewCard ws={ws} pr={pr} agentName={agentName} />}
          {ws && <LocalMergeRow ws={ws} />}
          {running && !hasFold && <TurnLine since={since} />}
          <div />
        </div>
        </TurnClock.Provider>
        </TranscriptAway.Provider>
        </TranscriptChat.Provider>
        </TranscriptWorkspace.Provider>
        </TranscriptGlide.Provider>
      </div>
      {away && !empty && (newCount > 0
        ? <Button icon="arrowDown" className="ws-jump new" aria-label={`Scroll to bottom, ${newCount} new`} onClick={() => owner.toEnd()}>{newCount} new</Button>
        : <IconButton icon="arrowDown" label="Scroll to bottom" className="ws-jump" onClick={() => owner.toEnd()} />)}
    </div>
  )
}
