import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Approval, ChangedFile, Chat, ChatItem, ChatPart } from '@shared/types'
import { call } from '../../api'
import { Icon, Skeleton, Spinner } from '../../ui'
import { getState, loadWorkspace, useStore } from '../../store'
import { openRoom } from '../../lead'
import { ApprovalCard } from './cards/ApprovalCard'
import { waitingPlan } from './cards/steps'
import { ErrorCard } from './cards/ErrorCard'
import { Markdown } from './markdown'
import { attempt, copyText, MessageActions } from './MessageActions'
import { chipIcon, ImageButton, isPastedText, TextButton } from './composer/Chip'
import { buildThread, fileChips, fmtDuration, groupLabel, type ThreadBlock } from './thread'
import { InstructionCard } from './pr/InstructionCard'
import { instructionOf } from './pr/model'
import { userView } from './sender'
import { KernelNote } from './KernelNote'
import { TeamUpdateCard } from './cards/TeamUpdateCard'
import { ReviewCard } from './pr/ReviewCard'

const EMPTY: ChatItem[] = []
/** The reader counts as following the chat while the end is this close. */
const PIN_PX = 80

const partsText = (parts: ChatPart[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')

function PartChip({ part }: { part: ChatPart }) {
  if (part.type === 'text') return null
  const icon = part.type === 'skill' ? null : chipIcon(part)
  const body = <>{icon ? <Icon name={icon} size={12} /> : <span aria-hidden="true" className="muted">/</span>}{part.name}</>
  if (part.type === 'image' && part.dataUrl) return <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className="msg-chip" data-kind="image">{body}</ImageButton>
  if (isPastedText(part)) return <TextButton paste={part} className="msg-chip" data-kind="file">{body}</TextButton>
  return <span className="msg-chip" data-kind={part.type}>{body}</span>
}

function UserMessage({ item, onEdit }: { item: Extract<ChatItem, { kind: 'user' }>; onEdit: (text: string) => void }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">
        {item.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text} </span> : <PartChip key={i} part={p} />))}
      </div>
      <MessageActions align="end" label="Message actions" items={[{ label: 'Copy', onClick: () => void copyText(partsText(item.parts)) }, { label: 'Edit', onClick: () => onEdit(partsText(item.parts)) }]} />
    </div>
  )
}

function ReplyMessage({ item, chatId, onFork }: { item: Extract<ChatItem, { kind: 'text' }>; chatId: string; onFork: (itemId: string) => void }) {
  return (
    <div className="msg msg-reply">
      <Markdown text={item.text} />
      <MessageActions label="Message actions" items={[
        { label: 'Copy', onClick: () => void copyText(item.text) },
        { label: 'Retry', onClick: () => void attempt('Could not retry', () => call('chats.retry', { chatId, itemId: item.id })) },
        { label: 'Fork into new chat', onClick: () => onFork(item.id) }
      ]} />
    </div>
  )
}

/** `kernel://floor/<roomId>` opens that room, its Lead chat now the floor is hidden (D-104). Anything else is a normal link. */
function NoteLink({ link }: { link: { label: string; href: string } }) {
  const floor = /^kernel:\/\/floor\/(.+)$/.exec(link.href)
  if (!floor) return <a href={link.href}>{link.label}</a>
  return <a href={link.href} onClick={(e) => { e.preventDefault(); void openRoom(floor[1]) }}>{link.label}</a>
}

function ThinkingRow({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }) {
  return <div className="trow"><span className="muted"><Icon name="bulb" size={15} stroke={1.3} /></span><span className="ink2">Thinking</span><span className="muted ellipsis">{item.text}</span></div>
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const failed = item.status === 'failed'
  return (
    <div className="col" style={{ gap: 4 }}>
      <button type="button" className="trow trow-btn" aria-expanded={item.output ? open : undefined} disabled={!item.output} onClick={() => setOpen(!open)}>
        <span style={{ color: failed ? 'var(--del)' : 'var(--muted)' }}><Icon name="term" size={15} stroke={1.5} /></span>
        <span className="ink2 ellipsis" style={{ maxWidth: 300, flexShrink: 0 }}>{item.label}</span>
        <span className="mono muted ellipsis" style={{ fontSize: 12 }}>{item.detail}</span>
      </button>
      {open && item.output && <div className="code tool-out">{item.output}</div>}
    </div>
  )
}

/** Edit and Write calls show what they added and removed, read from the changed files. */
function toolMeta(item: Extract<ChatItem, { kind: 'tool' }>, changes: ChangedFile[]): string {
  const file = (item.name === 'Edit' || item.name === 'Write') && changes.find((c) => c.path === item.detail)
  if (file) return [file.added ? `+${file.added}` : '', file.removed ? `-${file.removed}` : ''].filter(Boolean).join(' ')
  return item.durationMs !== undefined ? `${(item.durationMs / 1000).toFixed(item.durationMs < 10_000 ? 1 : 0)}s` : ''
}

