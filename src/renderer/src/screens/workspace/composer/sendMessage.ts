import type { ChatItem, ChatPart, MessageFrom, QueuedMessage, QueueReason, TeamUpdate } from '@shared/types'
import type { KernelApi } from '@shared/ipc'
import { isSentItem } from '@shared/approvalAnswer'
import { call, cleanError } from '../../../api'
import { actions, getState } from '../../../store'
import { newId } from '../../../compat'

type Sent = KernelApi['chats.send']['res']

/** Where a message sent now goes, from what the window already knows: the chat's tray when a turn runs, its worktree isn't made yet, something else holds it or the Mac is offline, else the chat. */
export function destinationOf(chatId: string): { queued: false } | { queued: true; why?: QueueReason } {
  const s = getState()
  const ws = Object.values(s.chats).flat().find((c) => c.id === chatId)?.workspaceId
  const worktreePending = ws ? s.workspaces.find((w) => w.id === ws)?.worktreePending : undefined
  const why = s.queueWhy[chatId] ?? (worktreePending ? 'worktree' : !s.system.online ? 'offline' : undefined)
  if (why) return { queued: true, why }
  return s.running[chatId] ? { queued: true } : { queued: false }
}

export interface SendOptions {
  /** The call failed. Everything drawn is already gone, and this runs after it: the box takes its text back, or a toast says why. Left out, a toast says why. */
  onFail?: (error: unknown) => void
}

interface Placed extends SendOptions {
  /** Who sent it, for a copy of a message Kernel sent. */
  from?: MessageFrom
  update?: TeamUpdate
  /** Makes the call under the id the window made. Left out it is `chats.send`. A call that does not answer whether the message waited (Retry) answers nothing, and the queue tells. */
  run?: (id: string) => Promise<Sent | void>
}

/**
 * Draws a message and makes the call that sends it. It makes the message's id, then in one render draws what main will confirm: the bubble and the Working line (so Stop and
 * "Add a follow up" too) when the message goes out now, or its row in the tray when a turn runs or something holds the chat. The row main saves has the same id and replaces the drawn
 * one in place. When main queues a message the window drew as a bubble (a race) the drawn row moves to the tray in one step, and the other way round. When the call fails the drawn
 * row, the queued message and the Working line all go, and `onFail` puts the text back. The Working line comes from this action, not a timer: main's `chat.running` takes over
 * from it, and only a failed call clears it. Resolves true when main took the message.
 */
async function place(chatId: string, parts: ChatPart[], o: Placed): Promise<boolean> {
  const id = newId()
  const to = destinationOf(chatId)
  const who = { ...(o.from ? { from: o.from } : {}), ...(o.update ? { update: o.update } : {}) }
  const row: ChatItem = { kind: 'user', id, ts: Date.now(), parts, ...who }
  const held: QueuedMessage = { id, chatId, parts, ts: row.ts, clientId: id, ...who }
  const wasRunning = !!getState().running[chatId]
  if (to.queued) actions.chats.draw(chatId, { queue: [...(getState().queue[chatId] ?? []), held], why: to.why })
  else actions.chats.draw(chatId, { item: row, running: true })
  try {
    const sent = (await (o.run ? o.run(id) : call('chats.send', { chatId, parts, clientId: id }))) || undefined
    const now = getState()
    const mainQueued = (now.queue[chatId] ?? []).find((q) => q.id === id && q !== held)
    const mainItem = (now.items[chatId] ?? []).find((i) => i.id === id && i !== row)
    // Main says it held the message when it answers queued, and also when it answers not queued with no row: a message sent now always comes back with its row
    // (`chats.send`), so none means main queued it under this id without starting a turn (an account move waits for a choice). Retry answers nothing, so the queue tells.
    const heldByMain = sent ? sent.queued || !sent.item : to.queued ? !mainItem : !!mainQueued
    if (!to.queued && heldByMain) {
      actions.chats.undraw(chatId, { item: row, running: wasRunning })
      actions.chats.draw(chatId, { queue: [...(now.queue[chatId] ?? []).filter((q) => q.id !== id), mainQueued ?? held], why: sent?.why })
    } else if (to.queued && !heldByMain) {
      actions.chats.undraw(chatId, { queued: id })
      actions.chats.draw(chatId, { item: sent?.item ?? mainItem ?? row, running: true })
    } else if (sent?.item) actions.chats.draw(chatId, { item: sent.item })
    return true
  } catch (e) {
    actions.chats.undraw(chatId, to.queued ? { queued: id } : { item: row, running: wasRunning })
    if (o.onFail) o.onFail(e)
    else actions.ui.toast({ title: 'Could not send', sub: cleanError(e) })
    return false
  }
}

