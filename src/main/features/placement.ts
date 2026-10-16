import { MODELS, type Chat, type ChatItem, type ColdReason, type LastTurn, type MoveChoice, type MoveNotice, type MovePreview, type MovePreviewChat, type Provider, type RateLimit } from '@shared/types'
import { chatProvider, limitProvider } from '@shared/providers'
import { nearLimit } from '@shared/usage'
import { blockingLimit, limitedModels } from '../services/health'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/**
 * How long a provider keeps a chat's prompt cache after its last call (KERNEL-842). Claude Code on a Claude plan caches for an
 * hour, on an API key for 5 minutes. OpenAI keeps a cached prefix for 5 to 10 minutes of inactivity, so Codex counts 5.
 */
const CACHE_LIFETIME_MS = { claudePlan: 60 * 60_000, short: 5 * 60_000 }

/** Writing input to the cache costs 1.25 times the model's input price, which is what a move onto an API key pays (KERNEL-842). */
const CACHE_WRITE = 1.25

/** Characters per token, for a size guessed from a transcript. */
const CHARS_PER_TOKEN = 4

/** The notes both runners write when a conversation is compacted (KERNEL-808). What comes before one is no longer in the chat. */
const COMPACTED = /^(Compacted the conversation|Context was full, so the conversation was compacted)/

/** The id the CLI's own login goes by in `accounts.*`, as `CLI_ACCOUNT` in features/providers.ts. */
const CLI_ACCOUNT = 'cli'

/** The meta key that holds the account pairs proven to share a prompt cache, as `provider:a|b` with `a` before `b`. */
const SHARED_KEY = 'sharedCaches'

/**
 * The meta key that holds the chats a Move all switch placed on its account before they ran a turn there, by chat id
 * (KERNEL-843). A chat's entry goes once a turn starts on any account.
 */
const PLACED_KEY = 'placedChats'

/** An account a chat could run on next: its id in `accounts.*` (`cli` for the CLI's own login), and the model, the chat's by default. */
export interface Target { account: string; email?: string; model?: string }

/** What moving a chat to a target reads (KERNEL-842). `price` is in US dollars, only for a Claude API key target. */
export interface MoveCost { tokens: number; estimated?: true; window?: number; fits: boolean; price?: number }

// 142000 reads as 142k.
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** A model id without its context-window tag (`[1m]`). */
const bareModel = (id: string) => id.replace(/\[[^\]]*\]$/, '')

/** How many characters a transcript row put in the chat's context, roughly. */
function itemChars(item: ChatItem): number {
  switch (item.kind) {
    case 'user': return item.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : p.type === 'file' ? (p.text?.length ?? p.name.length) : p.name.length), 0)
    case 'text': case 'thinking': return item.text.length
    case 'tool': return item.label.length + item.detail.length + (item.input ? JSON.stringify(item.input).length : 0) + (item.output?.length ?? 0)
    default: return 0
  }
}

/**
 * Where a chat's cache is and what moving it costs (KERNEL-841): each chat's last turn, why a move would read it again, what
 * that reads and costs, the account pairs that share a cache, the note after a move, and what a switch would move. With
 * `accounts.keepChatsOnAccount` on, a chat runs on the account that holds its cache until that account can't take it
 * (`accountFor`, KERNEL-843).
 */
export class Placement extends Feature {
  /**
   * The account the chat's next turn runs on, undefined for the CLI's own login, as Sessions' `accountFor` (KERNEL-843). With
   * `accounts.keepChatsOnAccount` on, a chat stays on the account it last ran on, or the one a Move all switch placed it on,
   * while that account is still in Kernel, signed in, has no rejected window or limit on the chat's model, and is below the
   * move threshold (`nearLimit`: 5 hour 90%, weekly 95%). A chat the user chose to keep where it is stays on the account it
   * last ran on, past a Move all switch and the threshold, while that account can still run it (KERNEL-844). A new chat, a chat whose account fails one of those, and every chat with
   * the setting off run on the provider's account in use.
   */
  accountFor(provider: Provider, chat?: Chat, limits?: RateLimit[], now = Date.now()): string | undefined {
    const active = this.k.providers.active(provider)
    const kept = chat?.moveChoice?.choice === 'keep' && !!chat.ranOn
    const home = chat && this.keeps() ? (kept ? chat.ranOn : this.placed()[chat.id] ?? chat.ranOn) : undefined
    if (!chat || !home || home === (active ?? CLI_ACCOUNT)) return active
    const windows = limits ?? this.store.meta<RateLimit[]>('limits') ?? []
    return this.canHold(provider, home, chat.model, windows, now, { threshold: !kept }) ? (home === CLI_ACCOUNT ? undefined : home) : active
  }

  /** Chats keep the account that holds their cache: Settings, Account "Keep chats on their account", on by default. */
  keeps(): boolean { return this.settings?.accounts?.keepChatsOnAccount ?? true }

