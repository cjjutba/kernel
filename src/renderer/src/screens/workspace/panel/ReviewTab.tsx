import { useMemo, useState } from 'react'
import type { Workspace } from '@shared/types'
import { REVIEW_KINDS } from '@shared/types'
import { lensOf, reviewVerdicts } from '@shared/merge'
import { useStore } from '../../../store'
import { useRemembered } from '../../../remember'
import { FileIcon } from '../../../components/FileIcon'
import { AgentAvatar, Button, EmptyList, Icon, LinkButton } from '../../../ui'
import { commitAge } from '../compare'
import { sendMessage } from '../composer/sendMessage'

/** One thing a reviewer wants changed: a blocker one of Kernel's reviewers found, or a comment on the pull request, with where it is and who said it. */
interface Item { id: string; path?: string; line?: number; text: string; tag?: string; by: string; resolved: boolean; byYou: boolean }

const kindLabel = (kind: string) => REVIEW_KINDS.find((k) => k.id === kind)?.label ?? kind

/** The open items as a message to the agent: each one's place and words. */
function messageFor(items: Item[]): string {
  const lines = items.map((i) => `- ${i.path ? `${i.path}${i.line ? `:${i.line}` : ''}: ` : ''}${i.text}`)
  return `${items.length === 1 ? 'The review found this' : `The review found ${items.length} things`} to fix:\n${lines.join('\n')}`
}

const FILTERS = [{ id: 'open', label: 'Open' }, { id: 'resolved', label: 'Resolved' }, { id: 'all', label: 'All' }] as const

/**
 * The Review tab (Pen 9.7): who reviewed the branch and when, what they said, and each thing to fix as a card with Ask the agent to fix and Resolve. Open, Resolved and All
 * narrow the cards. The blockers come from the reviews Kernel ran on the PR's latest commit and the comments from GitHub's review threads. Resolve is yours: it marks the card
 * read here and changes nothing on GitHub. Send all puts every open card in one message to the agent.
 */
export function ReviewTab({ ws }: { ws: Workspace }) {
  const agents = useStore((s) => s.agents[ws.projectId])
  const pr = useStore((s) => s.prs[ws.id])
  const chat = useStore((s) => s.chats[ws.id]?.find((c) => c.kind === 'chat' && !c.closed))
  const [raw, setRaw] = useRemembered(`kernel.reviewResolved:${ws.id}`, (v) => v ?? '')
  const mine = useMemo(() => new Set(raw ? raw.split('\n') : []), [raw])
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('open')
  const nameOf = (agentId: string) => agents?.find((a) => a.id === agentId)?.name ?? agentId
  const agent = agents?.find((a) => a.id === ws.agentId)?.name ?? 'the agent'

  const { current } = reviewVerdicts({ ...ws, prHead: pr?.head ?? ws.prHead })
  const latest = current.reduce<(typeof current)[number] | undefined>((a, b) => (!a || b.ts > a.ts ? b : a), undefined)
  const items: Item[] = [
    ...current.filter((v) => v.verdict === 'blockers').flatMap((v) => (v.blockers?.length ? v.blockers : [{ text: v.summary }]).map((b, i): Item => {
      const id = `${v.workspaceId}:${lensOf(v)}:${i}`
      return { id, path: 'file' in b ? b.file : undefined, line: 'line' in b ? b.line : undefined, text: b.text, tag: kindLabel(lensOf(v)), by: nameOf(v.agentId), resolved: mine.has(id), byYou: mine.has(id) }
    })),
    ...(pr?.comments ?? []).map((c): Item => ({ id: `gh:${c.id}`, path: c.path, line: c.line, text: c.body, tag: c.association === 'outside' ? 'Outside the repo' : undefined, by: c.author, resolved: c.resolved || mine.has(`gh:${c.id}`), byYou: !c.resolved && mine.has(`gh:${c.id}`) }))
  ]
  const open = items.filter((i) => !i.resolved)
  const resolved = items.filter((i) => i.resolved)
  const shown = filter === 'open' ? open : filter === 'resolved' ? resolved : items
  const counts = { open: open.length, resolved: resolved.length, all: items.length }
  const resolve = (id: string) => setRaw([...mine, id].join('\n'))
  const ask = (list: Item[]) => { if (chat) void sendMessage(chat.id, [{ type: 'text', text: messageFor(list) }]) }

  if (!latest && !items.length) {
    return <div className="rv-tab"><EmptyList icon="eye" title="No review yet">A reviewer reads the pull request once it is open.</EmptyList></div>
  }
  const reviewer = latest ? nameOf(latest.agentId) : items[0]?.by ?? 'A reviewer'
  return (
    <div className="rv-tab">
      <div className="panel-scroll rv-body">
        <header className="rv-head">
          <AgentAvatar name={reviewer} size={20} />
          <h2 className="rv-title">{reviewer} reviewed this branch</h2>
          {latest && <span className="rv-ago">{commitAge(latest.ts)}</span>}
        </header>
        {latest?.summary && <p className="rv-summary">{latest.summary}</p>}
        <div className="rv-filters" role="group" aria-label="Show comments">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="rv-count">{counts[f.id]}</span></button>
          ))}
        </div>
        {shown.length === 0 && <p className="rv-none">{filter === 'resolved' ? 'Nothing is resolved yet.' : 'Nothing is open.'}</p>}
        {shown.map((i) => (i.resolved ? <ResolvedRow key={i.id} item={i} /> : (
          <article key={i.id} className="rv-card">
            <header className="rv-card-head">
              {i.path ? <><FileIcon path={i.path} /><span className="mono rv-path ellipsis">{i.path}</span>{i.line ? <span className="mono rv-line">:{i.line}</span> : null}</> : <span className="rv-path-none">On the branch</span>}
              <span className="grow" />
              {i.tag && <span className="rv-tag">{i.tag}</span>}
            </header>
            <p className="rv-text">{i.text}</p>
            <footer className="rv-card-foot">
              <Button size="sm" disabled={!chat} onClick={() => ask([i])}>Ask {agent} to fix</Button>
              <LinkButton variant="quiet" size="ui" onClick={() => resolve(i.id)}>Resolve</LinkButton>
              <span className="grow" />
              <AgentAvatar name={i.by} size={14} /><span className="rv-by">{i.by}</span>
            </footer>
          </article>
        )))}
      </div>
      {open.length > 0 && (
        <footer className="rv-foot">
          <span className="rv-foot-text">{open.length} open {open.length === 1 ? 'comment' : 'comments'}</span>
          <span className="grow" />
          <Button variant="primary" disabled={!chat} onClick={() => ask(open)}>{open.length === 1 ? `Send to ${agent}` : open.length === 2 ? `Send both to ${agent}` : `Send all to ${agent}`}</Button>
        </footer>
      )}
    </div>
  )
}

/** A resolved item folds to one line: where it was and what it said. */
function ResolvedRow({ item }: { item: Item }) {
  return (
    <div className="rv-done">
      <Icon name="check" size={12} />
      {item.path && <><FileIcon path={item.path} size={14} /><span className="mono rv-path ellipsis">{item.path}</span>{item.line ? <span className="mono rv-line">:{item.line}</span> : null}</>}
      <span className="rv-done-text ellipsis">{item.text}</span>
      <span className="grow" />
      <span className="rv-by">{item.byYou ? 'Resolved by you' : 'Resolved'}</span>
    </div>
  )
}
