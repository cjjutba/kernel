import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Approval, ChangedFile, Chat, ChatItem, ChatPart } from '@shared/types'
import { call } from '../../api'
import { Icon, Skeleton, Spinner, type IconName } from '../../ui'
import { actions, loadWorkspace, useStore } from '../../store'
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

function ReplyMessage({ item, chat, onFork }: { item: Extract<ChatItem, { kind: 'text' }>; chat: Chat; onFork: (itemId: string) => void }) {
  return (
    <div className="msg msg-reply">
      <Markdown text={item.text} />
      <MessageActions label="Message actions" items={[
        { label: 'Copy', onClick: () => void copyText(item.text) },
        { label: 'Retry', onClick: () => void attempt('Could not retry', () => call('chats.retry', { chatId: chat.id, itemId: item.id })) },
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

type Tool = Extract<ChatItem, { kind: 'tool' }>

/**
 * One step of the agent's work: a button that opens in place to what it did (KERNEL-198). The chevron shows on hover and
 * focus and stays while open. A row whose preview is its own text (thinking, a message) drops the preview once open. With nothing to show the row is inert and has no chevron. Open state is local, so a
 * tool going from running to done keeps it. `compact` is the row inside the folded list: no icon, a right-hand note.
 */
function StepRow({ icon, failed, label, detail, mono, meta, compact, children }: { icon?: IconName; failed?: boolean; label: string; detail?: string; mono?: boolean; meta?: string; compact?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const can = !!children
  return (
    <div className="col" style={{ gap: 4 }}>
      <button type="button" className="trow trow-btn" aria-expanded={can ? open : undefined} aria-controls={can ? panel : undefined} disabled={!can} onClick={() => setOpen(!open)}>
        {icon && <span style={{ color: failed ? 'var(--del)' : 'var(--muted)' }}><Icon name={icon} size={15} stroke={icon === 'bulb' ? 1.3 : 1.5} /></span>}
        <span className="ellipsis" style={{ maxWidth: 300, flexShrink: 0, color: failed && compact ? 'var(--del)' : 'var(--ink-2)' }}>{label}</span>
        <span className={`grow muted ellipsis${mono ? ' mono' : ''}`} style={mono ? { fontSize: 12 } : undefined} aria-hidden={mono ? undefined : true}>{mono || !open ? detail : null}</span>
        {meta && <span className="mono muted" style={{ fontSize: 11.5 }}>{meta}</span>}
        {can && <span className="chev step-chev" data-open={open}><Icon name="right" size={12} /></span>}
      </button>
      {open && can && <div id={panel} className="step-body" data-compact={compact || undefined}>{children}</div>}
    </div>
  )
}

function ThinkingRow({ item, compact }: { item: Extract<ChatItem, { kind: 'thinking' }>; compact?: boolean }) {
  return <StepRow icon="bulb" label="Thinking" detail={item.text} compact={compact}>{item.text.trim() && <div className="step-text">{item.text}</div>}</StepRow>
}

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

/** The tool's input as the text a person would have typed: the command, the path, the pattern, the prompt. Anything else is JSON. */
function inputView(item: Tool): ReactNode {
  const i = item.input
  if (!i || !Object.keys(i).length) return null
  const lines = (...rows: (string | undefined)[]) => rows.filter((r): r is string => r !== undefined).join('\n')
  const known = ((): ReactNode => {
    switch (item.name) {
      case 'Bash': return text(i.command)
      case 'Edit': return typeof i.old_string === 'string' && typeof i.new_string === 'string' ? <EditDiff from={i.old_string} to={i.new_string} /> : undefined
      case 'Write': return text(i.file_path) && typeof i.content === 'string' ? lines(text(i.file_path), '', i.content) : undefined
      case 'Read': return text(i.file_path) && lines(text(i.file_path), typeof i.offset === 'number' ? `offset: ${i.offset}` : undefined, typeof i.limit === 'number' ? `limit: ${i.limit}` : undefined)
      case 'Grep': case 'Glob': return text(i.pattern) && lines(`pattern: ${text(i.pattern)}`, text(i.path) && `path: ${text(i.path)}`)
      case 'Agent': case 'Task': return text(i.prompt)
      default: return undefined
    }
  })()
  return known || JSON.stringify(i, null, 2)
}

/** What a tool shows when opened: its input, then its output. A tool with neither has nothing to open. */
function toolBody(item: Tool): ReactNode {
  const input = inputView(item)
  if (!input && !item.output) return null
  return (
    <>
      {input && <div className="code tool-out">{input}</div>}
      {item.output && <div className="code tool-out">{item.output}{item.outputCut && <span className="step-cut">Output cut at 20,000 characters</span>}</div>}
    </>
  )
}

function ToolRow({ item, meta, compact }: { item: Tool; meta?: string; compact?: boolean }) {
  return <StepRow icon={compact ? undefined : 'term'} failed={item.status === 'failed'} label={item.label} detail={item.detail} mono meta={meta} compact={compact}>{toolBody(item)}</StepRow>
}

/** Edit and Write calls show what they added and removed, read from the changed files. */
function toolMeta(item: Tool, changes: ChangedFile[]): string {
  const file = (item.name === 'Edit' || item.name === 'Write') && changes.find((c) => c.path === item.detail)
  if (file) return [file.added ? `+${file.added}` : '', file.removed ? `-${file.removed}` : ''].filter(Boolean).join(' ')
  return item.durationMs !== undefined ? `${(item.durationMs / 1000).toFixed(item.durationMs < 10_000 ? 1 : 0)}s` : ''
}

/** A row in the folded list: every step the turn took before its reply, in order, each closed until opened. */
function GroupItem({ item, changes }: { item: ChatItem; changes: ChangedFile[] }) {
  if (item.kind === 'tool') return <div className="group-item"><ToolRow item={item} meta={toolMeta(item, changes)} compact /></div>
  if (item.kind === 'thinking') return <div className="group-item"><ThinkingRow item={item} compact /></div>
  if (item.kind === 'text') return <div className="group-item"><StepRow label="Message" detail={item.text} compact>{item.text.trim() && <div className="step-text"><Markdown text={item.text} /></div>}</StepRow></div>
  return null
}

function ToolGroup({ block, changes }: { block: Extract<ThreadBlock, { kind: 'group' }>; changes: ChangedFile[] }) {
  const open = useStore((s) => s.ui.workspace.toolsOpen)
  const id = `${block.id}-list`
  return (
    <div className="col" style={{ gap: 2 }}>
      <button type="button" className="group-btn" aria-expanded={open} aria-controls={id} onClick={() => actions.ui.setWorkspaceView({ toolsOpen: !open })}>
        <span className="chev" data-open={open}><Icon name="right" size={12} /></span>
        {groupLabel(block.tools.length, block.messages)}
      </button>
      {open && (
        <div id={id} className="group-list">
          {block.items.map((i) => <GroupItem key={i.id} item={i} changes={changes} />)}
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

function Block({ block, chat, changes, agentName, onEdit, onFork, onTerminal }: { block: ThreadBlock; chat: Chat; changes: ChangedFile[]; agentName: string; onEdit: (text: string) => void; onFork: (itemId: string) => void; onTerminal: () => Promise<unknown> }) {
  if (block.kind === 'error') {
    return (
      <ErrorCard message={block.message} output={block.output} agentName={agentName} onTerminal={onTerminal}
        onFix={() => attempt('Could not send', () => call('chats.send', { chatId: chat.id, parts: [{ type: 'text', text: `Fix this: ${block.message}` }] }))}
        onRetry={() => attempt('Could not retry', () => call('chats.retry', { chatId: chat.id, itemId: block.id }))} />
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
    case 'text': return <ReplyMessage item={item} chat={chat} onFork={onFork} />
    case 'thinking': return <ThinkingRow item={item} />
    case 'tool': return <ToolRow item={item} />
    case 'note': return <div className="note"><span className="grow">{item.text}</span>{item.link && <NoteLink link={item.link} />}</div>
    case 'interrupted': return <span className="interrupted">INTERRUPTED BY YOU</span>
    case 'approval': return <ApprovalRow id={item.approvalId} />
    // Result is folded into a meta row or an error card by buildThread.
    case 'result': return null
  }
}

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

export function Transcript({ chat, workspaceId, changes, onEdit, onForked }: { chat: Chat; workspaceId: string; changes: ChangedFile[]; onEdit: (text: string) => void; onForked: (chatId: string) => void }) {
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
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [items.length, loose.length, running, chat.id])
  const since = [...items].reverse().find((i) => i.kind === 'user')?.ts ?? Date.now()

  // An empty chat shows the centred welcome in place of the thread, which sits at the bottom of the scroll area.
  const empty = !items.length && !loose.length && !running && !(ws?.prState === 'changes' && pr)
  const fork = (itemId: string) => void attempt('Could not fork', async () => {
    const forked = await call('chats.fork', { chatId: chat.id, itemId })
    await loadWorkspace(workspaceId)
    onForked(forked.id)
  })

  const terminal = () => attempt('Could not open a terminal', async () => {
    const t = await call('chats.create', { workspaceId, kind: 'terminal' })
    await loadWorkspace(workspaceId)
    onForked(t.id)
  })

  return (
    <div className="ws-scroll selectable">
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
        {blocks.map((b) => <Block key={b.kind === 'item' ? b.item.id : b.id} block={b} chat={chat} changes={changes} agentName={agentName} onEdit={onEdit} onFork={fork} onTerminal={terminal} />)}
        {loose.map((a) => <ApprovalCard key={a.id} approval={a} inChat />)}
        {ws?.prState === 'changes' && pr && <ReviewCard ws={ws} pr={pr} agentName={agentName} />}
        {running && !planWaits && <Elapsed since={since} />}
        <div ref={end} />
      </div>
    </div>
  )
}