  /**
   * The account can still run a chat on `model`: in Kernel, signed in, no limit on it or the model, and below the move
   * threshold unless `threshold` is false.
   */
  private canHold(provider: Provider, account: string, model: string, limits: RateLimit[], now: number, o: { threshold?: boolean } = {}): boolean {
    if (!this.k.providers.has(provider, account) || !this.k.providers.signedInNow(provider, account)) return false
    const id = account === CLI_ACCOUNT ? undefined : account
    const mine = limits.filter((l) => limitProvider(l) === provider && l.accountId === id)
    return !blockingLimit(mine, now) && !(limitedModels(mine, now) as string[]).includes(model) && (o.threshold === false || !nearLimit(mine, now))
  }

  /** The account can still run a chat on `model` now, near its limit or not: what summarizing there before a move needs (KERNEL-844). */
  canRun(provider: Provider, account: string, model: string, now = Date.now()): boolean {
    return this.canHold(provider, account, model, this.store.meta<RateLimit[]>('limits') ?? [], now, { threshold: false })
  }

  /**
   * The chat's size in tokens when its next turn re-reads its history cold because it runs on another account or model, else
   * undefined: a chat that never ran, a warm one, and one only idle past the cache's lifetime, which would re-read wherever it
   * ran (KERNEL-844). Sessions starts such turns two at a time.
   */
  coldSize(chat: Chat, now = Date.now()): number | undefined {
    if (!chat.ranOn) return undefined
    const to = this.accountFor(chatProvider(chat), chat, undefined, now) ?? CLI_ACCOUNT
    const why = this.coldReason(chat, { account: to }, now)
    return why === 'account' || why === 'model' ? this.size(chat).tokens : undefined
  }

  private placed(): Record<string, string> { return this.store.meta<Record<string, string>>(PLACED_KEY) ?? {} }

  /**
   * A Move all switch of `provider` to `to` (KERNEL-843): each open chat of the provider that last ran on another account runs
   * its next turn on `to`. Chats placed before on another account are placed again.
   */
  placeAll(provider: Provider, to: string) {
    const placed = this.placed()
    for (const ws of this.store.workspaces()) {
      if (ws.status === 'archived') continue
      for (const chat of this.store.chats(ws.id)) {
        if (chat.kind !== 'chat' || chatProvider(chat) !== provider) continue
        if (chat.ranOn && chat.ranOn !== to) placed[chat.id] = to
        else delete placed[chat.id]
      }
    }
    this.store.saveMeta(PLACED_KEY, placed)
  }

  /**
   * A turn of the chat starts on some account, so a placement from a Move all switch has done its job (Sessions' `startedOn`).
   * So has a choice to summarize or continue: the move it was for either happened as the turn started or never came
   * (KERNEL-844). Keep stays while the account can run the chat.
   */
  startedOn(chatId: string) {
    const chat = this.store.chat(chatId)
    if (chat?.moveChoice && chat.moveChoice.choice !== 'keep') this.saveChat({ ...chat, moveChoice: undefined })
    const placed = this.placed()
    if (!(chatId in placed)) return
    delete placed[chatId]
    this.store.saveMeta(PLACED_KEY, placed)
  }

  /**
   * How many of the provider's open chats run their next turn on each account, by id, `cli` for the CLI's own login
   * (`AccountProfile.chats`, KERNEL-843). Chats that never ran a turn and weren't placed are left out.
   */
  chatsPerAccount(provider: Provider, now = Date.now()): Map<string, number> {
    const counts = new Map<string, number>()
    const placed = this.placed()
    const limits = this.store.meta<RateLimit[]>('limits') ?? []
    for (const ws of this.store.workspaces()) {
      if (ws.status === 'archived') continue
      for (const chat of this.store.chats(ws.id)) {
        if (chat.kind !== 'chat' || chat.closed || chatProvider(chat) !== provider || !(placed[chat.id] ?? chat.ranOn)) continue
        const on = this.accountFor(provider, chat, limits, now) ?? CLI_ACCOUNT
        counts.set(on, (counts.get(on) ?? 0) + 1)
      }
    }
    return counts
  }

  /**
   * The chat's size in tokens: its last turn's, else /context's, else a guess from its transcript since the last compaction,
   * saved as an estimated `lastTurn` so the guess is made once. A chat that never ran a turn is 0.
   */
  size(chat: Chat): { tokens: number; estimated?: true } {
    if (chat.lastTurn) return { tokens: chat.lastTurn.context, ...(chat.lastTurn.estimated ? { estimated: true as const } : {}) }
    if (chat.contextUsage?.used) return { tokens: chat.contextUsage.used }
    const turn = this.estimate(chat)
    return turn ? { tokens: turn.context, estimated: true } : { tokens: 0 }
  }

