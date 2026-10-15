import { MODELS, PROVIDERS, type Chat, type MoveChoice, type MovePreview, type Provider } from '@shared/types'
import { chatProvider } from '@shared/providers'
import type { Handlers } from '../kernel'
import type { MovePlan } from '../services/sessions'
import { Feature } from './feature'

/** The size of a long chat when Settings, Account has none. */
const LONG_CHAT = 50_000

/** Why Kernel switched a provider by itself: the account in use hit its limit, or crossed the move threshold ahead of it. */
export type SelfSwitch = 'limit' | 'near'

// 142000 reads as 142k.
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** "A", "A and B", "A, B and C". */
const joined = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/**
 * What a long chat does when it has to run on another account (KERNEL-844): Settings, Account's "When a long chat moves to
 * another account" for its provider, the chat's own choice, and the overrides. Sessions asks as each turn starts
 * (`plan`), so a move is decided once, where it happens. A chat that waits for the user's choice gets one Inbox item per
 * room. A switch Kernel makes by itself posts one grouped item, and ahead of a limit the old account summarizes its idle
 * long chats while their cache is warm.
 */
export class Moves extends Feature {
  /** Chats waiting for the user to choose how they move, by room, for the room's Inbox item. */
  private asking = new Map<string, Set<string>>()
  /** Accounts whose idle long chats are being summarized ahead of a limit, as `provider:account`, so one run goes at a time. */
  private ahead = new Set<string>()

  /** Settings, Account "Long chat": a chat at or above this many tokens follows the move policy. */
  private long(): number { return this.settings?.accounts?.longChatTokens ?? LONG_CHAT }

  /** Settings, Account "When a long chat moves to another account" for `provider`, Summarize first by default. */
  private policy(provider: Provider) { return this.settings?.accounts?.longChatMove?.[provider] ?? 'summarize' }

  private label(provider: Provider, account: string) { return this.k.providers.label(provider, account) }

  /**
   * What the chat's next turn does about moving from the account it last ran on to `to` (Sessions' `movePlan`). A chat
   * that doesn't fit the target model's window is always summarized. Otherwise the chat's own choice goes first, used up by
   * this move. A chat under Settings, Account's "Long chat" size continues. A move onto an API key account asks, since the
   * key pays for every token. Then the provider's policy: summarize first, continue, or ask. A summary runs on the old
   * account while it can still run the chat and the cache there is warm, so the summary reads from the cache. Otherwise it
   * runs on the new account, which reads the chat once to write the summary.
   */
  plan(chat: Chat, to: string): MovePlan | undefined {
    const from = chat.ranOn
    if (!from) return undefined
    const provider = chatProvider(chat)
    const choice = chat.moveChoice?.choice
    // Keep only reaches here once the old account can't run the chat, so it no longer holds.
    if (choice) this.saveChat({ ...this.mustChat(chat.id), moveChoice: undefined })
    const cost = this.k.placement.moveCost(chat, { account: to })
    if (!cost.fits) return this.summarize(chat, from, to, `This chat doesn't fit ${this.modelName(chat)}'s context window on ${this.label(provider, to)}`)
    if (choice === 'summarize') return this.summarize(chat, from, to)
    if (choice === 'continue' || cost.tokens < this.long()) return { do: 'continue' }
    if (this.k.providers.auth(provider, to) === 'apiKey') return { do: 'ask' }
    const policy = this.policy(provider)
    return policy === 'ask' ? { do: 'ask' } : policy === 'continue' ? { do: 'continue' } : this.summarize(chat, from, to)
  }

