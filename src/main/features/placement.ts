import { MODELS, type Chat, type ChatItem, type ColdReason, type LastTurn, type MoveChoice, type MovePreview, type MovePreviewChat, type Provider } from '@shared/types'
import { chatProvider } from '@shared/providers'
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
 * Where a chat's cache is and what moving it costs (KERNEL-841). This first step reads the facts: each chat's last turn, why
 * a move would read it again, what that reads and costs, the account pairs that share a cache, the note after a move, and
 * what a switch would move. It moves nothing.
 */
export class Placement extends Feature {
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

  /** Keeps what the user picked for a long chat a switch would move. A later step acts on it (KERNEL-841). */
  moveChoice(chatId: string, choice: MoveChoice): Chat {
    return this.saveChat({ ...this.mustChat(chatId), moveChoice: { choice, at: Date.now() } })
  }

  handlers() {
    return {
      'accounts.previewSwitch': async ({ provider, accountId }) => this.previewSwitch(provider, accountId),
      'chats.moveChoice': async ({ chatId, choice }) => this.moveChoice(chatId, choice)
    } satisfies Partial<Handlers>
  }
}