  /** The chat's last turn, an estimated one for a chat from before KERNEL-842 that ran on some account. */
  private turnOf(chat: Chat): LastTurn | undefined { return chat.lastTurn ?? this.estimate(chat) }

  private estimate(chat: Chat): LastTurn | undefined {
    if (!chat.ranOn) return undefined
    const items = this.store.items(chat.id)
    let cut = items.length - 1
    while (cut >= 0 && !(items[cut].kind === 'note' && COMPACTED.test((items[cut] as ChatItem & { kind: 'note' }).text))) cut--
    const since = items.slice(cut + 1)
    const chars = since.reduce((n, i) => n + itemChars(i), 0)
    const lastTurn: LastTurn = { at: since.at(-1)?.ts ?? items.at(-1)?.ts ?? chat.createdAt, account: chat.ranOn, model: chat.model, context: Math.round(chars / CHARS_PER_TOKEN), input: 0, cacheRead: 0, cacheWrite: 0, estimated: true }
    // Read again just before the write, so nothing saved meanwhile is lost.
    const fresh = this.store.chat(chat.id)
    if (fresh && !fresh.lastTurn) this.store.saveChat({ ...fresh, lastTurn })
    return lastTurn
  }

  /**
   * Why the chat's next turn on `target` would read its whole history again, or undefined when the cache would serve it:
   * another account (one in a pair proven to share a cache counts as the same), the same account signed in to another
   * email, another model, or the provider's cache lifetime gone by since the last turn. A chat that never ran has none.
   */
  coldReason(chat: Chat, target: Target, now = Date.now()): ColdReason | undefined {
    const provider = chatProvider(chat)
    const turn = this.turnOf(chat)
    const from = turn?.account ?? chat.ranOn
    if (!turn || !from) return undefined
    if (from !== target.account && !this.shares(provider, from, target.account)) return 'account'
    const email = target.email ?? this.k.providers.emailOf(provider, target.account)
    if (from === target.account && turn.email && email && turn.email.toLowerCase() !== email.toLowerCase()) return 'account'
    if (turn.model !== (target.model ?? chat.model)) return 'model'
    if (now - turn.at > this.lifetime(provider, from)) return 'idle'
    return undefined
  }

  /**
   * What reading the chat once on `target` takes: its size, whether that fits the target model's window (a window Kernel
   * doesn't know fits), and on a Claude API key account the price of writing it to the cache. Codex says tokens only.
   */
  moveCost(chat: Chat, target: Target): MoveCost {
    const provider = chatProvider(chat)
    const size = this.size(chat)
    const model = target.model ?? chat.model
    const window = this.window(chat, model)
    const info = provider === 'claude' ? MODELS.find((m) => m.id === bareModel(model)) : undefined
    const onKey = provider === 'claude' && this.k.providers.auth(provider, target.account) === 'apiKey'
    const price = onKey && info ? Math.round((size.tokens / 1_000_000) * info.inputPrice * CACHE_WRITE * 100) / 100 : undefined
    return { ...size, ...(window ? { window } : {}), fits: !window || size.tokens <= window, ...(price !== undefined ? { price } : {}) }
  }

  /** A model's context window: Claude's from MODELS, a `[1m]` tag a million, else the window /context last gave on the chat's own model. */
  private window(chat: Chat, model: string): number | undefined {
    if (chatProvider(chat) === 'claude') {
      if (/\[1m\]$/i.test(model)) return 1_000_000
      const known = MODELS.find((m) => m.id === bareModel(model))?.window
      if (known) return known
    }
    return model === chat.model ? chat.contextUsage?.max : undefined
  }

  /** How long the account's cache lasts on the provider: an hour on a Claude plan, 5 minutes on a Claude API key or Codex. */
  private lifetime(provider: Provider, account: string): number {
    return provider === 'claude' && this.k.providers.auth(provider, account) !== 'apiKey' ? CACHE_LIFETIME_MS.claudePlan : CACHE_LIFETIME_MS.short
  }

  private pairKey(provider: Provider, a: string, b: string) { return `${provider}:${[a, b].sort().join('|')}` }

  /** The two accounts were seen to share a prompt cache: a chat moved between them and its first call read most of it. */
  shares(provider: Provider, a: string, b: string): boolean {
    return a === b || (this.store.meta<string[]>(SHARED_KEY) ?? []).includes(this.pairKey(provider, a, b))
  }

  private saveShared(provider: Provider, a: string, b: string) {
    const pairs = this.store.meta<string[]>(SHARED_KEY) ?? []
    const key = this.pairKey(provider, a, b)
    if (!pairs.includes(key)) this.store.saveMeta(SHARED_KEY, [...pairs, key])
  }

