import { useEffect, useMemo, useRef, useState } from 'react'
import type { Approval, ChangedFile, Chat, ChatItem, ChatPart } from '@shared/types'
import { call } from '../../api'
import { Icon, Skeleton, Spinner } from '../../ui'
import { actions, loadWorkspace, useStore } from '../../store'
import { ApprovalCard } from './cards/ApprovalCard'
import { ErrorCard } from './cards/ErrorCard'
import { Markdown } from './markdown'
import { attempt, copyText, MessageActions } from './MessageActions'
import { buildThread, fileChips, fmtDuration, groupLabel, type ThreadBlock } from './thread'
import { InstructionCard } from './pr/InstructionCard'
import { instructionOf } from './pr/model'
import { ReviewCard } from './pr/ReviewCard'

const EMPTY: ChatItem[] = []

const partsText = (parts: ChatPart[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')

function PartChip({ part }: { part: ChatPart }) {
  if (part.type === 'text') return null
  const icon = part.type === 'image' ? 'image' : part.type === 'file' ? 'doc' : null
  return (
    <span className="msg-chip" data-kind={part.type}>
      {icon ? <Icon name={icon} size={12} /> : <span aria-hidden="true" className="muted">/</span>}
      {part.name}
    </span>
  )
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

/** `kernel://floor/<roomId>` goes to that room's floor. Anything else is a normal link. */
function NoteLink({ link }: { link: { label: string; href: string } }) {
  const floor = /^kernel:\/\/floor\/(.+)$/.exec(link.href)
  if (!floor) return <a href={link.href}>{link.label}</a>
  return <a href={link.href} onClick={(e) => { e.preventDefault(); actions.ui.go({ name: 'floor', roomId: floor[1] }) }}>{link.label}</a>
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
  return a ? <ApprovalCard approval={a} /> : null
}

function Block({ block, chat, changes, agentName, onEdit, onFork, onTerminal }: { block: ThreadBlock; chat: Chat; changes: ChangedFile[]; agentName: string; onEdit: (text: string) => void; onFork: (itemId: string) => void; onTerminal: () => void }) {
  if (block.kind === 'error') {
    return (
      <ErrorCard message={block.message} output={block.output} agentName={agentName} onTerminal={onTerminal}
        onFix={() => void attempt('Could not send', () => call('chats.send', { chatId: chat.id, parts: [{ type: 'text', text: `Fix this: ${block.message}` }] }))}
        onRetry={() => void attempt('Could not retry', () => call('chats.retry', { chatId: chat.id, itemId: block.id }))} />
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
    case 'user': { const sent = instructionOf(item); return sent ? <InstructionCard part={sent} /> : <UserMessage item={item} onEdit={onEdit} /> }
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

  const fork = (itemId: string) => void attempt('Could not fork', async () => {
    const forked = await call('chats.fork', { chatId: chat.id, itemId })
    await loadWorkspace(workspaceId)
    onForked(forked.id)
  })

  const terminal = () => void attempt('Could not open a terminal', async () => {
    const t = await call('chats.create', { workspaceId, kind: 'terminal' })
    await loadWorkspace(workspaceId)
    onForked(t.id)
  })

  return (
    <div className="ws-scroll selectable">
      <div className="thread">
        {!items.length && (
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
        {blocks.map((b) => <Block key={b.kind === 'item' ? b.item.id : b.id} block={b} chat={chat} changes={changes} agentName={agentName} onEdit={onEdit} onFork={fork} onTerminal={terminal} />)}
        {loose.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        {ws?.prState === 'changes' && pr && <ReviewCard ws={ws} pr={pr} agentName={agentName} />}
        {running && <Elapsed since={since} />}
        <div ref={end} />
      </div>
    </div>
  )
}