function ToolGroup({ block, changes }: { block: Extract<ThreadBlock, { kind: 'group' }>; changes: ChangedFile[] }) {
  // Each group opens on its own. The view's flag only sets how a group starts, which is how WorkspaceToolCalls shows them open.
  const [open, setOpen] = useState(() => getState().ui.workspace.toolsOpen)
  const id = `${block.id}-list`
  return (
    <div className="col" style={{ gap: 2 }}>
      <button type="button" className="group-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="chev" data-open={open}><Icon name="right" size={12} /></span>
        {groupLabel(block.tools.length, block.messages)}
      </button>
      {open && (
        <div id={id} className="group-list">
          {block.tools.map((t) => (
            <div key={t.id} className="group-item">
              <div className="row" style={{ gap: 10, minWidth: 0 }}>
                <span style={{ flexShrink: 0, color: t.status === 'failed' ? 'var(--del)' : 'var(--ink-2)' }}>{t.label}</span>
                <span className="grow mono muted ellipsis" style={{ fontSize: 12 }}>{t.detail}</span>
                <span className="mono muted" style={{ fontSize: 11.5 }}>{toolMeta(t, changes)}</span>
              </div>
              {t.output && <div className="tool-out code">{t.output}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Seconds since the turn started. Counts from the message's own timestamp, so it is right after a reload. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return <span className="running"><Spinner label="Working" />{fmtDuration(now - since)}</span>
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
    case 'group': return b.kind === 'group' && a.id === b.id && a.messages === b.messages && sameList(a.tools, b.tools) && sameList(a.items, b.items)
    case 'files': return b.kind === 'files' && a.id === b.id && sameList(a.files, b.files)
    case 'meta': return b.kind === 'meta' && a.id === b.id && a.text === b.text
    case 'error': return b.kind === 'error' && a.id === b.id && a.message === b.message && a.output === b.output
  }
}

interface BlockProps { block: ThreadBlock; chatId: string; changes: ChangedFile[]; agentName: string; onEdit: (text: string) => void; onFork: (itemId: string) => void; onTerminal: () => Promise<unknown> }

/** Only a tool group reads the changed files, so a new list redraws the groups and nothing else. */
const sameProps = (a: BlockProps, b: BlockProps) =>
  sameBlock(a.block, b.block) && a.chatId === b.chatId && a.agentName === b.agentName && a.onEdit === b.onEdit && a.onFork === b.onFork && a.onTerminal === b.onTerminal
  && (a.block.kind !== 'group' || a.changes === b.changes)

const Block = memo(function Block({ block, chatId, changes, agentName, onEdit, onFork, onTerminal }: BlockProps) {
  if (block.kind === 'error') {
    return (
      <ErrorCard message={block.message} output={block.output} agentName={agentName} onTerminal={onTerminal}
        onFix={() => attempt('Could not send', () => call('chats.send', { chatId, parts: [{ type: 'text', text: `Fix this: ${block.message}` }] }))}
        onRetry={() => attempt('Could not retry', () => call('chats.retry', { chatId, itemId: block.id }))} />
    )
  }
  if (block.kind === 'group') return <ToolGroup block={block} changes={changes} />
  if (block.kind === 'meta') return <span className="meta">{block.text}</span>
  if (block.kind === 'files') {
    return (
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="meta" style={{ marginRight: 4 }}>Changed</span>
        {fileChips(block.files).map((c) => <span key={c.name} className="file-chip">{c.name}{c.added ? <span className="add">+{c.added}</span> : null}{c.removed ? <span className="del">-{c.removed}</span> : null}</span>)}
      </div>
    )
  }
  const item = block.item
  switch (item.kind) {
    case 'user': {
      const sent = instructionOf(item)
      if (sent) return <InstructionCard part={sent} />
      const view = userView(item)
      return view === 'update' ? <TeamUpdateCard item={item} /> : view === 'note' ? <KernelNote item={item} /> : <UserMessage item={item} onEdit={onEdit} />
    }
    case 'text': return <ReplyMessage item={item} chatId={chatId} onFork={onFork} />
    case 'thinking': return <ThinkingRow item={item} />
    case 'tool': return <ToolRow item={item} />
    case 'note': return <div className="note"><span className="grow">{item.text}</span>{item.link && <NoteLink link={item.link} />}</div>
    case 'interrupted': return <span className="interrupted">INTERRUPTED BY YOU</span>
    case 'approval': return <ApprovalRow id={item.approvalId} />
    // Result is folded into a meta row or an error card by buildThread.
    case 'result': return null
  }
}, sameProps)

/** The skeleton while a workspace is being set up (WorkspaceLoading.png). */
export function TranscriptSkeleton({ branch }: { branch: string }) {
  return (
    <div className="ws-scroll" aria-busy="true" aria-label="Opening workspace">
      <div className="thread" style={{ gap: 14 }}>
        <span style={{ alignSelf: 'flex-end', width: '56%' }}><Skeleton width="100%" height={58} /></span>
        <Skeleton width="30%" height={14} />
        <Skeleton width="92%" height={14} />
        <Skeleton width="74%" height={14} />
        <Skeleton width="46%" height={28} />
        <span className="meta" style={{ fontSize: 12.5 }}>Starting Claude Code in {branch}</span>
      </div>
    </div>
  )
}

export const Transcript = memo(function Transcript({ chat, workspaceId, changes, onEdit, onForked }: { chat: Chat; workspaceId: string; changes: ChangedFile[]; onEdit: (text: string) => void; onForked: (chatId: string) => void }) {
  const items = useStore((s) => s.items[chat.id] ?? EMPTY)
  const running = useStore((s) => !!s.running[chat.id])
  const approvals = useStore((s) => s.approvals)
  // The agent is waiting on you, not working, while its plan waits.
  const planWaits = useStore((s) => !!waitingPlan(s.approvals, chat))
  const agentName = useStore((s) => { const ws = s.workspaces.find((w) => w.id === workspaceId); return s.agents[ws?.roomId ?? '']?.find((a) => a.id === ws?.agentId)?.name ?? 'the agent' })
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const pr = useStore((s) => s.prs[workspaceId])
  const blocks = useMemo(() => buildThread(items), [items])
  // A pending request shows even before the engine has placed a card for it in the transcript.
  const loose = useMemo(() => {
    const placed = new Set(items.flatMap((i) => (i.kind === 'approval' ? [i.approvalId] : [])))
    return approvals.filter((a: Approval) => a.status === 'pending' && !placed.has(a.id) && a.workspaceId === workspaceId && (!a.chatId || a.chatId === chat.id))
  }, [approvals, items, workspaceId, chat.id])
  // The chat follows its end only while the reader is at it. Scrolling up to read stops it, scrolling back down starts it again.
  const scroller = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const onScroll = () => { const el = scroller.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_PX }
  // Rows far above the end are measured a frame after they first show, so the end moves once. Following again next frame lands on it.
  const follow = () => {
    end.current?.scrollIntoView({ block: 'end' })
    return requestAnimationFrame(() => { if (pinned.current) end.current?.scrollIntoView({ block: 'end' }) })
  }
  // A chat opens at its end.
  useLayoutEffect(() => { pinned.current = true; const frame = follow(); return () => cancelAnimationFrame(frame) }, [chat.id])
  // Sending a message follows it even from further up, since the reader just asked for something.
  const last = items[items.length - 1]
  const sent = last?.kind === 'user' && userView(last) === 'bubble'
  useEffect(() => {
    if (sent) pinned.current = true
    if (!pinned.current) return
    const frame = follow()
    return () => cancelAnimationFrame(frame)
  }, [items.length, loose.length, running])
  const since = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].ts; return Date.now() }, [items])

  // An empty chat shows the centred welcome in place of the thread, which sits at the bottom of the scroll area.
  const empty = !items.length && !loose.length && !running && !(ws?.prState === 'changes' && pr)
  // The rows are memoized, so these keep one identity while the chat and workspace stay the same, whatever the parent passes.
  const forked = useRef(onForked)
  forked.current = onForked
  const chatId = chat.id
  const fork = useCallback((itemId: string) => void attempt('Could not fork', async () => {
    const next = await call('chats.fork', { chatId, itemId })
    await loadWorkspace(workspaceId)
    forked.current(next.id)
  }), [chatId, workspaceId])

  const terminal = useCallback(() => attempt('Could not open a terminal', async () => {
    const t = await call('chats.create', { workspaceId, kind: 'terminal' })
    await loadWorkspace(workspaceId)
    forked.current(t.id)
  }), [workspaceId])
  const edit = useRef(onEdit)
  edit.current = onEdit
  const editMessage = useCallback((text: string) => edit.current(text), [])

  return (
    <div ref={scroller} className="ws-scroll selectable" onScroll={onScroll}>
      {empty && (
        <div className="chat-empty">
          <h2>{chat.kind === 'terminal' ? 'Big terminal' : `New chat with ${agentName}`}</h2>
          <span className="muted">Same worktree and branch, fresh context.</span>
          <div className="chat-suggest">
            {['Review the diff so far', 'Write tests for the table', 'Explain this branch'].map((text) => (
              <button key={text} type="button" onClick={() => void attempt('Could not send', () => call('chats.send', { chatId: chat.id, parts: [{ type: 'text', text }] }))}>{text}</button>
            ))}
          </div>
        </div>
      )}
      <div className="thread" style={empty ? { display: 'none' } : undefined}>
        {blocks.map((b) => <Block key={b.kind === 'item' ? b.item.id : b.id} block={b} chatId={chatId} changes={changes} agentName={agentName} onEdit={editMessage} onFork={fork} onTerminal={terminal} />)}
        {loose.map((a) => <ApprovalCard key={a.id} approval={a} inChat />)}
        {ws?.prState === 'changes' && pr && <ReviewCard ws={ws} pr={pr} agentName={agentName} />}
        {running && !planWaits && <Elapsed since={since} />}
        <div ref={end} />
      </div>
    </div>
  )
})