  /**
   * The note after the chat's first turn on another account than `from` (Sessions' `moveNote`): "Moved to Personal and
   * re-read 310k tokens", from the turn's first model call, and why when a limit moved it. A turn whose first call read more
   * than half the chat from the cache proves the two accounts share one, which Kernel keeps. A turn with no numbers says
   * where it moved only.
   */
  moved(chat: Chat, from: string): string {
    const provider = chatProvider(chat)
    const to = chat.ranOn ?? CLI_ACCOUNT
    const turn = chat.lastTurn && !chat.lastTurn.estimated && chat.lastTurn.account === to ? chat.lastTurn : undefined
    const first = turn?.first ?? turn
    const warm = !!turn && !!first && first.cacheRead > turn.context / 2
    if (warm) this.saveShared(provider, from, to)
    const read = !first ? '' : warm ? ' and read this chat from the cache' : ` and re-read ${kTokens(first.input + first.cacheWrite)} tokens`
    const why = this.k.providers.switchReason(provider, to)
    return `Moved to ${this.k.providers.label(provider, to)}${read}${why ? ` (${why})` : ''}`
  }

  /**
   * What a switch of `provider` to `to` would move, read only: the provider's open chats whose last turn ran on the account
   * in use now, at or above `accounts.longChatTokens`, largest first.
   */
  previewSwitch(provider: Provider, to: string, now = Date.now()): MovePreview {
    const from = this.k.providers.active(provider) ?? CLI_ACCOUNT
    const long = this.settings?.accounts?.longChatTokens ?? 50_000
    const chats: MovePreviewChat[] = []
    for (const ws of this.store.workspaces()) {
      if (ws.status === 'archived') continue
      for (const chat of this.store.chats(ws.id)) {
        if (chat.kind !== 'chat' || chat.closed || chatProvider(chat) !== provider || (chat.ranOn ?? chat.lastTurn?.account) !== from) continue
        const cost = this.moveCost(chat, { account: to })
        if (cost.tokens < long) continue
        const cold = this.coldReason(this.store.chat(chat.id) ?? chat, { account: to }, now)
        chats.push({
          chatId: chat.id, title: chat.title, workspaceId: ws.id, workspace: ws.name, provider, from, to, tokens: cost.tokens,
          ...(cost.estimated ? { estimated: true as const } : {}), running: this.sessions.isRunning(chat.id), ...(cold ? { coldReason: cold } : {}),
          fits: cost.fits, ...(cost.price !== undefined ? { price: cost.price } : {})
        })
      }
    }
    return { provider, from, to, chats: chats.sort((a, b) => b.tokens - a.tokens) }
  }

  /**
   * What the chat's next turn re-reads and why, for the notice above the composer (KERNEL-841), read only. Only a chat that
   * waits for the user to choose how it moves has one (KERNEL-941): every other move follows the policy without asking, so
   * there is nothing to say before it. Nothing either for a chat under the Long chat size, one that never ran, one the user
   * chose Summarize or Continue for, or a warm one.
   */
  moveNotice(chatId: string, now = Date.now()): MoveNotice | null {
    const chat = this.store.chat(chatId)
    if (!chat || chat.kind !== 'chat' || !this.sessions.heldForMove(chatId)) return null
    // Summarize and Continue are answers to this move. Keep is one only while the kept account can run the chat, which `accountFor` checks.
    if (chat.moveChoice && chat.moveChoice.choice !== 'keep') return null
    const provider = chatProvider(chat)
    const from = chat.ranOn ?? chat.lastTurn?.account
    if (!from) return null
    const to = this.accountFor(provider, chat, undefined, now) ?? CLI_ACCOUNT
    // The hold decided the chat moves, so the notice shows even when Kernel can't say why its cache is cold.
    const reason = this.coldReason(chat, { account: to }, now) ?? (from !== to ? 'account' : undefined)
    if (!reason) return null
    const cost = this.moveCost(chat, { account: to })
    const model = reason === 'model' ? MODELS.find((m) => m.id === bareModel(chat.model))?.label ?? chat.model : undefined
    return {
      kind: 'move', reason, from, to, ...(model ? { model } : {}), tokens: cost.tokens,
      ...(cost.estimated ? { estimated: true as const } : {}), ...(cost.price !== undefined ? { price: cost.price } : {}),
      keep: reason === 'account' && from !== to && this.canRun(provider, from, chat.model, now)
    }
  }

  /**
   * Keeps what the user picked for a long chat that moves to another account, which its next turn acts on (`Moves.plan`,
   * KERNEL-844). Keep holds it where it is while that account can run it.
   */
  moveChoice(chatId: string, choice: MoveChoice): Chat {
    return this.saveChat({ ...this.mustChat(chatId), moveChoice: { choice, at: Date.now() } })
  }

  handlers() {
    return {
      'chats.moveNotice': async ({ chatId }) => this.moveNotice(chatId)
    } satisfies Partial<Handlers>
  }
}
