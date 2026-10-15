import { randomUUID } from 'node:crypto'
import type { Chat, OpenItem, Workspace } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import type { TeamEvent } from '../services/leadUpdates'
import { namesText } from '../services/mentions'
import { capText } from '../services/text'
import { Feature } from './feature'

/** One teammate workspace in a Team update the Lead got, with its events as the update told them. */
export interface Delivered { ws: Workspace; name: string; events: TeamEvent[] }

/** A question or a task is cut to this in the reminder. The Lead read it whole in the Team update. */
const QUOTE_MAX = 200

/** What list_workspaces says a workspace is owed. */
const MARK: Record<Exclude<OpenItem['kind'], 'mention'>, string> = { question: 'question', blockers: 'blockers to pass on', 'handoff.proposed': 'proposed hand-off' }

/** One line of the Stop hook's reminder. Mentions share one line, `mentionLine`. */
function itemLine(i: OpenItem): string {
  const at = `workspace ${i.workspaceId}`
  switch (i.kind) {
    case 'question': return `${i.name} asked you: "${capText(i.text ?? '', QUOTE_MAX)}" (${at}). Answer with mcp__kernel__message_agent to it. If the approved plan doesn't cover it, ask first with mcp__kernel__ask_user, with about set to ${i.workspaceId}.`
    case 'blockers': { const n = i.blockers ?? 1; return `A review found ${n} ${n === 1 ? 'blocker' : 'blockers'} in ${i.name}'s work (${at}) that you haven't passed on. Send them with mcp__kernel__message_agent to it.` }
    case 'handoff.proposed': { const to = i.proposed?.name ?? 'another teammate'; return `${i.name} proposed handing "${capText(i.text ?? '', QUOTE_MAX)}" to ${to} (${at}). Propose it to the user and call mcp__kernel__create_workspace for ${to} only on a go-ahead, or tell ${i.name} with message_agent why not.` }
    case 'mention': return mentionLine([i.name])
  }
}

const mentionLine = (names: string[]) => `The user addressed their message to ${namesText(names)}. For ${names.length === 1 ? 'them' : 'each'}, call mcp__kernel__create_workspace, mcp__kernel__message_agent to their workspace, or mcp__kernel__ask_user.`

/** The Stop hook's reminder: everything the chat owes, oldest first, with the mentions on one line. */
export function openReminder(items: OpenItem[]): string {
  const mentions = items.filter((i) => i.kind === 'mention').map((i) => i.name)
  const lines = [...items.filter((i) => i.kind !== 'mention').map(itemLine), ...(mentions.length ? [mentionLine(mentions)] : [])]
  return ["You haven't acted on these yet:", ...lines.map((l) => `- ${l}`), 'Act on each one now. If one needs nothing from you yet, say why in one line.'].join('\n')
}

/**
 * What each Lead chat owes until the Lead acts on it (KERNEL-749), kept in SQLite so it survives a restart. `LEAD_RULE` asks
 * the Lead to answer teammates and pass blockers on; this holds it to that. An item opens when a Team update with a question,
 * a proposed hand-off or a review's blockers reaches a Lead tab, or when the user addresses a teammate with @ (KERNEL-745). It
 * closes when the Lead messages that workspace, creates a workspace for that teammate or asks the user about it, or when the
 * user dismisses it. Items belong to the Lead chat, so every tab of it owes them, except a mention, which is its tab's.
 */
export class OpenItems extends Feature {
  private threadOf(chatId: string) { return this.store.chat(chatId)?.threadId ?? chatId }

  private open(chat: Chat, projectId: string, key: string, item: Pick<OpenItem, 'kind' | 'agentId' | 'name'> & Partial<OpenItem>) {
    const threadId = chat.threadId ?? chat.id
    this.store.saveOpenItem({ ...item, id: randomUUID(), projectId, threadId, chatId: chat.id, createdAt: Date.now() }, key)
    this.changed(threadId)
  }

  /** Closes `items` of the Lead chat `threadId`, and tells the window once when there were any (KERNEL-791). */
  private drop(threadId: string, items: OpenItem[]) {
    if (!items.length) return
    this.store.deleteOpenItems(items.map((i) => i.id))
    this.changed(threadId)
  }

  private changed(threadId: string) { bus.push({ type: 'openItems.changed', threadId }) }