  private modelName(chat: Chat) { return MODELS.find((m) => m.id === chat.model.replace(/\[[^\]]*\]$/, ''))?.label ?? chat.model }

  /** Summarize first: on the old account when it can run the chat and the cache there is warm, else on the new one. */
  private summarize(chat: Chat, from: string, to: string, why?: string): MovePlan {
    const provider = chatProvider(chat)
    const old = this.k.placement.canRun(provider, from, chat.model) && !this.k.placement.coldReason(chat, { account: from })
    const where = old
      ? `on ${this.label(provider, from)} before it moves to ${this.label(provider, to)}, so the move reads the summary rather than the whole chat`
      : `as it moves to ${this.label(provider, to)}, so later turns there read the summary rather than the whole chat`
    return { do: 'summarize', on: old ? from : to, note: `${why ? `${why}, so ` : ''}Kernel is summarizing this chat ${where}.` }
  }

  /**
   * A chat started or stopped waiting for the user to choose how it moves (Sessions' `onMoveHold`). Its room's Inbox item
   * lists the chats that wait, and once none does, says so and needs nothing more.
   */
  held(chat: Chat, held: boolean) {
    const ws = this.store.workspace(chat.workspaceId)
    if (!ws) return
    const ids = this.asking.get(ws.roomId) ?? new Set<string>()
    if (held === ids.has(chat.id)) return
    if (held) ids.add(chat.id)
    else ids.delete(chat.id)
    this.asking.set(ws.roomId, ids)
    this.askItem(ws.roomId, [...ids])
  }

  private askItem(roomId: string, ids: string[]) {
    const id = `n-move-ask-${roomId}`
    const room = this.store.room(roomId)
    const sub = `Account move${room ? ` · ${room.name}` : ''}`
    if (!ids.length) {
      this.asking.delete(roomId)
      if (this.store.notification(id)?.needsYou) this.notifications.notice({ id, title: 'No chat waits to move to another account', sub, needsYou: false, resolved: 'Every chat has its answer.' }, { replace: true })
      return
    }
    const chats = ids.flatMap((c) => this.store.chat(c) ?? [])
    const lines = chats.map((c) => {
      const provider = chatProvider(c)
      const to = this.k.placement.accountFor(provider, c) ?? 'cli'
      const cost = this.k.placement.moveCost(c, { account: to })
      return `${c.title}: ${kTokens(cost.tokens)} tokens to ${this.label(provider, to)}${cost.price !== undefined ? `, about $${cost.price.toFixed(2)} on its API key` : ''}`
    })
    const title = chats.length === 1 ? `${chats[0].title} waits to move to another account` : `${chats.length} long chats wait to move to another account`
    const only = chats.length === 1 ? chats[0] : undefined
    this.notifications.notice({
      id, title, sub, roomId, ...(only ? { workspaceId: only.workspaceId } : {}), needsYou: true, heading: title,
      body: `Kernel asks before these chats run on another account. ${lines.join('. ')}. In each chat, pick summarize it first, continue as it is, or keep it on its account.`
    }, { replace: true })
  }

  /**
   * `chats.moveChoice`: the user picked how a long chat moves. It is kept on the chat, and a chat that waited for it goes on
   * with it (KERNEL-844).
   */
  choose(chatId: string, choice: MoveChoice): Chat {
    const chat = this.k.placement.moveChoice(chatId, choice)
    this.sessions.releaseMove(chatId)
    return this.store.chat(chatId) ?? chat
  }

  /**
   * Kernel switches `provider` to `to` by itself (`Account`): its account in use hit its limit, or crossed the move
   * threshold ahead of it. New chats start on `to`, and each chat moves at its next turn by the policy. One Inbox item says
   * what the switch moves.
   */
  async switchBySelf(provider: Provider, to: string, why: SelfSwitch): Promise<void> {
    const preview = this.k.placement.previewSwitch(provider, to)
    await this.k.providers.switchTo(provider, to, { reason: 'limit' })
    this.announce(preview, why)
  }

  private announce(p: MovePreview, why: SelfSwitch) {
    const provider = PROVIDERS.find((x) => x.id === p.provider)?.label ?? p.provider
    const from = this.label(p.provider, p.from)
    const to = this.label(p.provider, p.to)
    const reason = why === 'near' ? `${from} is close to its usage limit` : `${from} hit its usage limit`
    const title = `Kernel switched ${provider} to ${to}`
    const policy = this.policy(p.provider)
    const how = policy === 'continue' ? 'each reads its whole history again there' : policy === 'ask' ? 'each waits for you to choose how it moves' : 'Kernel summarizes each one first'
    const chats = p.chats.map((c) => `${c.title} (${kTokens(c.tokens)} tokens)`)
    const moves = !chats.length ? 'No long chat moves.'
      : `${chats.length === 1 ? 'One long chat moves' : `${chats.length} long chats move`} at ${chats.length === 1 ? 'its' : 'their'} next turn, and ${how}: ${joined(chats)}.`
    this.notifications.notice({ id: `n-auto-switch-${p.provider}-${Date.now()}`, title, sub: reason, heading: title, body: `${reason}, so new chats start on ${to}. ${moves}` })
  }

  /**
   * Ahead of a limit (KERNEL-844): `from` crossed the move threshold and Kernel switched away from it, so its long chats move
   * at their next turn. While Settings, Account summarizes long chats first, each idle one whose cache on `from` is still warm
   * is summarized there now, one at a time, largest first, so its move reads the summary. A chat that runs, waits for
   * something, or belongs to the Lead is left alone, and so is everything once `from` can't run the chat.
   */
  async compactAhead(provider: Provider, from: string): Promise<void> {
    const key = `${provider}:${from}`
    if (this.policy(provider) !== 'summarize' || this.ahead.has(key)) return
    this.ahead.add(key)
    try {
      for (const id of this.longChatsOn(provider, from)) {
        const chat = this.store.chat(id)
        if (this.stopped || !chat || chat.closed || chat.ranOn !== from || this.k.placement.coldReason(chat, { account: from })) continue
        if (!this.k.placement.canRun(provider, from, chat.model)) continue
        await this.sessions.compactIdle(id, from)
      }
    } finally {
      this.ahead.delete(key)
    }
  }

  /** The provider's open long chats that last ran on `account`, the Lead's left out, largest first. */
  private longChatsOn(provider: Provider, account: string): string[] {
    const found: { id: string; tokens: number }[] = []
    for (const ws of this.store.workspaces()) {
      if (ws.status === 'archived' || this.isLeadWorkspace(ws)) continue
      for (const chat of this.store.chats(ws.id)) {
        if (chat.kind !== 'chat' || chat.closed || chatProvider(chat) !== provider || chat.ranOn !== account) continue
        const tokens = this.k.placement.size(chat).tokens
        if (tokens >= this.long()) found.push({ id: chat.id, tokens })
      }
    }
    return found.sort((a, b) => b.tokens - a.tokens).map((c) => c.id)
  }

  handlers() {
    return {
      'chats.moveChoice': async ({ chatId, choice }) => this.choose(chatId, choice)
    } satisfies Partial<Handlers>
  }
}