/** The one way the window sends a message to a chat (KERNEL-895): the composer, a suggestion, Ask to fix and a command from the / menu all come here. */
export const sendMessage = (chatId: string, parts: ChatPart[], o: SendOptions = {}): Promise<boolean> => place(chatId, parts, o)

/**
 * Sends a message into the running turn (steer). It is drawn like any message sent while a turn runs: a row in the tray, which main's answer replaces with the message's
 * row, marked as steered. When the turn has ended, or the chat can't steer, main sends it as a next message and the answer says so. Resolves true when main took it.
 */
export const steerMessage = (chatId: string, parts: ChatPart[], o: SendOptions = {}): Promise<boolean> =>
  place(chatId, parts, { ...o, run: (id) => call('chats.steer', { chatId, parts, clientId: id }) })

/** Steer now on a queued message: main takes it out of the tray and puts it into the running turn. Its row and the tray arrive as events, and the answer is the tray as it stands. */
export async function steerQueued(chatId: string, q: QueuedMessage): Promise<void> {
  const r = await call('chats.steer', { chatId, id: q.id, clientId: q.id })
  actions.chats.setQueue(chatId, r.queue)
}

/**
 * Retry on a failed turn sends the user's message again, as a copy that keeps its sender. The copy is drawn like any send. When the message is gone from the chat
 * nothing is drawn, and main says why.
 */
export function retryMessage(chatId: string, itemId: string): Promise<boolean> {
  const items = getState().items[chatId] ?? []
  const at = items.findIndex((i) => i.id === itemId)
  const user = at < 0 ? undefined : items.slice(0, at + 1).reverse().find(isSentItem)
  const onFail = (e: unknown) => actions.ui.toast({ title: 'Could not retry', sub: cleanError(e) })
  const run = (id?: string) => call('chats.retry', { chatId, itemId, ...(id ? { clientId: id } : {}) }).then(() => undefined)
  if (!user) return run().then(() => true, (e) => { onFail(e); return false })
  return place(chatId, user.parts, { from: user.from, update: user.update, run, onFail })
}

/**
 * Send now on a queued message: the row leaves the tray and its bubble appears with the Working line in the same render, under the id it already has, which main keeps
 * for the row it saves. A brief held for a merge goes with the whole first turn, so its row stays until main moves it. Throws when the call fails, after putting the row back.
 */
export async function sendQueuedNow(chatId: string, q: QueuedMessage): Promise<void> {
  const s = getState()
  const draws = s.queueWhy[chatId] !== 'merge'
  const row: ChatItem = { kind: 'user', id: q.id, ts: Date.now(), parts: q.parts, ...(q.from ? { from: q.from } : {}), ...(q.update ? { update: q.update } : {}) }
  const wasRunning = !!s.running[chatId]
  if (draws) actions.chats.draw(chatId, { item: row, queue: (s.queue[chatId] ?? []).filter((x) => x.id !== q.id), running: true })
  try { actions.chats.setQueue(chatId, await call('chats.sendNow', { chatId, id: q.id, clientId: q.id })) }
  catch (e) {
    if (draws) {
      actions.chats.undraw(chatId, { item: row, running: wasRunning })
      actions.chats.draw(chatId, { queue: [...(getState().queue[chatId] ?? []).filter((x) => x.id !== q.id), q].sort((a, b) => a.ts - b.ts) })
    }
    throw e
  }
}

const sent = new Map<string, number>()

/**
 * When the window sent a message New chat started, by its id. The engine stamps the row when the turn starts, after the worktree is made, so the
 * working line counts from the press instead and doesn't go back to 0s as the chat opens. A reload forgets it, and the row's own time counts.
 */
export function markSent(id: string, at = Date.now()): void { if (!sent.has(id)) sent.set(id, at) }
export const sentAt = (id: string): number | undefined => sent.get(id)

/**
 * A chat New chat just started has its first message in the tray while its worktree is made, or as a row with the turn running. The chat opens with that already drawn, under
 * the id the start was given, so main's row or queued message replaces it in place. Nothing is drawn when the chat already holds the message.
 */
export function drawStarted(chatId: string, id: string, parts: ChatPart[]): void {
  markSent(id)
  const s = getState()
  if ((s.items[chatId] ?? []).some((i) => i.id === id) || (s.queue[chatId] ?? []).some((q) => q.id === id)) return
  const ws = Object.values(s.chats).flat().find((c) => c.id === chatId)?.workspaceId
  const making = ws ? s.workspaces.find((w) => w.id === ws)?.worktreePending : undefined
  const ts = sentAt(id) ?? Date.now()
  if (making || s.running[chatId] || !s.system.online) actions.chats.draw(chatId, { queue: [...(s.queue[chatId] ?? []), { id, chatId, parts, ts, clientId: id }], why: making ? 'worktree' : s.system.online ? undefined : 'offline' })
  else actions.chats.draw(chatId, { item: { kind: 'user', id, ts, parts }, running: true })
}