  /**
   * A Team update reached the Lead tab `chat` (`LeadUpdates`). Its questions, proposed hand-offs and blockers on the reviewed
   * PR's latest commit open items. A newer one of the same kind for the same workspace takes the older one's place.
   */
  delivered(chat: Chat, rows: Delivered[]) {
    for (const { ws, name, events } of rows) {
      for (const e of events) {
        if (e.kind === 'question' && e.question) this.open(chat, ws.projectId, `question:${ws.id}`, { kind: 'question', workspaceId: ws.id, agentId: ws.agentId, name, text: e.question.text })
        else if (e.kind === 'handoff.proposed' && e.proposal) {
          this.open(chat, ws.projectId, `handoff:${ws.id}:${e.proposal.agentId}`, { kind: 'handoff.proposed', workspaceId: ws.id, agentId: ws.agentId, name, text: e.proposal.task, proposed: { agentId: e.proposal.agentId, name: e.proposal.agent } })
        } else if (e.kind === 'review' && e.review?.verdict === 'blockers' && e.review.current) {
          const of = this.store.workspace(e.review.of)
          if (of) this.open(chat, ws.projectId, `blockers:${of.id}`, { kind: 'blockers', workspaceId: of.id, agentId: of.agentId, name: e.review.ofName, blockers: e.review.total ?? e.review.blockers?.length ?? 1 })
        }
      }
    }
  }

  /** The user addressed `mentioned` in a message in the Lead tab `chat` (KERNEL-745). */
  mentioned(chat: Chat, mentioned: { agentId: string; name: string }[]) {
    const projectId = this.store.workspace(chat.workspaceId)?.projectId
    if (!projectId) return
    for (const m of mentioned) this.open(chat, projectId, `mention:${chat.id}:${m.agentId}`, { kind: 'mention', agentId: m.agentId, name: m.name })
  }

  /** message_agent reached `ws`: what the chat owes that workspace, and a mention of its teammate. */
  messaged(chatId: string, ws: Workspace) { this.close(chatId, (i) => i.workspaceId === ws.id || (i.kind === 'mention' && i.agentId === ws.agentId)) }

  /** create_workspace handed work to `agentId`: a mention of them, and a hand-off a teammate proposed for them. */
  created(chatId: string, agentId: string) { this.close(chatId, (i) => (i.kind === 'mention' && i.agentId === agentId) || i.proposed?.agentId === agentId) }

  /**
   * ask_user, about the workspaces or teammates `about` names by id. Left out, the answer covers the teammates the user
   * addressed in this tab, as before (KERNEL-745). Blockers go to their author, so asking the user never closes them.
   */
  asked(chatId: string, about: string[] = []) {
    if (!about.length) { this.close(chatId, (i) => i.kind === 'mention' && i.chatId === chatId); return }
    this.close(chatId, (i) => i.kind !== 'blockers' && [i.workspaceId, i.agentId, i.proposed?.agentId].some((id) => !!id && about.includes(id)))
  }

  /** The user wrote in the tab, or stopped its turn: they took over from the mentions there (KERNEL-745). */
  userSent(chatId: string) { this.close(chatId, (i) => i.kind === 'mention' && i.chatId === chatId) }

  dismiss(id: string) {
    const item = this.store.openItem(id)
    if (item) this.drop(item.threadId, [item])
  }

  private close(chatId: string, which: (i: OpenItem) => boolean) {
    const threadId = this.threadOf(chatId)
    this.drop(threadId, this.store.openItems(threadId).filter(which))
  }

  /**
   * What the tab `chatId` owes now: its Lead chat's items and its own mentions. An item whose workspace was archived or
   * deleted closes here, since nobody is left to answer.
   */
  owed(chatId: string): OpenItem[] {
    const threadId = this.threadOf(chatId)
    const items = this.store.openItems(threadId)
    const gone = items.filter((i) => { if (!i.workspaceId) return false; const ws = this.store.workspace(i.workspaceId); return !ws || ws.status === 'archived' })
    this.drop(threadId, gone)
    return items.filter((i) => !gone.includes(i) && (i.kind !== 'mention' || i.chatId === chatId))
  }

  /** The Stop hook's reminder: what the tab owes, once, and again only after a new item opens. */
  atStop(chatId: string): string | undefined {
    const owed = this.owed(chatId)
    const fresh = owed.filter((i) => !i.reminded)
    if (!fresh.length) return undefined
    this.store.updateOpenItems(fresh.map((i) => ({ ...i, reminded: true })))
    return openReminder(owed)
  }

  /** What list_workspaces adds after each workspace the tab owes something, by workspace id: " · open: question, blockers to pass on". */
  marks(chatId: string): Map<string, string> {
    const kinds = new Map<string, Set<string>>()
    for (const i of this.owed(chatId)) if (i.workspaceId && i.kind !== 'mention') kinds.set(i.workspaceId, (kinds.get(i.workspaceId) ?? new Set()).add(MARK[i.kind]))
    return new Map([...kinds].map(([id, k]) => [id, ` · open: ${[...k].join(', ')}`]))
  }

  handlers() {
    return {
      'openItems.list': async ({ threadId }) => this.store.openItems(threadId),
      'openItems.dismiss': async ({ id }) => { this.dismiss(id); return { ok: true as const } }
    } satisfies Partial<Handlers>
  }
}
