import { useMemo } from 'react'
import type { Workspace } from '@shared/types'
import { go, useStore } from '../../store'
import { AgentAvatar, EmptyState } from '../../ui'
import { useProjectSettings } from '../settings/useSettings'
import { handedOff, type HandedRow } from './handedOff'
import { usePrActions, usePrFacts } from './pr/usePr'
import { StageRow, useDoing, WorkspaceRows } from './SessionRail'
import { hasOwnWork, sessionView } from './sessionStages'

/** One teammate the chat handed work to: its avatar, name and task, and where its work stands. Pressing it opens that workspace. */
function HandedRowButton({ row }: { row: HandedRow }) {
  const { ws, word, needs } = row
  const name = useStore((s) => s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name ?? 'Teammate')
  const task = ws.title || ws.name
  return (
    <li>
      <button type="button" className="handed-row" aria-label={`Open ${name}'s workspace, ${task}, ${word}`} onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>
        <AgentAvatar name={name} size={20} />
        <span className="handed-text">
          <span className="handed-name ellipsis">{name}</span>
          <span className="handed-task ellipsis">{task}</span>
        </span>
        <span className="handed-word" data-needs={needs || undefined}>{word}</span>
      </button>
    </li>
  )
}

/**
 * The Session rail of a chat with Kernel (docs/decisions/lead-session-rail.md). "This chat" lists the chat's own stages once it has work of its own, with the first one
 * reading as started by your message. "Handed off" lists one row per workspace the chat created, the ones waiting on you first and then the newest.
 */
export function LeadRail({ ws, threadId }: { ws: Workspace; threadId: string | undefined }) {
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => !!s.running[c.id]))
  const waiting = useStore((s) => {
    const pending = s.approvals.filter((a) => a.status === 'pending' && a.workspaceId === ws.id)
    return pending.length ? (pending.some((a) => a.kind === 'question') ? 'answer' : 'approval') : undefined
  })
  const doing = useDoing(ws.id)
  const rs = useProjectSettings(ws.projectId)
  const facts = usePrFacts(ws)
  const own = hasOwnWork(ws, facts)
  const { stages } = useMemo(() => sessionView({ ws, running, waiting, doing, hasSetup: rs ? !!rs.scripts.setup : undefined, pr: facts, lead: true }), [ws, running, waiting, doing, rs, facts])
  const main = stages.flatMap((s) => s.buttons ?? []).find((b) => b.tone !== 'outline' && !b.busy)
  const run = usePrActions(ws, { key: main?.id, archivable: ws.prState === 'merged' || ws.prState === 'closed' })
  const workspaces = useStore((s) => s.workspaces)
  const chats = useStore((s) => s.chats)
  const runningBy = useStore((s) => s.running)
  const approvals = useStore((s) => s.approvals)
  const rows = useMemo(() => handedOff({ workspaces, chats, running: runningBy, approvals }, ws, threadId), [workspaces, chats, runningBy, approvals, ws, threadId])
  return (
    <aside className="ws-rail" aria-label="Session">
      {own && (
        <section className="rail-card" aria-label="This chat">
          <header className="rail-head"><h2>This chat</h2><span className="rail-id">{ws.name}</span></header>
          <ol className="rail-stages">{stages.map((s, i) => <StageRow key={s.id} stage={s} last={i === stages.length - 1} ws={ws} run={run} />)}</ol>
          {!ws.shared && <div className="rail-rows"><WorkspaceRows ws={ws} /></div>}
        </section>
      )}
      {rows.length > 0 && (
        <section className="rail-card" aria-label="Handed off">
          <header className="rail-head"><h2>Handed off</h2><span className="rail-count">{rows.length}</span></header>
          <ul className="handed-list">{rows.map((r) => <HandedRowButton key={r.ws.id} row={r} />)}</ul>
        </section>
      )}
      {!own && rows.length === 0 && (
        <section className="rail-card" aria-label="Nothing yet">
          <div className="rail-nothing"><EmptyState icon="railList" title="Nothing yet">Progress on this chat's own changes and the work it hands to teammates show up here.</EmptyState></div>
        </section>
      )}
    </aside>
  )
}
